/**
 * ORCA hub sobre Cloudflare Workers — ESQUELETO, no implementado.
 *
 * Este archivo es a propósito todo comentarios: no se compila nada real hasta
 * que se instalen `@cloudflare/workers-types` y `wrangler`, y hasta entonces
 * `tsc --noEmit` del proyecto tiene que seguir en verde.
 *
 * ── La idea ──────────────────────────────────────────────────────────
 *
 * El hub es, por diseño, un único punto de verdad con estado en memoria y
 * conexiones WebSocket de larga vida. Eso es exactamente un Durable Object.
 *
 *   Worker (fetch)                    Durable Object "HubDO" (una instancia)
 *   ─────────────────                 ──────────────────────────────────────
 *   /ws/collector ─┐                  world.ts   ← se reusa TAL CUAL
 *   /ws/console  ──┼── idFromName ──▶ bus.ts     ← se reusa TAL CUAL
 *   /api/health  ──┘   ("orca")       storage    ← reemplaza a persist.ts
 *   /api/world
 *
 * Todo el tráfico va al MISMO objeto (`idFromName('orca')`): la flota es una,
 * el mundo es uno. Si algún día hay varios dueños, la clave del DO pasa a ser
 * el id del dueño y nada más cambia.
 *
 * ── Qué se reusa sin tocar ───────────────────────────────────────────
 *
 *   world.ts   No usa nada de Node. Puro TypeScript sobre objetos. Se importa
 *              igual. Es el motivo por el que la lógica vive ahí y no en
 *              server.ts.
 *   bus.ts     Ídem: `setTimeout` existe en Workers. El coalescing a 10 Hz
 *              funciona igual, y ahí importa más todavía porque cada mensaje
 *              enviado a un socket hibernado cuesta.
 *   protocol/types  Compartidos, sin cambios.
 *
 * ── Qué hay que cambiar ──────────────────────────────────────────────
 *
 * 1. TRANSPORTE. `ws` no existe en Workers. En su lugar:
 *
 *      const pair = new WebSocketPair();
 *      const [client, server] = Object.values(pair);
 *      this.ctx.acceptWebSocket(server, [role, machineId]);   // hibernation
 *      return new Response(null, { status: 101, webSocket: client });
 *
 *    `acceptWebSocket` con tags es la clave: el DO puede ser evacuado de
 *    memoria mientras los sockets siguen abiertos, y se rehidrata cuando llega
 *    un mensaje. Los tags sustituyen a los `Map`/`Set` de server.ts:
 *
 *      this.ctx.getWebSockets('console')            // todas las consolas
 *      this.ctx.getWebSockets(`machine:${id}`)      // el collector de esa máquina
 *
 *    Y los handlers dejan de ser `ws.on('message')` para ser métodos:
 *
 *      async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer)
 *      async webSocketClose(ws: WebSocket, code: number, reason: string)
 *      async webSocketError(ws: WebSocket, err: unknown)
 *
 * 2. ESTADO TRAS HIBERNACIÓN. Al despertar, el `World` en memoria está vacío.
 *    Dos opciones, y hay que elegir a conciencia:
 *
 *      a) Rehidratar desde `ctx.storage` en el constructor con
 *         `ctx.blockConcurrencyWhile(async () => { ... })`. Guardar el mundo
 *         entero es caro; guardar sólo máquinas + escalaciones + CEO y pedir
 *         `{k:'resync'}` a cada collector al despertar es más barato y más
 *         correcto: el collector siempre sabe más que el hub.
 *      b) No rehidratar nada y pedir resync a todos. El mundo se reconstruye
 *         en un segundo. Recomendado para empezar.
 *
 *    Los metadatos por socket (machineId, si ya hizo hello) sobreviven a la
 *    hibernación con `ws.serializeAttachment({ role, machineId })` /
 *    `ws.deserializeAttachment()`. Eso reemplaza a las interfaces `Conn`.
 *
 * 3. PERSISTENCIA. persist.ts usa `node:fs` y no existe aquí.
 *      - conversación del CEO   → `ctx.storage.put('ceo:<ts>', msg)` con
 *                                 `list({ prefix, reverse, limit })` al arrancar.
 *      - escalaciones resueltas → `ctx.storage` o D1 si se quiere consultarlas.
 *      - memoria (memory.ts)    → la lógica de similitud se reusa; lo que cambia
 *                                 es de dónde se leen las entradas: KV o D1 en
 *                                 vez de memory.jsonl. `recall()` sigue siendo
 *                                 puro (normalize/tokenize/jaccard) — esa parte
 *                                 se puede extraer y compartir sin cambios.
 *      - log de eventos JSONL   → R2 (un objeto por día, append por lotes) o,
 *                                 más simple, Workers Analytics Engine.
 *
 * 4. TEMPORIZADORES. `setInterval` no sobrevive a la hibernación. El barrido de
 *    latidos (`world.sweep()`) pasa a ser una alarma:
 *
 *      await this.ctx.storage.setAlarm(Date.now() + 5_000);
 *      async alarm() { this.world.sweep(); if (hayMáquinas) reprograma; }
 *
 *    El ping/pong manual también se va: Cloudflare gestiona el keepalive de los
 *    sockets hibernados por su cuenta.
 *
 * 5. AUTH. auth.ts escribe ~/.orca/token con chmod 600; aquí el token es un
 *    secreto de Wrangler (`wrangler secret put ORCA_TOKEN`) leído de `env`. La
 *    concesión de "loopback sin token" DESAPARECE: en Workers no hay loopback,
 *    toda conexión es remota y todas deben traer token. Mejor todavía, poner
 *    Cloudflare Access delante de /ws/console y dejar el token sólo para los
 *    collectors.
 *
 * 6. HTTP. `/api/health` y `/api/world` pasan a ser ramas del `fetch` del DO
 *    (el Worker de borde los reenvía con `stub.fetch(request)`), devolviendo
 *    `Response.json(...)`. Mismo cuerpo, mismo contrato.
 *
 * 7. LÍMITES A VIGILAR.
 *      - Un DO es un solo hilo: 20 collectors y 3 consolas van sobrados, pero
 *        el coalescing del bus deja de ser un lujo y pasa a ser obligatorio.
 *      - El mensaje máximo por WebSocket es 1 MiB: un `{t:'world'}` con cientos
 *        de agentes puede acercarse. Si pasa, hay que trocearlo (mandar el
 *        mundo por secciones: machines, projects, agents en lotes).
 *      - `ctx.storage.put` tiene un límite de 128 KiB por valor.
 *
 * ── Esqueleto ────────────────────────────────────────────────────────
 *
 *   // wrangler.jsonc
 *   // {
 *   //   "name": "orca-hub",
 *   //   "main": "src/hub/worker.ts",
 *   //   "compatibility_date": "2026-01-01",
 *   //   "durable_objects": { "bindings": [{ "name": "HUB", "class_name": "HubDO" }] },
 *   //   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["HubDO"] }]
 *   // }
 *
 *   // import { DurableObject } from 'cloudflare:workers';
 *   // import { World } from './world.ts';
 *   // import { PatchBus } from './bus.ts';
 *   // import { PATHS, PROTOCOL_VERSION } from '../shared/protocol.ts';
 *   //
 *   // export class HubDO extends DurableObject<Env> {
 *   //   private world = new World({ onOps: (ops) => this.bus.push(ops) });
 *   //   private bus = new PatchBus({
 *   //     onBeforeFlush: () => this.world.settle(),
 *   //     onFlush: (frame) => {
 *   //       const payload = JSON.stringify({ t: 'patch', ...frame });
 *   //       for (const ws of this.ctx.getWebSockets('console')) ws.send(payload);
 *   //     },
 *   //   });
 *   //
 *   //   async fetch(req: Request): Promise<Response> {
 *   //     const url = new URL(req.url);
 *   //     if (url.pathname === '/api/health') return Response.json(this.world.health());
 *   //     if (url.pathname === '/api/world')  return Response.json(this.world.snapshot(this.bus.rev));
 *   //     if (req.headers.get('Upgrade') !== 'websocket') return new Response('no', { status: 400 });
 *   //     if (url.searchParams.get('token') !== this.env.ORCA_TOKEN) return new Response('no', { status: 401 });
 *   //
 *   //     const role = url.pathname === PATHS.collector ? 'collector' : 'console';
 *   //     const { 0: client, 1: server } = new WebSocketPair();
 *   //     this.ctx.acceptWebSocket(server, [role]);
 *   //     server.serializeAttachment({ role, machineId: null });
 *   //     if (role === 'console') server.send(JSON.stringify({ t: 'world', state: this.world.snapshot(this.bus.rev) }));
 *   //     return new Response(null, { status: 101, webSocket: client });
 *   //   }
 *   //
 *   //   async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
 *   //     const meta = ws.deserializeAttachment() as { role: string; machineId: string | null };
 *   //     const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
 *   //     if (meta.role === 'collector') {
 *   //       if (frame.t === 'hello') {
 *   //         if (frame.v !== PROTOCOL_VERSION) return ws.close(4002, 'versión');
 *   //         meta.machineId = frame.machine.id;
 *   //         ws.serializeAttachment(meta);
 *   //         // los tags son inmutables tras acceptWebSocket, así que el
 *   //         // enrutado por máquina se hace escaneando attachments:
 *   //         //   this.ctx.getWebSockets('collector').find(w => w.deserializeAttachment().machineId === id)
 *   //       }
 *   //       this.world.applyCollector(frame, meta.machineId!);
 *   //       await this.ctx.storage.setAlarm(Date.now() + 5_000);
 *   //     } else {
 *   //       // ... mismo switch que handleConsoleFrame en server.ts
 *   //     }
 *   //   }
 *   //
 *   //   async webSocketClose(ws: WebSocket) {
 *   //     const meta = ws.deserializeAttachment();
 *   //     if (meta?.machineId) this.world.markMachineOffline(meta.machineId, 'socket cerrado');
 *   //   }
 *   //
 *   //   async alarm() {
 *   //     this.world.sweep();
 *   //     this.bus.flush();
 *   //     if (this.ctx.getWebSockets('collector').length > 0) {
 *   //       await this.ctx.storage.setAlarm(Date.now() + 5_000);
 *   //     }
 *   //   }
 *   // }
 *   //
 *   // export default {
 *   //   async fetch(req: Request, env: Env): Promise<Response> {
 *   //     return env.HUB.get(env.HUB.idFromName('orca')).fetch(req);
 *   //   },
 *   // } satisfies ExportedHandler<Env>;
 *
 * ── Resumen del trabajo pendiente ────────────────────────────────────
 *
 *   [ ] npm i -D wrangler @cloudflare/workers-types  (y añadirlos a tsconfig)
 *   [ ] wrangler.jsonc con el binding del DO
 *   [ ] portar server.ts → HubDO (transporte + tags, la lógica no se toca)
 *   [ ] persist.ts → ctx.storage / R2
 *   [ ] memory.ts → extraer la similitud pura y respaldarla en KV o D1
 *   [ ] Cloudflare Access delante de /ws/console
 */

export {};
