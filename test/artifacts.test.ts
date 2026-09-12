/**
 * Artefactos, de punta a punta.
 *
 * Cuatro cosas, y ninguna es decorativa:
 *
 *  1. La detección — un `Write` a un .png en un transcript se convierte en un
 *     registro; un `Write` a un .ts no. Sin esto, esto sólo funciona para los
 *     agentes que se acuerdan de llamar a `orca-show`.
 *  2. La lista blanca — `artifact:read` sirve ids que el collector registró y
 *     nada más. Es la única razón por la que este canal no es un `cat` remoto.
 *  3. El techo de 200 — un agente que genera fotogramas en un bucle no puede
 *     llevarse el proceso por delante.
 *  4. El hub sirviendo /api/artifact/<id> — con el Content-Type correcto,
 *     pidiéndoselo al collector y guardándolo en su caché.
 *
 * Todo corre en directorios temporales propios: nada toca ~/.orca ni ~/.claude.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactIndex, MAX_ARTIFACTS, artifactId, sizeFromHeader } from '../src/collector/artifacts.ts';
import { SessionDeriver } from '../src/collector/derive.ts';
import type { LineBatch, TranscriptRef } from '../src/collector/watch.ts';
import { World, MAX_ARTIFACTS as HUB_MAX_ARTIFACTS } from '../src/hub/world.ts';
import { startHub } from '../src/hub/server.ts';
import type { Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { makePng, startFakeFleet } from './fake-collector.ts';
import type { FakeMachine } from './fake-collector.ts';

export interface TestResult { name: string; pass: boolean; detail: string }

const TOKEN = 'test-token-orca-artifacts';
const MACHINE = 'm-art';

function ok(name: string, detail = ''): TestResult { return { name, pass: true, detail }; }
function fail(name: string, detail: string): TestResult { return { name, pass: false, detail }; }

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timeout esperando: ${what}`);
}

function tempDir(prefix = 'orca-art-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Un índice sin vigilancia de disco: los tests lo alimentan a mano. */
function index(): ArtifactIndex {
  return new ArtifactIndex({ machineId: MACHINE, resolveAgent: () => 'a1' });
}

/* ── transcript sintético ─────────────────────────────────────────── */

function ref(sessionId: string, file: string): TranscriptRef {
  return {
    path: file, slug: '-tmp-proj', sessionId, agentId: null,
    metaPath: null, workflowId: null, key: sessionId,
  };
}

function writeLine(at: number, tool: string, filePath: string): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'claude-opus-4-6',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: `tu_${tool}_${filePath}`, name: tool, input: { file_path: filePath } }],
    },
  };
}

function batch(r: TranscriptRef, lines: Record<string, unknown>[]): LineBatch {
  return { ref: r, lines, bootstrap: false, mtimeMs: Date.now(), at: Date.now() };
}

/* ── 1 · detección ────────────────────────────────────────────────── */

export async function testDetectionFromTranscript(): Promise<TestResult> {
  const name = 'un Write a un .png sale del transcript como artefacto';
  const dir = tempDir();
  try {
    const png = join(dir, 'heatmap.png');
    writeFileSync(png, makePng(64, 5));
    writeFileSync(join(dir, 'notes.md'), '# hola\n');
    writeFileSync(join(dir, 'world.ts'), 'export const x = 1;\n');

    const d = new SessionDeriver(ref('s-1', join(dir, 's-1.jsonl')), MACHINE, 'p1');
    d.ingest(batch(d.ref, [
      writeLine(Date.now() - 3_000, 'Write', png),
      writeLine(Date.now() - 2_000, 'Edit', join(dir, 'notes.md')),
      // Trabajo normal: se ve en el diff, no es algo que mirar.
      writeLine(Date.now() - 1_000, 'Write', join(dir, 'world.ts')),
      // Una tool que no escribe archivos nunca produce un artefacto.
      writeLine(Date.now(), 'Read', png),
    ]));

    const produced = d.drainProduced();
    assert(produced.length === 2, `esperaba 2 rutas producidas, hubo ${produced.length}`);
    assert(d.drainProduced().length === 0, 'la cola debería vaciarse al drenarla');

    const idx = index();
    const seen: string[] = [];
    idx.onArtifact((a) => seen.push(a.id));
    for (const f of produced) {
      idx.observe({ path: f.path, projectId: 'p1', agentId: d.id, at: f.at, cwd: dir });
    }

    const all = idx.list();
    assert(all.length === 2, `esperaba 2 artefactos, hubo ${all.length}`);
    assert(seen.length === 2, 'cada alta debería avisar una vez');

    const image = all.find((a) => a.path === png);
    assert(image !== undefined, 'el png no se registró');
    assert(image!.kind === 'image', `kind ${image!.kind}, esperaba image`);
    assert(image!.title === 'heatmap.png', `title ${image!.title}`);
    assert(image!.width === 64 && image!.height === 64,
      `dimensiones ${image!.width}x${image!.height}, esperaba 64x64`);
    assert(image!.bytes > 0, 'bytes en cero');
    assert(image!.url === null, 'la url la pone el hub, no el collector');
    assert(image!.id === artifactId(MACHINE, png), 'el id no es el derivado de máquina+ruta');

    const text = all.find((a) => a.path.endsWith('notes.md'));
    assert(text?.kind === 'text', `el .md debería ser text, fue ${text?.kind}`);
    assert(image!.source === 'observed', `lo detectado es observed, fue ${image!.source}`);

    // Reescribir el mismo archivo actualiza el mismo registro, no crea otro.
    writeFileSync(png, makePng(64, 9));
    idx.observe({ path: png, projectId: 'p1', agentId: d.id, at: Date.now(), cwd: dir });
    assert(idx.list().length === 2, 'reescribir duplicó el artefacto');
    assert(idx.get(image!.id)!.at > image!.at, 'reescribir no renovó `at`');

    return ok(name, `2 de 4 tool_use califican; png 64×64, .md como text, reescritura in situ`);
  } catch (err) {
    return fail(name, String(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 2 · lista blanca ─────────────────────────────────────────────── */

export async function testReadIsAllowlisted(): Promise<TestResult> {
  const name = 'artifact:read sólo sirve lo que el collector registró';
  const dir = tempDir();
  try {
    const png = join(dir, 'chart.png');
    writeFileSync(png, makePng(64, 2));
    // Un archivo que existe, que es legible, y que NADIE registró.
    const secret = join(dir, 'secrets.txt');
    writeFileSync(secret, 'sk-live-do-not-exfiltrate\n');

    const idx = index();
    idx.observe({ path: png, projectId: 'p1', agentId: 'a1', at: Date.now() });
    const registered = idx.list()[0]!;

    const good = await idx.read(registered.id);
    assert(good.ok, `leer lo registrado falló: ${good.detail}`);
    const data = good.data as { base64: string; mime: string; bytes: number };
    assert(data.mime === 'image/png', `mime ${data.mime}`);
    assert(Buffer.from(data.base64, 'base64').length === data.bytes, 'bytes no cuadran');

    // Un id que no existe.
    const missing = await idx.read('art_0000000000000000');
    assert(!missing.ok, 'un id desconocido debería fallar');

    // El id que TENDRÍA ese archivo si estuviera registrado. Existe en disco y
    // el índice lo conoce como derivación: aun así no se sirve.
    const forged = await idx.read(artifactId(MACHINE, secret));
    assert(!forged.ok, 'una ruta no registrada no puede servirse');
    assert((forged.detail ?? '').includes('desconocido'), `detail poco claro: ${forged.detail}`);

    // Una publicación explícita que apunta fuera de su proyecto se rechaza:
    // ahí la ruta la escribe el agente y se vuelve descargable desde el hub.
    const outside = tempDir('orca-art-out-');
    try {
      const away = join(outside, 'away.png');
      writeFileSync(away, makePng(32, 4));
      idx.observe({ path: away, projectId: 'p1', agentId: 'a1', at: Date.now(), declaredIn: dir });
      assert(idx.list().length === 1, 'una declaración fuera del proyecto entró igual');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    return ok(name, 'el registrado sale como image/png; el id forjado, el desconocido y el de fuera del proyecto, no');
  } catch (err) {
    return fail(name, String(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 3 · techo ────────────────────────────────────────────────────── */

export async function testArtifactCap(): Promise<TestResult> {
  const name = `el techo de ${MAX_ARTIFACTS} expulsa lo más viejo y lo dice`;
  const dir = tempDir();
  try {
    const idx = index();
    const gone: string[] = [];
    idx.onGone((id) => gone.push(id));

    const png = makePng(16, 1);
    const first: string[] = [];
    const base = Date.now() - 10 * (MAX_ARTIFACTS + 5);
    for (let i = 0; i < MAX_ARTIFACTS + 5; i++) {
      const file = join(dir, `frame-${String(i).padStart(4, '0')}.png`);
      writeFileSync(file, png);
      idx.observe({ path: file, projectId: 'p1', agentId: 'a1', at: base + i * 10 });
      if (i < 5) first.push(artifactId(MACHINE, file));
    }

    assert(idx.list().length === MAX_ARTIFACTS,
      `quedaron ${idx.list().length}, esperaba ${MAX_ARTIFACTS}`);
    assert(gone.length === 5, `avisó de ${gone.length} expulsiones, esperaba 5`);
    for (const id of first) {
      assert(!idx.get(id), 'un artefacto viejo sobrevivió al techo');
      assert(gone.includes(id), 'se expulsó sin avisar: eso deja un hueco en la consola');
    }
    // Lo último producido es lo que el operador quiere ver: se queda entero.
    const last = artifactId(MACHINE, join(dir, `frame-${String(MAX_ARTIFACTS + 4).padStart(4, '0')}.png`));
    assert(idx.get(last) !== null, 'se expulsó el más reciente');

    return ok(name, `${MAX_ARTIFACTS + 5} producidos → ${idx.list().length} en el índice, 5 gone emitidos`);
  } catch (err) {
    return fail(name, String(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 3b · el mundo del hub ────────────────────────────────────────── */

export async function testWorldStoresAndServesUrl(): Promise<TestResult> {
  const name = 'el mundo guarda el artefacto, le pone url y lo desaloja por edad';
  try {
    const dropped: string[] = [];
    const world = new World({ onArtifactGone: (id) => dropped.push(id) });
    world.upsertMachine({
      id: MACHINE, hostname: 'mac', platform: 'darwin', version: '0.1.0',
      online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
    });

    const fresh = {
      id: 'art_fresh0000000001', agentId: 'a1', projectId: 'p1', machineId: MACHINE,
      kind: 'image', path: '/tmp/x/heat.png', title: 'Heat', url: 'https://evil.example/x',
      bytes: 1234, width: 64, height: 64, at: Date.now(), placement: null,
    };
    const stale = { ...fresh, id: 'art_stale0000000001', at: Date.now() - 26 * 3600_000 };

    const a = world.upsertArtifact(MACHINE, fresh);
    world.upsertArtifact(MACHINE, stale);
    assert(a.url === '/api/artifact/art_fresh0000000001',
      `la url la pone el hub, no el productor: ${a.url}`);
    assert(Object.keys(world.state.artifacts).length === 2, 'no entraron los dos');

    world.sweep();
    assert(world.state.artifacts['art_fresh0000000001'] !== undefined, 'se cayó el reciente');
    assert(world.state.artifacts['art_stale0000000001'] === undefined, 'el de 26h sigue ahí');
    assert(dropped.includes('art_stale0000000001'), 'se desalojó sin avisar a la caché');

    // El collector dice que ya no está.
    world.removeArtifact(MACHINE, 'art_fresh0000000001');
    assert(Object.keys(world.state.artifacts).length === 0, 'artifact:gone no lo quitó');
    // Y una máquina no puede borrar lo de otra.
    world.upsertArtifact(MACHINE, fresh);
    world.removeArtifact('otra-maquina', 'art_fresh0000000001');
    assert(world.state.artifacts['art_fresh0000000001'] !== undefined,
      'una máquina borró el artefacto de otra');

    return ok(name, 'url reescrita por el hub, 24h de retención, gone respeta el dueño');
  } catch (err) {
    return fail(name, String(err));
  }
}

/* ── 4 · el hub sirviéndolo ───────────────────────────────────────── */

export async function testHubServesArtifact(): Promise<TestResult> {
  const name = 'integración: GET /api/artifact/<id> con el mime correcto';
  const dir = tempDir('orca-art-hub-');
  const cache = join(dir, 'cache');
  let hub: Hub | null = null;
  let fleet: { machines: FakeMachine[]; stop: () => void } | null = null;
  try {
    hub = await startHub({
      port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
      store: new HubStore({ dir: join(dir, 'hub') }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')),
      artifactCache: cache,
    });
    const port = hub.port;
    fleet = startFakeFleet({ hub: `ws://127.0.0.1:${port}`, token: TOKEN, quiet: true, speed: 6 });
    const machine = fleet.machines[0]!;
    await until(() => Object.keys(hub!.world.state.machines).length >= 1, 8_000, 'una máquina');
    await until(() => hub!.world.state.fleet.total > 0, 8_000, 'agentes');

    // Provocamos el artefacto en vez de esperar al azar: la prueba comprueba la
    // tubería, no la probabilidad.
    let produced = machine.produceArtifact();
    for (let i = 0; i < 40 && (!produced || produced.kind !== 'image'); i++) {
      produced = machine.produceArtifact();
    }
    assert(produced !== null, 'la flota falsa no produjo ningún artefacto');
    await until(() => hub!.world.state.artifacts[produced!.id] !== undefined, 8_000, 'el artefacto en el mundo');

    const url = `http://127.0.0.1:${port}/api/artifact/${produced!.id}?token=${encodeURIComponent(TOKEN)}`;
    const res = await fetch(url);
    if (res.status !== 200) throw new Error(`esperaba 200, llegó ${res.status}: ${await res.text()}`);
    const mime = res.headers.get('content-type') ?? '';
    assert(mime === 'image/png' || mime === 'image/svg+xml', `content-type ${mime}`);
    assert((res.headers.get('cache-control') ?? '') === 'private, max-age=3600',
      `cache-control ${res.headers.get('cache-control')}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert(body.length === produced!.bytes, `${body.length}B servidos, ${produced!.bytes}B esperados`);
    if (mime === 'image/png') {
      const dim = sizeFromHeader(body);
      assert(dim !== null, 'lo servido no es un PNG válido');
    }

    // Quedó en la caché: la segunda vista no vuelve a molestar a la máquina.
    assert(existsSync(join(cache, produced!.id)), 'no se guardó en ~/.orca/artifacts');
    machine.drop();                        // sin collector conectado…
    const again = await fetch(url);
    assert(again.status === 200, `la caché no sirvió sin collector: ${again.status}`);
    assert(Buffer.from(await again.arrayBuffer()).length === produced!.bytes, 'la caché sirvió otra cosa');

    // Un html lleva sandbox, para que la página de un agente no hable con el hub.
    machine.reconnect();
    await until(() => machine.connected, 8_000, 'el collector de vuelta');
    let html = machine.produceArtifact();
    for (let i = 0; i < 60 && html?.kind !== 'html'; i++) html = machine.produceArtifact();
    let csp = '(sin html producido)';
    if (html?.kind === 'html') {
      await until(() => hub!.world.state.artifacts[html!.id] !== undefined, 8_000, 'el html en el mundo');
      const page = await fetch(`http://127.0.0.1:${port}/api/artifact/${html.id}?token=${encodeURIComponent(TOKEN)}`);
      assert(page.status === 200, `el html devolvió ${page.status}`);
      csp = page.headers.get('content-security-policy') ?? '';
      assert(csp === 'sandbox', `un html sin sandbox puede hablar con el hub (csp="${csp}")`);
      assert((page.headers.get('content-type') ?? '').startsWith('text/html'), 'el html no salió como html');
    }

    // Un id que el mundo no conoce es 404, no un 200 vacío.
    const nope = await fetch(`http://127.0.0.1:${port}/api/artifact/art_noexiste?token=${encodeURIComponent(TOKEN)}`);
    assert(nope.status === 404, `un id desconocido devolvió ${nope.status}`);
    // Y sin token, 401: esto son bytes de la máquina de alguien.
    const anon = await fetch(`http://127.0.0.1:${port}/api/artifact/${produced!.id}`);
    assert(anon.status === 401, `sin token devolvió ${anon.status}`);

    return ok(name, `${mime} servido y cacheado, sirve sin collector, html csp="${csp}", 404 y 401 correctos`);
  } catch (err) {
    return fail(name, String(err));
  } finally {
    fleet?.stop();
    await hub?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 5 · publicación explícita ────────────────────────────────────── */

export async function testExplicitPublication(): Promise<TestResult> {
  const name = 'orca-show: <project>/.orca/artifacts/<id>.json se recoge del disco';
  const dir = tempDir('orca-art-show-');
  const idx = index();
  try {
    const png = join(dir, 'out', 'render.png');
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(png, makePng(64, 6));

    const decls = join(dir, '.orca', 'artifacts');
    mkdirSync(decls, { recursive: true });
    writeFileSync(join(decls, 'show_abc.json'), JSON.stringify({
      path: png, title: 'El render final', agentId: 'a1', at: Date.now(),
    }));
    // Y una que apunta fuera del proyecto: no puede entrar.
    writeFileSync(join(decls, 'show_bad.json'), JSON.stringify({
      path: '/etc/hosts', title: 'nope', agentId: 'a1',
    }));

    const seen: string[] = [];
    idx.onArtifact((a) => seen.push(a.title));
    idx.track('p1', dir);
    idx.start(50);
    await until(() => seen.length > 0, 4_000, 'la declaración recogida');
    await sleep(150);

    assert(idx.list().length === 1, `entraron ${idx.list().length} artefactos, esperaba 1`);
    const a = idx.list()[0]!;
    assert(a.title === 'El render final', `title ${a.title}`);
    assert(a.path === png, `path ${a.path}`);
    assert(a.agentId === 'a1', `agentId ${a.agentId}`);
    assert(a.source === 'declared', `lo publicado es declared, fue ${a.source}`);
    // La declaración NO se borra: es estado, y un collector reiniciado tiene que
    // volver a encontrarla.
    assert(existsSync(join(decls, 'show_abc.json')), 'la declaración se borró');
    // Y no se re-emite en cada tick mientras no cambie.
    const before = seen.length;
    await sleep(200);
    assert(seen.length === before, `se re-emitió ${seen.length - before} veces sin cambiar nada`);

    return ok(name, `1 declaración válida entra con su título, /etc/hosts no, y no repite`);
  } catch (err) {
    return fail(name, String(err));
  } finally {
    idx.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 6 · declarado gana a observado ───────────────────────────────── */

/**
 * `source` es lo que le dice al canvas qué puede anclar solo.
 *
 * La regla tiene una dirección: declarar es una decisión de un agente y no se
 * pierde. Lo contrario —que un `Write` posterior degradara a «algo que
 * apareció» la gráfica que el agente publicó con su título— haría que el
 * artefacto se cayera del canvas justo cuando el agente lo actualiza, que es
 * cuando más ganas hay de mirarlo.
 */
export async function testDeclaredBeatsObserved(): Promise<TestResult> {
  const name = 'declarado sube desde observado y no vuelve a bajar';
  const dir = tempDir('orca-art-src-');
  const idx = index();
  try {
    const png = join(dir, 'out', 'render.png');
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(png, makePng(64, 6));

    // 1. Primero aparece solo: un Write en el transcript.
    idx.observe({ path: png, projectId: 'p1', agentId: 'a1', at: Date.now(), cwd: dir });
    const id = artifactId(MACHINE, png);
    assert(idx.get(id)?.source === 'observed', 'la detección debería dar observed');
    assert(idx.get(id)?.title === 'render.png', 'el título observado es el nombre del archivo');

    // 2. El agente lo publica: gana un título suyo y sube a declared.
    idx.observe({
      path: png, projectId: 'p1', agentId: 'a1', at: Date.now() + 1,
      declaredIn: dir, title: 'El render final',
    });
    assert(idx.get(id)?.source === 'declared', 'publicar no subió el source');
    assert(idx.get(id)?.title === 'El render final', 'publicar no puso el título del agente');

    // 3. Lo reescribe. Sigue siendo el que él eligió.
    writeFileSync(png, makePng(64, 9));
    idx.observe({ path: png, projectId: 'p1', agentId: 'a1', at: Date.now() + 2, cwd: dir });
    const after = idx.get(id)!;
    assert(after.source === 'declared', `reescribirlo lo degradó a ${after.source}`);
    assert(after.title === 'El render final', `reescribirlo perdió el título: ${after.title}`);

    // 4. Y el hub no se fía de lo que le llegue: sólo 'declared' literal pasa.
    const world = new World({});
    world.upsertMachine({
      id: MACHINE, hostname: 'mac', platform: 'darwin', version: '0.1.0',
      online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
    });
    const kept = world.upsertArtifact(MACHINE, { ...after });
    assert(kept.source === 'declared', 'el hub perdió el source declarado');
    const junk = world.upsertArtifact(MACHINE, {
      ...after, id: 'art_junk00000000001', source: 'whatever-the-agent-said',
    });
    assert(junk.source === 'observed', `un source inventado debería caer a observed, fue ${junk.source}`);

    return ok(name, 'observed → declared con título propio; reescribir no degrada; el hub valida');
  } catch (err) {
    return fail(name, String(err));
  } finally {
    idx.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * El techo no puede tirar lo que alguien eligió.
 *
 * Medido en la flota real el día que se escribió esto: una corrida del arnés
 * visual metió diez capturas en el índice en un minuto. Con el techo por edad
 * a secas, media hora de trabajo de una flota empuja fuera la gráfica que un
 * agente publicó a propósito, que es justo la que el operador quería ver.
 */
export async function testCapKeepsWhatWasDeclared(): Promise<TestResult> {
  const name = 'el techo expulsa lo observado antes que lo declarado';
  const dir = tempDir('orca-art-cap-');
  const idx = index();
  try {
    const png = join(dir, 'the-one.png');
    writeFileSync(png, makePng(64, 2));
    // Lo declarado es lo más VIEJO del índice: por edad se iría el primero.
    idx.observe({
      path: png, projectId: 'p1', agentId: 'a1', at: 1_000,
      declaredIn: dir, title: 'La gráfica que importa',
    });
    const id = artifactId(MACHINE, png);

    // Y ahora el arnés, por decirlo así.
    for (let i = 0; i < MAX_ARTIFACTS + 20; i++) {
      const f = join(dir, `shot-${i}.png`);
      writeFileSync(f, makePng(8, i % 200));
      idx.observe({ path: f, projectId: 'p1', agentId: 'a1', at: 2_000 + i });
    }

    assert(idx.list().length === MAX_ARTIFACTS, `el techo no se respetó: ${idx.list().length}`);
    const kept = idx.get(id);
    assert(kept !== null, 'el techo se llevó por delante lo que el agente publicó');
    assert(kept!.source === 'declared', 'y lo que quedó ya no es lo declarado');

    return ok(name, `${MAX_ARTIFACTS + 20} capturas no tiran una declaración de hace un siglo`);
  } catch (err) {
    return fail(name, String(err));
  } finally {
    idx.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** La misma regla, en el otro techo: el del hub, que es el que ve la consola. */
export async function testHubCapKeepsWhatWasDeclared(): Promise<TestResult> {
  const name = 'el techo del hub también deja caer lo observado primero';
  try {
    const world = new World({});
    world.upsertMachine({
      id: MACHINE, hostname: 'mac', platform: 'darwin', version: '0.1.0',
      online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
    });
    const now = Date.now();
    const base = {
      agentId: 'a1', projectId: 'p1', machineId: MACHINE, kind: 'image',
      path: '/tmp/x.png', title: 'x', url: null, bytes: 10,
      width: null, height: null, open: false, placement: null,
    };
    // El declarado es, otra vez, el más viejo de todos.
    world.upsertArtifact(MACHINE, {
      ...base, id: 'art_declared000001', source: 'declared', at: now - 3600_000,
    });
    for (let i = 0; i < HUB_MAX_ARTIFACTS + 10; i++) {
      world.upsertArtifact(MACHINE, {
        ...base, id: `art_shot${String(i).padStart(11, '0')}`, source: 'observed', at: now - i,
      });
    }
    world.sweep();
    const left = Object.keys(world.state.artifacts).length;
    assert(left <= HUB_MAX_ARTIFACTS, `el techo del hub no se respetó: ${left}`);
    assert(world.state.artifacts['art_declared000001'] !== undefined,
      'el hub tiró lo declarado para quedarse con capturas de arnés');
    return ok(name, `${HUB_MAX_ARTIFACTS + 10} observados, y la declaración de hace una hora sigue`);
  } catch (err) {
    return fail(name, String(err));
  }
}

/* ── 7 · lo que sale de un proceso, no de una tool ────────────────── */

/**
 * El caso del operador: un pipeline de generación.
 *
 * `ffmpeg`, `playwright`, un script de render — nada de eso pasa por Write, y
 * hasta ahora no existía para ORCA. Se comprueba con un archivo escrito por
 * fuera del índice, que es exactamente lo que hace un proceso hijo, y se
 * comprueba también lo que NO puede entrar: dependencias, trabajo intermedio,
 * lo oculto y las extensiones que no son para mirar.
 */
export async function testTreeCatchesWhatBashMade(): Promise<TestResult> {
  const name = 'un archivo que aparece en el árbol entra sin que ninguna tool lo escriba';
  const dir = tempDir('orca-art-tree-');
  const idx = index();
  try {
    mkdirSync(join(dir, 'out'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });

    idx.track('p1', dir);
    idx.start(50);
    // Que el watch esté montado antes de escribir: si no, esto mide el poll.
    await sleep(200);

    // El render que nos importa, como lo dejaría un proceso hijo.
    writeFileSync(join(dir, 'out', 'frame-final.png'), makePng(64, 3));
    // Y todo lo que no debe entrar.
    writeFileSync(join(dir, 'node_modules', 'pkg', 'logo.png'), makePng(64, 4));
    writeFileSync(join(dir, '.cache', 'thumb.png'), makePng(64, 5));
    writeFileSync(join(dir, 'out', 'pipeline.ts'), 'export const x = 1;\n');

    await until(() => idx.list().length > 0, 4_000, 'el png del árbol');
    await sleep(300);

    const all = idx.list();
    assert(all.length === 1, `entraron ${all.length}: ${all.map((a) => a.path).join(' ')}`);
    const a = all[0]!;
    assert(a.path === join(dir, 'out', 'frame-final.png'), `entró el que no era: ${a.path}`);
    assert(a.source === 'observed', `lo que aparece solo es observed, fue ${a.source}`);
    assert(a.agentId === 'a1', `sin dueño resuelto no habría registro: ${a.agentId}`);
    assert(a.width === 64, 'no se leyó la cabecera del png');

    return ok(name, 'el png del build entra como observed; node_modules, lo oculto y el .ts no');
  } catch (err) {
    return fail(name, String(err));
  } finally {
    idx.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sin dueño no hay registro.
 *
 * Un archivo que aparece no lleva firma, así que el índice le pregunta al
 * collector quién estaba trabajando ahí. Cuando la respuesta es «nadie» —el
 * proyecto no tiene ningún agente vivo— inventar uno pondría el trabajo de
 * alguien colgando de otro. Se descarta y ya está.
 */
export async function testTreeNeedsAnOwner(): Promise<TestResult> {
  const name = 'un archivo del árbol sin agente a quien atribuirlo no se registra';
  const dir = tempDir('orca-art-orphan-');
  let asked = 0;
  const idx = new ArtifactIndex({
    machineId: MACHINE,
    resolveAgent: () => { asked++; return null; },
  });
  try {
    idx.track('p1', dir);
    idx.start(50);
    await sleep(200);
    writeFileSync(join(dir, 'render.png'), makePng(64, 7));
    await until(() => asked > 0, 4_000, 'que el árbol pregunte de quién es');
    await sleep(200);
    assert(idx.list().length === 0, `se registró sin dueño: ${idx.list().length}`);
    return ok(name, 'nadie vivo en el proyecto: el archivo se queda en su disco');
  } catch (err) {
    return fail(name, String(err));
  } finally {
    idx.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── suite ────────────────────────────────────────────────────────── */

export default {
  suite: 'artifacts — detección · lista blanca · techo · hub sirviéndolo',
  tests: [
    testDetectionFromTranscript,
    testReadIsAllowlisted,
    testArtifactCap,
    testWorldStoresAndServesUrl,
    testExplicitPublication,
    testDeclaredBeatsObserved,
    testCapKeepsWhatWasDeclared,
    testHubCapKeepsWhatWasDeclared,
    testTreeCatchesWhatBashMade,
    testTreeNeedsAnOwner,
    testHubServesArtifact,
  ],
};
