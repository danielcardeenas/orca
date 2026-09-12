/**
 * ORCA — collector falso.
 *
 * Una flota sintética pero creíble para desarrollar el hub y la consola sin
 * depender del collector real. Levanta 3 máquinas (un Mac, dos Linux), 6
 * proyectos con nombres plausibles y ~20 agentes que de verdad hacen cosas:
 * cambian de estado, ejecutan herramientas reales (Bash, Edit, Read, Task,
 * WebSearch), acumulan costo y tokens/seg en rangos verosímiles, lanzan hijos
 * con `Task`, se bloquean pidiendo permiso y escalan preguntas al humano.
 *
 * Habla el protocolo entero, incluidos los comandos de vuelta: si la consola
 * manda `spawn`, aparece un agente; si manda `answer`, la escalación se cierra
 * y el agente se desbloquea; si manda `stop`, el agente muere. Es la
 * herramienta con la que se desarrolla la UI.
 *
 *   npx tsx test/fake-collector.ts
 *   npx tsx test/fake-collector.ts --isolated
 *   npx tsx test/fake-collector.ts --hub=ws://localhost:4479 --token=... --speed=3
 *
 * Sus máquinas se declaran `synthetic` en el `hello`, y un hub que no sea de
 * pruebas las RECHAZA ahí mismo: la puerta está en el hub, no aquí, y no hay
 * flag de este lado que la abra. Ver src/shared/synthetic.ts. Dentro de un hub
 * de pruebas siguen en cuarentena: nada de lo que inventen —una escalación, un
 * mensaje de escuadrón— cruza a un CAPCOM de verdad.
 *
 * Flags:
 *   --hub=<url>     base ws del hub (default ws://localhost:4479)
 *   --token=<t>     token; si falta usa ORCA_TOKEN o ~/.orca/token
 *   --isolated      su propio ORCA_HOME y su propio hub, como test/visual.ts
 *   --anyway        arrancar aunque el hub DE PRUEBAS tenga un CAPCOM vivo.
 *                   No abre un hub real: para eso no hay flag.
 *   --chaos         desconecta y reconecta máquinas al azar
 *   --speed=<n>     multiplicador de ritmo (default 1)
 *   --agents=<n>    escala la flota hasta ~n agentes iniciales (default: 20)
 *   --squad[=name]  añade un escuadrón (un líder + 3 hijos) en la 1ª máquina
 *   --quiet         menos ruido en stdout
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { WebSocket } from 'ws';

import type {
  Agent, AgentMessage, Artifact, ArtifactKind, Collision, Escalation, FeedItem,
  KeyDescriptor, Machine, Project,
} from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import type { SpawnAck } from '../src/shared/protocol.ts';
import type { Command, CollectorFrame, CommandFrame } from '../src/shared/protocol.ts';
import {
  BEAT_INTERVAL_MS, MAX_ARTIFACT_BYTES, PATHS, PORTS, PROTOCOL_VERSION,
  artifactMime, newId,
} from '../src/shared/protocol.ts';
import { pathToSlug } from '../src/shared/workspaces.ts';
import { HARNESS_ENV } from '../src/shared/synthetic.ts';

/**
 * De dónde salió este arnés: el repo desde el que alguien lanzó las pruebas.
 * Viaja en el `hello` para que la consola plante el recinto de fixtures
 * pegado a la isla de ese proyecto, en vez de dejarlo caer en un slot
 * cualquiera de la espiral entre islas de verdad. Ver src/shared/synthetic.ts.
 */
const HARNESS_HOME = pathToSlug(process.cwd());

/* ── azar ─────────────────────────────────────────────────────────── */

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const int = (a: number, b: number): number => Math.floor(rnd(a, b + 1));
const chance = (p: number): boolean => Math.random() < p;
function pick<T>(xs: readonly T[]): T {
  const v = xs[Math.floor(Math.random() * xs.length)];
  if (v === undefined) throw new Error('pick sobre lista vacía');
  return v;
}

/* ── material creíble ─────────────────────────────────────────────── */

const TITLES: readonly string[] = [
  'Refactor del pipeline de audio',
  'Fix flaky auth test on CI',
  'Migrar DNS de axolots.com a Cloudflare',
  'Add WebSocket reconnect backoff',
  'Depurar fuga de memoria en el worker de correo',
  'Escribir tests del collector',
  'Portar el hero a WebGL con ribbons',
  'Tune Postgres indexes for the feed query',
  'Quitar dependencias muertas del bundle',
  'Implement escalation memory recall',
  'Revisar contratos del protocolo',
  'Bump three.js and fix EffectComposer',
  'Instrumentar métricas de tokens/seg',
  'Arreglar el 301 de .com a .ai',
  'Draft the incident postmortem',
  'Cachear el snapshot del mundo',
  'Reescribir el parser de transcripts',
  'Harden the hub against garbage frames',
  'Añadir modo caos al fake collector',
  'Investigar por qué el VPS pierde latidos',
  'Auditar claves guardadas por proyecto',
  'Simplificar el coalescing del bus',
];

/** Lo que un líder reparte, y lo que un miembro le devuelve. Ver `formSquad`. */
const SQUAD_TASKS: readonly string[] = [
  'Revisar el manejo de errores del cliente HTTP.',
  'Buscar secretos en el histórico de git.',
  'Medir el arranque en frío y decir de dónde salen los 400ms.',
  'Comprobar que cada endpoint valida su entrada.',
];

const SQUAD_ORDERS: readonly string[] = [
  'Repartido: cada uno con su módulo, nadie toca src/shared',
  'Parad lo que estéis haciendo y contadme qué habéis encontrado',
  'El informe sale a las 18:00; mandadme una línea cada uno',
  'Cambio de prioridad: primero los endpoints de pago',
];

const SQUAD_REPORTS: readonly string[] = [
  'Terminado mi módulo: dos validaciones ausentes, ninguna explotable',
  'El arranque en frío son 280ms de DNS, no de código',
  'Encontré una key de sandbox en un commit de marzo',
  'Sin hallazgos en mi parte; me quedan los tests',
];

const MISSIONS: readonly string[] = [
  'Dejar el build verde sin tocar la API pública.',
  'Reduce p95 latency below 120ms.',
  'Encontrar la causa raíz, no un parche.',
  'Migrate without downtime; keep the old path behind a flag.',
  'Cubrir el camino feliz y dos casos de error.',
  'No romper el contrato de src/shared.',
];

const BASH: readonly string[] = [
  'npm run build',
  'git status --porcelain',
  'rg -n "PatchOp" src/ --type ts',
  'npx tsc --noEmit',
  'curl -s localhost:4479/api/health',
  'git log --oneline -12',
  'node --test test/hub.test.ts',
  'pnpm vitest run src/hub',
  'df -h /srv',
  'systemctl status axolots-mail --no-pager',
  'wrangler deploy --dry-run',
  'psql -c "select count(*) from sessions"',
];

const FILES: readonly string[] = [
  'src/hub/world.ts', 'src/hub/bus.ts', 'src/hub/server.ts', 'src/shared/protocol.ts',
  'src/ui/scene/ribbon.ts', 'src/collector/transcript.ts', 'worker/index.ts',
  'src/components/a/Hero.astro', 'test/fake-collector.ts', 'docs/CONTRACT-REQUESTS.md',
  'src/lib/audio.ts', 'migrations/0007_add_feed_index.sql',
];

const SEARCHES: readonly string[] = [
  'cloudflare durable object websocket hibernation limits',
  'ws backpressure bufferedAmount node',
  'three.js instanced mesh dynamic count',
  'postgres partial index jsonb null',
  'claude code hooks SessionStart',
  'dkim selector google workspace cloudflare',
];

const SAYS: readonly string[] = [
  'Encontré el problema: el bus no cancelaba el timer al parar.',
  'Running the suite now, three files changed.',
  'El índice parcial baja la consulta de 400ms a 12ms.',
  'I need to check how the collector handles a partial transcript line.',
  'Listo, build verde. Voy a por el segundo caso.',
  'Hmm, that test is flaky because of the 100ms window. Widening it.',
  'Renombré la función; nada más la usaba.',
  'Reverting — the migration locks the table for too long.',
  'Dejo la rama lista para revisión.',
];

const QUESTIONS: readonly {
  q: string; ctx: string; options: string[]; urgency: Escalation['urgency'];
}[] = [
  {
    q: '¿Puedo borrar la rama legacy/hero-v1 del remoto?',
    ctx: 'Nadie la ha tocado en 4 meses y el hero nuevo ya está en main.',
    options: ['Sí, bórrala', 'No, archívala primero', 'Déjala'],
    urgency: 'normal',
  },
  {
    q: 'Which database should the migration target?',
    ctx: 'Both orca_staging and orca_prod accept the DDL. The runbook does not say.',
    options: ['orca_staging', 'orca_prod', 'ninguna, para'],
    urgency: 'blocking',
  },
  {
    q: 'El test de pago falla contra el sandbox. ¿Uso la clave de test del proyecto?',
    ctx: 'STRIPE_TEST_KEY está registrada en el proyecto pero nunca se ha usado desde CI.',
    options: ['Sí, úsala', 'No, saltá el test'],
    urgency: 'normal',
  },
  {
    q: 'Should I upgrade three.js to 0.185? EffectComposer has breaking changes.',
    ctx: 'The current pin is 0.179. Two call sites would need edits.',
    options: ['Sube y arregla', 'Quédate en 0.179'],
    urgency: 'low',
  },
  {
    q: '¿Despliego a producción ahora o espero al PR de revisión?',
    ctx: 'El cambio es de una línea en el 301 de axolots.com.',
    options: ['Despliega', 'Espera al PR'],
    urgency: 'blocking',
  },
  {
    q: 'The transcript has a tool_result with no matching tool_use. Skip or fail loudly?',
    ctx: 'Happens ~1 in 4000 lines, probably a truncated write.',
    options: ['Skip and count it', 'Fail loudly'],
    urgency: 'low',
  },
];

/** Lo que un agente le dice a otro. Plausible, no decorativo. */
const TRAFFIC: readonly { kind: 'notice'|'ask'|'handoff'|'warning'; subject: string; files?: string[] }[] = [
  { kind: 'warning', subject: 'El endpoint /v1/charges devuelve 402 en sandbox desde hoy', files: ['src/api/charges.ts'] },
  { kind: 'notice',  subject: 'La migración de sesiones ya está aplicada en staging' },
  { kind: 'ask',     subject: '¿Ya renombraste AuthContext o sigo con el nombre viejo?' },
  { kind: 'ask',     subject: '¿El worker de correo espera el payload plano o anidado?' },
  { kind: 'handoff', subject: 'Terminé el cliente HTTP; falta cachear y reintentos', files: ['src/lib/http.ts'] },
  { kind: 'warning', subject: 'No toques wrangler.jsonc, lo estoy reescribiendo', files: ['wrangler.jsonc'] },
  { kind: 'notice',  subject: 'El índice parcial baja la consulta de 400ms a 12ms' },
  { kind: 'ask',     subject: '¿Los tests de pago van contra el sandbox o los mockeo?' },
  { kind: 'handoff', subject: 'Dejé el esquema listo; queda el seed', files: ['db/schema.sql'] },
];

/** Archivos que dos agentes pueden acabar tocando a la vez. */
const HOT_FILES: readonly string[] = [
  'src/hub/world.ts', 'src/lib/http.ts', 'wrangler.jsonc',
  'src/api/charges.ts', 'db/schema.sql', 'src/ui/store.ts',
];

const PERMISSIONS: readonly string[] = [
  'Bash(rm -rf node_modules) — borrar dependencias para reinstalar',
  'Bash(git push --force-with-lease origin hero) — reescribir la rama remota',
  'Write(/etc/nginx/sites-enabled/orca) — escribir fuera del proyecto',
  'Bash(psql -c "drop index feed_at_idx") — quitar un índice en producción',
  'WebFetch(https://api.stripe.com/v1/charges) — llamar a una API externa',
];

/* ── topología ────────────────────────────────────────────────────── */

interface MachineSpec {
  id: string;
  hostname: string;
  platform: string;
  projects: { id: string; name: string; code: string; path: string; branch: string; keys: string[] }[];
  agents: number;
}

const FLEET: readonly MachineSpec[] = [
  {
    id: 'mac-cascabel', hostname: 'cascabel.local', platform: 'darwin', agents: 9,
    projects: [
      { id: 'p_axolots', name: 'axolots', code: 'AX', path: '/Users/dan/projects/axolots', branch: 'main', keys: ['FAL_KEY', 'ANTHROPIC_API_KEY'] },
      { id: 'p_orca', name: 'orca', code: 'OR', path: '/Users/dan/projects/axolots/orca', branch: 'hub/world', keys: ['ANTHROPIC_API_KEY'] },
      { id: 'p_lienzo', name: 'lienzo', code: 'LZ', path: '/Users/dan/projects/lienzo', branch: 'main', keys: [] },
    ],
  },
  {
    id: 'vps-fra1', hostname: 'orca-fra1', platform: 'linux', agents: 7,
    projects: [
      { id: 'p_mail', name: 'axolots-mail', code: 'AM', path: '/srv/axolots-mail', branch: 'fase-1', keys: ['GOOGLE_SA_JSON', 'ANTHROPIC_API_KEY'] },
      { id: 'p_telemetria', name: 'telemetria', code: 'TL', path: '/srv/telemetria', branch: 'main', keys: ['CF_API_TOKEN'] },
    ],
  },
  {
    id: 'vps-nue2', hostname: 'glaciar-nue2', platform: 'linux', agents: 4,
    projects: [
      { id: 'p_glaciar', name: 'glaciar', code: 'GL', path: '/opt/glaciar', branch: 'batch-jobs', keys: ['S3_ACCESS_KEY'] },
    ],
  },
];

/** Agentes por máquina que la escala no pasa: el hub tira por encima de 400. */
const MAX_AGENTS_PER_FAKE_MACHINE = 250;

/** El id de la réplica `rep` de una máquina del fixture (`scaleFleet`). */
function replicaId(id: string, rep: number): string {
  return rep === 0 ? id : `${id}-r${rep}`;
}

/**
 * ¿Salió esta máquina de este fixture? Las tres de `FLEET` y cualquiera de sus
 * réplicas, que es todo lo que este archivo sabe poner en un hub.
 *
 * Para cuando la marca `synthetic` ya no está a mano: en un hub vivo manda la
 * máquina, que se declara en su `hello` (src/shared/synthetic.ts), pero una
 * entrada vieja del diario sólo guarda el id. El saneado del diario
 * (`tools/journal-sanitize.ts`) aparta con esto lo que un hub de pruebas
 * escribió en el directorio del real. Se deriva de `FLEET` y de la regla de
 * `replicaId`, no de una lista: renombrar una máquina aquí lo mueve también.
 */
export function isFixtureMachineId(id: string): boolean {
  return FLEET.some((m) => {
    if (id === m.id) return true;
    const rep = id.startsWith(`${m.id}-r`) ? id.slice(m.id.length + 2) : '';
    return /^[1-9]\d*$/.test(rep) && replicaId(m.id, Number(rep)) === id;
  });
}

function cloneSpec(m: MachineSpec, rep: number): MachineSpec {
  if (rep === 0) return { ...m, projects: m.projects.map((p) => ({ ...p })) };
  return {
    ...m,
    id: replicaId(m.id, rep),
    hostname: `${m.hostname}-${rep}`,
    projects: m.projects.map((p) => ({
      ...p,
      id: `${p.id}_r${rep}`,
      name: `${p.name}-${rep}`,
      code: `${p.code}${rep}`,
      path: `${p.path}-r${rep}`,
    })),
  };
}

/**
 * Escala la flota sintética hasta ~`target` agentes iniciales sin cambiar su
 * forma: replica la topología entera (máquinas *y* proyectos) tantas veces
 * como haga falta para no pasarse del techo por máquina, y luego reparte los
 * agentes en la misma proporción que la flota original. Con `target` a 0 o al
 * total por defecto devuelve la flota de siempre, así que `npm run mock` y
 * `test/visual.ts` no cambian de comportamiento.
 */
export function scaleFleet(target: number, base: readonly MachineSpec[] = FLEET): MachineSpec[] {
  const baseTotal = base.reduce((n, m) => n + m.agents, 0);
  if (!Number.isFinite(target) || target <= 0 || target === baseTotal) {
    return base.map((m) => cloneSpec(m, 0));
  }
  const want = Math.max(base.length, Math.floor(target));
  // La máquina más poblada es la que fija cuántas réplicas hacen falta.
  const maxW = Math.max(...base.map((m) => m.agents));
  const reps = Math.max(1, Math.ceil((want * maxW) / (baseTotal * MAX_AGENTS_PER_FAKE_MACHINE)));
  const out: MachineSpec[] = [];
  for (let r = 0; r < reps; r++) for (const m of base) out.push(cloneSpec(m, r));

  const weights = out.map((m) => m.agents);
  const wTotal = weights.reduce((a, b) => a + b, 0);
  let left = want;
  for (let i = 0; i < out.length; i++) {
    const rest = out.length - i - 1; // máquinas que todavía necesitan su agente
    const share = Math.round((want * (weights[i] ?? 1)) / wTotal);
    const n = i === out.length - 1 ? left : Math.max(1, Math.min(share, left - rest));
    out[i]!.agents = n;
    left -= n;
  }
  return out;
}

/* ── una máquina falsa ────────────────────────────────────────────── */

type State = Agent['state'];

interface Local {
  agent: Agent;
  /** ms hasta el próximo cambio de estado. */
  dwell: number;
  /** Escalación abierta, si la hay. */
  escalationId: string | null;
  spawnBudget: number;
  /**
   * Decorado: ni cambia de estado ni lo recicla el reaper.
   *
   * Los terminados normales se reciclan cada 20-60 s para que la flota no se
   * apague, y un agente puesto a `done` a mano entra en esa rueda: el que
   * produce la isla de fuera de la flota desaparecía a mitad de sesión: la isla
   * que se iba a fotografiar se vaciaba sola, y un test que mira quién sigue en
   * el mundo veía irse a alguien sin haber pedido nada.
   */
  pinned?: boolean;
}

/* ── artefactos de verdad ─────────────────────────────────────────── */

/**
 * Archivos reales en un directorio temporal.
 *
 * No son placeholders: son bytes que existen, que se pueden leer y que viajan
 * por el mismo `artifact:read` que usaría un collector de verdad. Sin eso, la
 * tubería —detección, frame, caché del hub, Content-Type— se probaría contra un
 * mock del propio transporte, que es exactamente donde suelen estar los fallos.
 */
export const FAKE_ARTIFACT_DIR = join(tmpdir(), 'orca-fake-artifacts');

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Un PNG RGB de verdad, codificado a mano: firma, IHDR, IDAT deflateado, IEND.
 * Node trae zlib, así que no hace falta ninguna dependencia para producir una
 * imagen que cualquier navegador abre.
 */
export function makePng(size: number, hue: number): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;                       // filtro "none" por scanline
    for (let x = 0; x < size; x++) {
      // Un tablero teñido: se distingue a simple vista de qué artefacto es.
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[o++] = on ? (hue * 37) % 256 : 18;
      raw[o++] = on ? (hue * 91) % 256 : 22;
      raw[o++] = on ? (hue * 143) % 256 : 30;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 2;    // color type 2 = RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const FAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#0b0d10"/>
  <path d="M8 96 L64 60 L120 74 L176 24 L232 40" fill="none" stroke="#7ad7c3" stroke-width="3"/>
  <text x="8" y="24" fill="#8b95a1" font-family="monospace" font-size="11">tokens/s</text>
</svg>
`;

const FAKE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>bundle report</title>
<style>
  body { background:#0b0d10; color:#c9d1d9; font:13px/1.6 ui-monospace,monospace; padding:24px }
  h1 { font-size:15px; letter-spacing:.08em; text-transform:uppercase; color:#7ad7c3 }
  td { padding:2px 18px 2px 0 } .n { color:#e0a458; text-align:right }
</style>
<h1>bundle · before / after</h1>
<table>
  <tr><td>three.js</td><td class="n">612 kB</td><td class="n">612 kB</td></tr>
  <tr><td>gsap</td><td class="n">71 kB</td><td class="n">0 kB</td></tr>
  <tr><td>app</td><td class="n">148 kB</td><td class="n">96 kB</td></tr>
</table>
`;

const FAKE_MD = `# Postmortem — el hub se quedaba sin memoria

**Impacto.** Tres horas sin consola. El proceso moría con
\`FATAL ERROR: Reached heap limit\`.

**Causa.** Nada se desalojaba. De 50 a 1.289 agentes en dos minutos con una
flota activa; cada sesión muerta seguía en el frame para siempre.

**Arreglo.** Retención por edad *y* techo duro, y nunca se tira lo que
necesita a una persona.
`;

interface FakeArtifactFile { file: string; title: string; kind: ArtifactKind; }

let FAKE_FILES: FakeArtifactFile[] | null = null;

/** Los escribe una vez por proceso y reutiliza. Idempotente a propósito. */
export function fakeArtifactFiles(): FakeArtifactFile[] {
  if (FAKE_FILES) return FAKE_FILES;
  mkdirSync(FAKE_ARTIFACT_DIR, { recursive: true });
  const out: FakeArtifactFile[] = [];
  const write = (name: string, body: Buffer | string, title: string, kind: ArtifactKind): void => {
    const file = join(FAKE_ARTIFACT_DIR, name);
    try {
      writeFileSync(file, body);
      out.push({ file, title, kind });
    } catch {
      // Un tmpdir de sólo lectura no puede tumbar la flota sintética.
    }
  };
  write('heatmap-64.png', makePng(64, 3), 'Mapa de calor de escrituras', 'image');
  write('coverage-64.png', makePng(64, 11), 'Cobertura por módulo', 'image');
  write('latency-96.png', makePng(96, 7), 'p95 antes y después', 'image');
  write('tokens.svg', FAKE_SVG, 'tokens/s de la última hora', 'image');
  write('bundle-report.html', FAKE_HTML, 'Bundle, antes y después', 'html');
  write('postmortem.md', FAKE_MD, 'Postmortem del OOM del hub', 'text');
  FAKE_FILES = out;
  return out;
}

const CALLSIGN_LETTERS = 'KTZVRNMQXBFJ';

export class FakeMachine {
  readonly spec: MachineSpec;
  private hubUrl: string;
  private token: string;
  private quiet: boolean;
  private speed: number;

  private ws: WebSocket | null = null;
  private machine: Machine;
  private projects: Project[];
  private keys: KeyDescriptor[] = [];
  private agents = new Map<string, Local>();
  private escalations = new Map<string, Escalation>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private messages = new Map<string, AgentMessage>();
  private collisions = new Map<string, Collision>();
  private artifacts = new Map<string, Artifact>();
  private stopped = false;
  private callsignSeq = 0;
  private squad: { name: string; leadId: string; memberIds: string[] } | null = null;

  constructor(
    spec: MachineSpec,
    opts: {
      hub: string; token: string; quiet: boolean; speed: number;
      /** Preset de escuadrón: un líder y N miembros que se hablan por squad. */
      squad?: { name: string; size: number } | null;
    },
  ) {
    this.spec = spec;
    this.hubUrl = opts.hub;
    this.token = opts.token;
    this.quiet = opts.quiet;
    this.speed = opts.speed;

    this.machine = {
      id: spec.id, hostname: spec.hostname, platform: spec.platform,
      version: '0.1.0-fake', online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: 0, activeSessions: 0, cpuPct: rnd(8, 40), memPct: rnd(30, 70) },
      /*
       * Lo dice en el `hello`, y con eso el hub la pone en cuarentena: nada de
       * lo que salga de aquí —una escalación sobre todo— le llega al CAPCOM de
       * verdad. Ver src/shared/synthetic.ts. Es la protección que sigue en pie
       * aunque alguien arranque esto a mano contra el puerto 4479, que es
       * exactamente como se quemó un CAPCOM en nueve minutos.
       */
      synthetic: true,
      harnessOf: HARNESS_HOME,
    };

    this.projects = spec.projects.map((p) => ({
      id: p.id, machineId: spec.id, slug: p.path.replace(/\//g, '-'), name: p.name,
      path: p.path, code: p.code, gitBranch: p.branch, gitDirty: chance(0.5),
      keyNames: p.keys, sessionIds: [], rollup: emptyRollup(),
    }));

    for (const p of spec.projects) {
      for (const k of p.keys) {
        this.keys.push({
          name: k, projectId: p.id,
          hint: Math.random().toString(36).slice(2, 6),
          addedAt: Date.now() - int(3, 90) * 86_400_000,
          lastUsedAt: chance(0.6) ? Date.now() - int(1, 900) * 60_000 : null,
          usedBy: [],
        });
      }
    }

    for (let i = 0; i < spec.agents; i++) this.spawn(null, 0);

    /*
     * Dos que viven fuera de la flota: uno en el directorio del mando y otro en
     * un scratchpad de sesión. Ni son un proyecto ni salen en el campo sin
     * SHOW ALL, y por eso están aquí: la isla que los agrupa —una, apagada, con
     * su propio rótulo— sólo se puede fotografiar si alguien los produce.
     */
    for (const [where, slug] of [
      ['capcom', '-Users-dan--orca-capcom-handoffs-2a9f9843-runtime'],
      ['scratchpad', '-private-tmp-claude-501--Users-dan-projects-orca-abc-scratchpad-probe-a'],
    ] as const) {
      const stray = this.spawn(null, 0);
      const local = this.agents.get(stray.id);
      if (local) local.pinned = true;
      stray.projectId = `${spec.id}/${slug}`;
      stray.workspace = where;
      stray.hidden = true;
      stray.state = 'done';
    }

    // Antes de conectar, para que el escuadrón entero viaje en el snapshot en
    // vez de en cuatro `agent:new` que se pierden si el socket todavía no está.
    if (opts.squad) this.formSquad(opts.squad.name, opts.squad.size);
  }

  /**
   * Un escuadrón sintético: un líder y N miembros colgando de él.
   *
   * Existe para que la consola tenga algo real que dibujar y fotografiar sin
   * lanzar agentes de verdad. Los miembros son hijos del líder —`parentId`— y
   * llevan la misma etiqueta `squad`, que es exactamente la forma que produce
   * un `spawn` con `squad`/`lead` en el collector real.
   */
  formSquad(name: string, size = 3): { lead: Agent; members: Agent[] } {
    const project = pick(this.projects);
    const lead = this.spawn(null, 0, project.id,
      `Auditar ${project.name} y consolidar en un solo informe.`, { name, lead: true });
    lead.title = `Escuadrón ${name}: auditoría de ${project.name}`;
    const members: Agent[] = [];
    for (let i = 0; i < size; i++) {
      const m = this.spawn(lead, 1, project.id, pick(SQUAD_TASKS), { name, lead: false });
      m.title = `${name}/${i + 1}: ${m.mission ?? 'trabajo del escuadrón'}`;
      members.push(m);
    }
    this.squad = { name, leadId: lead.id, memberIds: members.map((m) => m.id) };
    this.log(`escuadrón ${name}: ${lead.callsign} + ${members.map((m) => m.callsign).join(' ')}`);
    return { lead, members };
  }

  /**
   * Lo que se dicen dentro del escuadrón.
   *
   * Dos direcciones y las dos importan: el líder reparte con `scope:'squad'`
   * (un mensaje, todos los miembros) y cada miembro le reporta a él con
   * `scope:'agent'`. Es la forma del tráfico que la consola tiene que saber
   * dibujar; sin ella un escuadrón se ve igual que cuatro agentes sueltos.
   */
  private emitSquadTraffic(): void {
    const sq = this.squad;
    if (!sq) return;
    const alive = (id: string): Agent | null => {
      const a = this.agents.get(id)?.agent;
      return a && a.state !== 'done' && a.state !== 'dead' ? a : null;
    };
    const lead = alive(sq.leadId);
    const members = sq.memberIds.map(alive).filter((a): a is Agent => a !== null);
    if (!lead || members.length === 0) return;

    const now = Date.now();
    const toSquad = chance(0.4);
    const from = toSquad ? lead : pick(members);
    if (from.state === 'blocked') return;
    const subject = toSquad ? pick(SQUAD_ORDERS) : pick(SQUAD_REPORTS);

    const msg: AgentMessage = {
      id: newId('msg'),
      kind: toSquad ? 'handoff' : 'notice',
      scope: toSquad ? 'squad' : 'agent',
      fromAgentId: from.id, fromCallsign: from.callsign, fromProjectId: from.projectId,
      toAgentId: toSquad ? null : lead.id,
      toProjectId: null,
      toSquad: toSquad ? sq.name : null,
      subject, body: null, files: [],
      at: now, readBy: [], expiresAt: toSquad ? null : now + 900_000,
      answer: null, answeredAt: null, answeredBy: null,
    };
    this.messages.set(msg.id, msg);
    this.send({ t: 'message', machineId: this.spec.id, message: msg });
    this.feed('info', from,
      toSquad ? `→ squad:${sq.name}: ${subject}` : `→ ${lead.callsign}: ${subject}`);
  }

  private log(...args: unknown[]): void {
    if (!this.quiet) console.log(`[${this.spec.id}]`, ...args);
  }

  /* ── conexión ───────────────────────────────────────────────────── */

  connect(): void {
    if (this.stopped) return;
    const url = `${this.hubUrl}${PATHS.collector}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.machine.connectedAt = Date.now();
      this.send({ t: 'hello', v: PROTOCOL_VERSION, machine: this.machine, token: this.token });
      this.sendSnapshot();
      this.log('conectado');
    });

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as CommandFrame;
        if (frame.t === 'cmd') this.onCommand(frame.id, frame.cmd);
      } catch (err) {
        console.warn(`[${this.spec.id}] comando ilegible`, err);
      }
    });

    ws.on('close', (code) => {
      this.log('desconectado', code);
      this.ws = null;
      if (!this.stopped) setTimeout(() => this.connect(), int(1200, 4000));
    });

    ws.on('error', (err) => {
      if (!this.quiet) console.warn(`[${this.spec.id}] ws:`, (err as Error).message);
    });
  }

  private send(frame: CollectorFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch { /* se reconectará */ }
  }

  private ack(cmdId: string, ok: boolean, detail: string): void {
    this.send({ t: 'ack', cmdId, ok, detail });
  }

  sendSnapshot(): void {
    this.send({
      t: 'snapshot', machineId: this.spec.id,
      projects: this.projects,
      agents: [...this.agents.values()].map((l) => l.agent),
      keys: this.keys,
    });
    // Un artefacto es estado, no un evento: si el hub se reinició no se
    // enteraría de lo que ya se produjo hasta que alguien produjera otro.
    for (const a of this.artifacts.values()) {
      this.send({ t: 'artifact', machineId: this.spec.id, artifact: a });
    }
  }

  /* ── ciclo de vida ──────────────────────────────────────────────── */

  start(): void {
    this.connect();
    const every = (ms: number, fn: () => void): void => {
      const t = setInterval(fn, Math.max(30, ms / this.speed));
      t.unref?.();
      this.timers.push(t);
    };
    every(BEAT_INTERVAL_MS, () => this.beat());
    every(250, () => this.tick(250));
    every(1800, () => this.emitFeed());
    every(6500, () => this.emitTraffic());
    every(11_000, () => this.churnCollisions());
    every(9_000, () => this.emitSquadTraffic());
    this.timers.push();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { this.ws?.close(1000, 'fin'); } catch { /* da igual */ }
  }

  /**
   * Retirarse: llevarse lo suyo antes de cerrar el socket.
   *
   * Un collector de verdad que se apaga deja atrás sesiones que SIGUEN
   * existiendo en disco, así que el hub hace bien en conservarlas. Las de aquí
   * no existen en ninguna parte: cuando este proceso muere no queda nada a lo
   * que correspondan, y dejarlas es dejar basura con la que después hay que
   * pelearse a mano (298 agentes muertos y 11 que el hub aún creía vivos, la
   * última vez). Así que el mock se retira: `agent:gone` por cada uno, y antes
   * la retirada de las preguntas abiertas, que si no se quedan `pending` en la
   * cola del humano sin nadie que pueda leer la respuesta.
   *
   * Se espera al cierre del socket porque `process.exit` no espera a nadie: sin
   * eso los frames se quedan en el buffer y el apagado limpio no limpia nada.
   */
  async standDown(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { this.ws = null; return; }

    for (const local of this.agents.values()) {
      if (local.escalationId) this.withdraw(local, 'el arnés se apagó');
    }
    for (const id of this.agents.keys()) {
      this.send({ t: 'agent:gone', machineId: this.spec.id, id });
    }
    this.log(`retirados ${this.agents.size} agentes`);
    this.agents.clear();

    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 3000);
      ws.once('close', done);
      try { ws.close(1000, 'retirada'); } catch { done(); }
    });
    this.ws = null;
  }

  /** Corta el socket sin avisar: así se ve una máquina caer de verdad. */
  drop(): void {
    this.log('caos: cortando el socket');
    try { this.ws?.terminate(); } catch { /* ya estaba */ }
    this.ws = null;
  }

  reconnect(): void {
    if (this.ws || this.stopped) return;
    this.log('caos: reconectando');
    this.connect();
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private beat(): void {
    const live = [...this.agents.values()].filter((l) => ['thinking', 'working', 'booting'].includes(l.agent.state));
    this.machine.load = {
      sessions: this.agents.size,
      activeSessions: live.length,
      cpuPct: Math.max(2, Math.min(99, (this.machine.load.cpuPct ?? 20) + rnd(-6, 6) + live.length * 0.4)),
      memPct: Math.max(10, Math.min(96, (this.machine.load.memPct ?? 40) + rnd(-2, 2))),
    };
    this.send({ t: 'beat', machineId: this.spec.id, at: Date.now(), load: this.machine.load });
  }

  /* ── agentes ────────────────────────────────────────────────────── */

  private callsign(): string {
    const letter = CALLSIGN_LETTERS[this.callsignSeq % CALLSIGN_LETTERS.length] ?? 'K';
    const num = 1 + Math.floor(this.callsignSeq / CALLSIGN_LETTERS.length);
    this.callsignSeq += 1;
    return `${letter}${num}`;
  }

  private spawn(
    parent: Agent | null, depth: number, projectId?: string, mission?: string,
    squad?: { name: string; lead: boolean } | null,
  ): Agent {
    const project = projectId
      ? this.projects.find((p) => p.id === projectId) ?? pick(this.projects)
      : (parent ? this.projects.find((p) => p.id === parent.projectId) ?? pick(this.projects) : pick(this.projects));
    const now = Date.now();
    const agent: Agent = {
      id: newId('sess'),
      machineId: this.spec.id,
      projectId: project.id,
      title: pick(TITLES),
      callsign: this.callsign(),
      runtime: 'claude',
      state: 'booting',
      block: null,
      parentId: parent?.id ?? null,
      depth,
      childIds: [],
      mission: mission ?? (parent ? `Subtarea: ${pick(TITLES).toLowerCase()}` : pick(MISSIONS)),
      squad: squad?.name ?? null,
      lead: squad?.lead === true,
      model: pick(['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']),
      tool: null,
      toolDetail: null,
      lastPrompt: pick(MISSIONS),
      lastSay: null,
      startedAt: now - int(0, 900_000),
      updatedAt: now,
      uptimeMs: 0,
      metrics: {
        costUSD: rnd(0.01, 1.4), inputTokens: int(2_000, 400_000), outputTokens: int(500, 40_000),
        cacheReadTokens: int(0, 900_000), thinkingTokens: int(0, 12_000), tokensPerSec: 0,
        linesAdded: int(0, 600), linesRemoved: int(0, 300), toolCalls: int(1, 180),
        toolDurationMs: int(1_000, 900_000), apiDurationMs: int(1_000, 600_000), turns: int(1, 60),
      },
      background: chance(0.35),
      shortId: null,
    };
    if (agent.background) agent.shortId = Math.random().toString(36).slice(2, 6);

    this.agents.set(agent.id, {
      agent, dwell: rnd(600, 4_000), escalationId: null,
      spawnBudget: depth === 0 ? int(0, 3) : 0,
    });
    project.sessionIds = [...project.sessionIds, agent.id];

    if (parent) {
      parent.childIds = [...parent.childIds, agent.id];
      this.send({ t: 'agent', machineId: this.spec.id, id: parent.id, patch: { childIds: parent.childIds } });
    }
    return agent;
  }

  /** El motor: transiciones de estado con tiempos de permanencia distintos. */
  /**
   * Tráfico entre agentes.
   *
   * Un `ask` sin responder deja bloqueado a quien lo manda con `kind:'peer'`,
   * que es lo que forma las cadenas de espera que el mapa dibuja. Sin eso el
   * mapa sólo tendría linaje, y el linaje no es una cadena: nadie espera a
   * nadie por haber sido lanzado.
   */
  private emitTraffic(): void {
    const live = [...this.agents.values()]
      .map((l) => l.agent)
      .filter((a) => a.state !== 'done' && a.state !== 'dead');
    if (live.length < 2) return;

    const from = pick(live);
    // Un agente ya bloqueado no manda nada; está parado.
    if (from.state === 'blocked') return;

    const t = pick(TRAFFIC);
    // Un tercio del tráfico cruza de proyecto: es el caso interesante y el que
    // ninguna herramienta muestra hoy.
    const crossProject = chance(0.35);
    const candidates = live.filter((a) =>
      a.id !== from.id && (crossProject ? a.projectId !== from.projectId : a.projectId === from.projectId));
    if (candidates.length === 0) return;
    const to = pick(candidates);

    const msg: AgentMessage = {
      id: newId('msg'),
      kind: t.kind, scope: 'agent',
      fromAgentId: from.id, fromCallsign: from.callsign, fromProjectId: from.projectId,
      toAgentId: to.id, toProjectId: null, toSquad: null,
      subject: t.subject, body: null, files: t.files ? [...t.files] : [],
      at: Date.now(), readBy: [], expiresAt: t.kind === 'notice' ? Date.now() + 900_000 : null,
      answer: null, answeredAt: null, answeredBy: null,
    };
    this.messages.set(msg.id, msg);
    this.send({ t: 'message', machineId: this.spec.id, message: msg });

    if (t.kind === 'ask') {
      from.state = 'blocked';
      from.block = {
        kind: 'peer', summary: t.subject,
        messageId: msg.id, waitingOn: to.id, since: Date.now(),
      };
      from.updatedAt = Date.now();
      this.send({
        t: 'agent', machineId: this.spec.id, id: from.id,
        patch: { state: from.state, block: from.block, updatedAt: from.updatedAt },
      });
      this.feed('warn', from, `espera a ${to.callsign}: ${t.subject}`);
    } else {
      this.feed('info', from, `→ ${to.callsign}: ${t.subject}`);
    }

    // Alguna se contesta sola, o las cadenas crecerían para siempre.
    for (const [id, m] of this.messages) {
      if (m.kind !== 'ask' || m.answer !== null) continue;
      if (Date.now() - m.at < 20_000 || !chance(0.4)) continue;
      m.answer = 'Sí, ya está hecho.';
      m.answeredAt = Date.now();
      m.answeredBy = m.toAgentId;
      this.send({ t: 'message', machineId: this.spec.id, message: m });
      const waiter = this.agents.get(m.fromAgentId)?.agent;
      if (waiter && waiter.block?.messageId === id) {
        waiter.block = null;
        waiter.state = 'working';
        waiter.updatedAt = Date.now();
        this.send({
          t: 'agent', machineId: this.spec.id, id: waiter.id,
          patch: { state: 'working', block: null, updatedAt: waiter.updatedAt },
        });
      }
    }
  }

  /**
   * Colisiones de archivo. Dos agentes vivos escribiendo lo mismo — el fallo
   * que nadie nota hasta que el trabajo del segundo desaparece.
   */
  private churnCollisions(): void {
    // Primero limpia las que ya no son ciertas.
    for (const [id, c] of this.collisions) {
      const alive = c.agentIds.filter((aid) => {
        const a = this.agents.get(aid)?.agent;
        return a && a.state !== 'done' && a.state !== 'dead';
      });
      if (alive.length >= 2 && chance(0.7)) continue;
      this.collisions.delete(id);
      this.send({ t: 'collision:clear', machineId: this.spec.id, id });
    }

    if (this.collisions.size >= 2 || !chance(0.45)) return;

    const live = [...this.agents.values()].map((l) => l.agent)
      .filter((a) => a.state === 'working');
    // Del mismo proyecto: dos agentes en repos distintos no comparten archivo.
    const byProject = new Map<string, typeof live>();
    for (const a of live) {
      const list = byProject.get(a.projectId);
      if (list) list.push(a); else byProject.set(a.projectId, [a]);
    }
    const pair = [...byProject.values()].find((l) => l.length >= 2);
    if (!pair) return;

    // Padre e hijo comparten worktree por diseño; eso no es una colisión.
    const a1 = pair[0]!;
    const a2 = pair.find((x) => x.id !== a1.id && x.parentId !== a1.id && a1.parentId !== x.id);
    if (!a2) return;

    const c: Collision = {
      id: newId('col'), path: pick(HOT_FILES),
      projectId: a1.projectId, machineId: this.spec.id,
      agentIds: [a1.id, a2.id],
      firstSeen: Date.now(), lastSeen: Date.now(), acknowledged: false,
    };
    this.collisions.set(c.id, c);
    this.send({ t: 'collision', machineId: this.spec.id, collision: c });
    this.feed('alert', a1, `colisión con ${a2.callsign} en ${c.path}`);
  }

  private tick(dtBase: number): void {
    const dt = dtBase * this.speed;
    for (const local of [...this.agents.values()]) {
      const a = local.agent;
      // Un decorado no vive: ni gasta, ni transiciona, ni lo recicla nadie.
      if (local.pinned) continue;
      a.uptimeMs += dt;

      if (a.state === 'working' || a.state === 'thinking') {
        // Los números tienen que ser creíbles: un agente escribiendo código
        // ronda 20-90 tok/s y quema céntimos, no dólares, por minuto.
        const tps = a.state === 'thinking' ? rnd(12, 55) : rnd(20, 95);
        a.metrics.tokensPerSec = Math.round(tps * 10) / 10;
        const outDelta = Math.round((tps * dt) / 1000);
        a.metrics.outputTokens += outDelta;
        a.metrics.inputTokens += Math.round(outDelta * rnd(3, 12));
        a.metrics.cacheReadTokens += Math.round(outDelta * rnd(10, 60));
        a.metrics.costUSD += outDelta * 0.000_015 + rnd(0, 0.000_2);
        if (a.state === 'working') a.metrics.toolDurationMs += dt;
        else a.metrics.apiDurationMs += dt;
      } else if (a.metrics.tokensPerSec !== 0) {
        a.metrics.tokensPerSec = 0;
      }

      local.dwell -= dt;
      if (local.dwell > 0) {
        // Aun sin transición, un agente trabajando emite ruido: es lo que hace
        // que el coalescing del hub tenga algo que colapsar.
        if ((a.state === 'working' || a.state === 'thinking') && chance(0.25)) {
          this.send({
            t: 'agent', machineId: this.spec.id, id: a.id,
            patch: { metrics: a.metrics, uptimeMs: a.uptimeMs, updatedAt: Date.now() },
          });
        }
        continue;
      }
      this.transition(local);
    }
  }

  private transition(local: Local): void {
    const a = local.agent;
    const from = a.state;
    let next: State = from;

    switch (from) {
      case 'booting':
        next = 'thinking';
        local.dwell = rnd(800, 5_000);
        break;
      case 'thinking':
        if (chance(0.08)) next = 'idle';
        else if (chance(0.06)) next = 'blocked';
        else next = 'working';
        local.dwell = rnd(1_500, 14_000);
        break;
      case 'working':
        if (chance(0.10)) next = 'blocked';
        else if (chance(0.07)) next = 'idle';
        else if (chance(0.03)) next = 'done';
        else next = 'thinking';
        local.dwell = rnd(900, 9_000);
        break;
      case 'blocked':
        // Un bloqueo espera; sólo se resuelve solo si nadie contesta en mucho.
        local.dwell = rnd(8_000, 40_000);
        if (chance(0.25)) {
          next = 'working';
          if (local.escalationId) this.withdraw(local, 'el agente lo resolvió por su cuenta');
          a.block = null;
        }
        break;
      case 'idle':
        if (chance(0.35)) next = 'thinking';
        else if (chance(0.08)) next = 'done';
        local.dwell = rnd(4_000, 25_000);
        break;
      case 'done':
      case 'dead':
        // Los terminados se van reciclando para que la flota no se apague.
        local.dwell = rnd(20_000, 60_000);
        if (chance(0.5)) { this.retire(local); return; }
        break;
    }

    // Sin cambio de estado no hay nada que contar: un bloqueo que sigue
    // bloqueado no debe generar tráfico.
    if (next === from) return;
    this.enter(local, next);
  }

  private enter(local: Local, next: State): void {
    const a = local.agent;
    a.state = next;
    a.updatedAt = Date.now();

    if (next === 'working') {
      const tool = pick(['Bash', 'Edit', 'Read', 'Task', 'WebSearch', 'Grep', 'Write', 'WebFetch']);
      a.tool = tool;
      a.toolDetail = this.toolDetail(tool);
      a.metrics.toolCalls += 1;
      // Un `Write` sobre algo que se mira produce un artefacto de verdad, igual
      // que lo haría la detección del collector real sobre el transcript.
      if (tool === 'Write' && chance(0.5)) this.produceArtifact(a);
      if (tool === 'Task' && local.spawnBudget > 0 && a.depth < 2) {
        local.spawnBudget -= 1;
        const child = this.spawn(a, a.depth + 1, a.projectId, a.toolDetail ?? undefined);
        this.send({ t: 'agent:new', machineId: this.spec.id, agent: child });
        this.feed('info', a, `lanzó a ${child.callsign}: ${child.mission ?? ''}`);
      }
    } else {
      a.tool = null;
      a.toolDetail = null;
    }

    if (next === 'thinking' && chance(0.5)) {
      a.lastSay = pick(SAYS);
      a.metrics.turns += 1;
    }

    if (next === 'blocked') {
      if (chance(0.55)) {
        // Escalación: el agente pregunta al humano.
        const q = pick(QUESTIONS);
        const esc: Escalation = {
          id: newId('esc'), agentId: a.id, projectId: a.projectId, machineId: this.spec.id,
          question: q.q, context: q.ctx, options: q.options, optionsOnly: chance(0.3),
          urgency: q.urgency, status: 'pending', ceoAttempt: chance(0.4) ? {
            answer: 'No tengo contexto suficiente para decidir esto.',
            confidence: rnd(0.1, 0.45),
            reason: 'La respuesta depende de una preferencia del humano, no del repositorio.',
          } : null,
          answer: null, answeredBy: null, rememberAs: null,
          askedAt: Date.now(), answeredAt: null,
          expiresAt: Date.now() + int(120, 900) * 1000,
        };
        this.escalations.set(esc.id, esc);
        local.escalationId = esc.id;
        a.block = { kind: 'question', summary: q.q, escalationId: esc.id, since: Date.now() };
        this.send({ t: 'escalation', machineId: this.spec.id, escalation: esc });
        this.feed('alert', a, `escaló: ${q.q}`);
      } else {
        a.block = { kind: 'permission', summary: pick(PERMISSIONS), since: Date.now() };
        this.feed('warn', a, `pide permiso: ${a.block.summary}`);
      }
    } else if (a.block) {
      a.block = null;
    }

    if (next === 'done' || next === 'dead') {
      a.metrics.tokensPerSec = 0;
      this.feed(next === 'dead' ? 'alert' : 'info', a, next === 'dead' ? 'murió' : 'terminó');
      if (local.escalationId) this.withdraw(local, 'el agente terminó');
    }

    this.send({
      t: 'agent', machineId: this.spec.id, id: a.id,
      patch: {
        state: a.state, block: a.block, tool: a.tool, toolDetail: a.toolDetail,
        lastSay: a.lastSay, metrics: a.metrics, updatedAt: a.updatedAt, uptimeMs: a.uptimeMs,
        childIds: a.childIds,
      },
    });
  }

  /**
   * Registra uno de los archivos reales del directorio temporal a nombre de un
   * agente. Público porque una prueba necesita provocarlo cuando le toca, y no
   * cuando el azar quiera.
   */
  produceArtifact(agent?: Agent): Artifact | null {
    const files = fakeArtifactFiles();
    if (files.length === 0) return null;
    const a = agent ?? [...this.agents.values()]
      .map((l) => l.agent)
      .filter((x) => x.state !== 'done' && x.state !== 'dead')[0];
    if (!a) return null;
    const f = pick(files);
    let bytes = 0;
    try { bytes = statSync(f.file).size; } catch { return null; }

    // Mismo id para la misma ruta en la misma máquina, como el collector real:
    // regenerar la gráfica sustituye a la anterior en vez de duplicarla.
    const id = 'art_' + createHash('sha1').update(`${this.spec.id} ${f.file}`).digest('hex').slice(0, 16);
    const artifact: Artifact = {
      id,
      agentId: a.id,
      projectId: a.projectId,
      machineId: this.spec.id,
      kind: f.kind,
      source: 'declared',
      path: f.file,
      title: f.title,
      url: null,
      bytes,
      width: f.file.endsWith('.png') ? (f.file.includes('96') ? 96 : 64) : null,
      height: f.file.endsWith('.png') ? (f.file.includes('96') ? 96 : 64) : null,
      at: Date.now(),
      open: false,
      placement: null,
    };
    this.artifacts.set(id, artifact);
    this.send({ t: 'artifact', machineId: this.spec.id, artifact });
    this.feed('info', a, `produjo ${f.kind}: ${f.title}`);
    return artifact;
  }

  private toolDetail(tool: string): string {
    switch (tool) {
      case 'Bash': return pick(BASH);
      case 'Edit':
      case 'Read':
      case 'Write': return pick(FILES);
      case 'Grep': return `rg "${pick(['PatchOp', 'rollup', 'escalation', 'BEAT_TIMEOUT', 'markMachineOffline'])}"`;
      case 'WebSearch':
      case 'WebFetch': return pick(SEARCHES);
      case 'Task': return `subagente: ${pick(TITLES).toLowerCase()}`;
      default: return pick(FILES);
    }
  }

  private retire(local: Local): void {
    const a = local.agent;
    this.agents.delete(a.id);
    const project = this.projects.find((p) => p.id === a.projectId);
    if (project) project.sessionIds = project.sessionIds.filter((id) => id !== a.id);
    this.send({ t: 'agent:gone', machineId: this.spec.id, id: a.id });
    // La flota se repone sola: la consola nunca se queda vacía.
    const fresh = this.spawn(null, 0);
    this.send({ t: 'agent:new', machineId: this.spec.id, agent: fresh });
  }

  private withdraw(local: Local, reason: string): void {
    const id = local.escalationId;
    if (!id) return;
    const esc = this.escalations.get(id);
    local.escalationId = null;
    if (!esc || esc.status === 'answered') return;
    esc.status = 'withdrawn';
    this.send({ t: 'escalation:withdraw', machineId: this.spec.id, id, reason });
  }

  private feed(level: FeedItem['level'], a: Agent | null, text: string): void {
    const project = a ? this.projects.find((p) => p.id === a.projectId) : undefined;
    const item: FeedItem = {
      id: newId('f'), at: Date.now(), level,
      source: a && project ? `${project.code}/${a.callsign}` : this.spec.id,
      text,
      ...(a ? { agentId: a.id, projectId: a.projectId } : {}),
    };
    this.send({ t: 'feed', machineId: this.spec.id, items: [item] });
  }

  /** Ruido de fondo del HUD: lo que un collector real vería pasar. */
  private emitFeed(): void {
    const locals = [...this.agents.values()];
    if (locals.length === 0) return;
    const local = pick(locals);
    const a = local.agent;
    const lines: [FeedItem['level'], string][] = [
      ['trace', `${a.tool ?? 'API'} ${a.toolDetail ?? 'respuesta recibida'}`],
      ['info', pick(SAYS)],
      ['trace', `${a.metrics.tokensPerSec.toFixed(0)} tok/s · $${a.metrics.costUSD.toFixed(3)}`],
      ['warn', 'reintentando: 429 del API, backoff 2s'],
      ['info', `git: ${int(1, 9)} archivos modificados en ${pick(this.projects).name}`],
    ];
    const [level, text] = pick(lines);
    this.feed(level, a, text);

    if (chance(0.05)) {
      const project = pick(this.projects);
      project.gitDirty = !project.gitDirty;
      this.send({
        t: 'project', machineId: this.spec.id, id: project.id,
        patch: { gitDirty: project.gitDirty, gitBranch: project.gitBranch },
      });
    }
  }

  /* ── comandos entrantes ─────────────────────────────────────────── */

  private onCommand(cmdId: string, cmd: Command): void {
    switch (cmd.k) {
      case 'resync':
        this.sendSnapshot();
        this.ack(cmdId, true, 'snapshot enviado');
        return;

      case 'spawn': {
        const parent = cmd.parentId ? this.agents.get(cmd.parentId)?.agent ?? null : null;
        const squad = cmd.squad ? { name: cmd.squad, lead: cmd.lead === true } : null;
        const child = this.spawn(
          parent, parent ? parent.depth + 1 : 0, cmd.projectId, cmd.mission, squad,
        );
        child.lastPrompt = cmd.prompt;
        child.background = cmd.background;
        this.send({ t: 'agent:new', machineId: this.spec.id, agent: child });
        this.feed('info', child, `lanzado por la consola: ${cmd.mission}`);
        // El id va en el ack, no sólo en el frame: quien acaba de lanzar a un
        // líder lo necesita para lanzarle miembros con `parentId`.
        const data: SpawnAck = {
          agentId: child.id, callsign: child.callsign, shortId: child.shortId,
        };
        this.send({
          t: 'ack', cmdId, ok: true, detail: `agente ${child.callsign} lanzado`, data,
        });
        return;
      }

      case 'say': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.agent.lastPrompt = cmd.text;
        local.dwell = 0;
        this.enter(local, 'thinking');
        this.ack(cmdId, true, 'entregado');
        return;
      }

      case 'permit': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.agent.block = null;
        local.dwell = 0;
        this.enter(local, cmd.allow ? 'working' : 'idle');
        this.ack(cmdId, true, cmd.allow ? 'permitido' : 'denegado');
        return;
      }

      case 'answer': {
        const esc = this.escalations.get(cmd.escalationId);
        if (!esc) { this.ack(cmdId, false, 'escalación desconocida'); return; }
        esc.status = 'answered';
        esc.answer = cmd.answer;
        esc.answeredBy = 'human';
        esc.answeredAt = Date.now();
        esc.rememberAs = cmd.rememberAs;
        this.send({ t: 'escalation', machineId: this.spec.id, escalation: esc });
        const local = this.agents.get(esc.agentId);
        if (local) {
          local.escalationId = null;
          local.agent.block = null;
          local.dwell = 0;
          this.enter(local, 'working');
          this.feed('info', local.agent, `respuesta recibida: ${cmd.answer.slice(0, 60)}`);
        }
        this.ack(cmdId, true, 'entregada al agente');
        return;
      }

      case 'stop': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.dwell = 0;
        this.enter(local, 'done');
        this.ack(cmdId, true, 'detenido');
        return;
      }

      case 'resume': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.dwell = 0;
        this.enter(local, 'thinking');
        this.ack(cmdId, true, 'reanudado');
        return;
      }

      case 'remove': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        this.agents.delete(cmd.agentId);
        this.send({ t: 'agent:gone', machineId: this.spec.id, id: cmd.agentId });
        this.ack(cmdId, true, 'eliminado');
        return;
      }

      case 'key:set': {
        // Un collector real guarda el valor en el llavero de la máquina y sólo
        // devuelve el descriptor. Aquí hacemos lo mismo: el valor muere aquí.
        const hint = cmd.value.slice(-4);
        const existing = this.keys.find((k) => k.projectId === cmd.projectId && k.name === cmd.name);
        if (existing) existing.hint = hint;
        else this.keys.push({ name: cmd.name, projectId: cmd.projectId, hint, addedAt: Date.now(), lastUsedAt: null, usedBy: [] });
        const project = this.projects.find((p) => p.id === cmd.projectId);
        if (project && !project.keyNames.includes(cmd.name)) {
          project.keyNames = [...project.keyNames, cmd.name];
          this.send({ t: 'project', machineId: this.spec.id, id: project.id, patch: { keyNames: project.keyNames } });
        }
        this.sendSnapshot();
        this.ack(cmdId, true, `clave ${cmd.name} guardada en la máquina`);
        return;
      }

      case 'key:remove': {
        this.keys = this.keys.filter((k) => !(k.projectId === cmd.projectId && k.name === cmd.name));
        this.sendSnapshot();
        this.ack(cmdId, true, 'clave borrada');
        return;
      }

      case 'artifact:read': {
        // Lista blanca por id, igual que el collector real: una ruta que este
        // proceso no registró no se sirve, aunque exista en disco.
        const a = this.artifacts.get(cmd.artifactId);
        if (!a) { this.ack(cmdId, false, `artefacto desconocido: ${cmd.artifactId}`); return; }
        try {
          const buf = readFileSync(a.path);
          if (buf.length > MAX_ARTIFACT_BYTES) {
            this.ack(cmdId, false, `pesa ${buf.length}B, por encima del límite`);
            return;
          }
          this.send({
            t: 'ack', cmdId, ok: true, detail: 'artifact',
            data: { base64: buf.toString('base64'), mime: artifactMime(a.path), bytes: buf.length },
          });
        } catch (err) {
          this.ack(cmdId, false, `no pude leerlo: ${(err as Error).message}`);
        }
        return;
      }

      case 'logs': {
        const lines = Array.from({ length: Math.min(cmd.lines, 20) }, () => `$ ${pick(BASH)}`);
        this.send({ t: 'ack', cmdId, ok: true, detail: 'logs', data: { lines } });
        return;
      }

      case 'models:list': {
        /*
         * El catálogo de esta máquina, como lo daría `providerModels()`: los
         * alias de Claude Code y unos cuantos de Codex, cada uno diciendo si
         * su CLI está instalado. Lo pide el SETUP de AUTOMEJORA, que elige el
         * modelo de un agente que todavía no existe y por eso no puede
         * preguntarle a ninguna sesión.
         */
        this.send({
          t: 'ack', cmdId, ok: true, detail: 'models',
          data: [
            { runtime: 'claude', id: 'opus', label: 'Opus', installed: true },
            { runtime: 'claude', id: 'fable', label: 'Fable', installed: true },
            { runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true },
            { runtime: 'claude', id: 'haiku', label: 'Haiku', installed: true },
            { runtime: 'codex', id: 'gpt-5-codex', label: 'GPT-5 Codex', installed: false },
          ],
        });
        return;
      }

      default:
        this.ack(cmdId, false, 'comando no soportado por el collector falso');
    }
  }
}

/* ── orquestación ─────────────────────────────────────────────────── */

function readToken(): string {
  const flag = process.argv.find((a) => a.startsWith('--token='));
  if (flag) return flag.slice('--token='.length);
  const env = process.env['ORCA_TOKEN'];
  if (env) return env;
  try {
    return readFileSync(join(process.env['ORCA_HOME'] ?? join(homedir(), '.orca'), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export interface FakeFleetOptions {
  hub?: string;
  token?: string;
  chaos?: boolean;
  speed?: number;
  quiet?: boolean;
  /** Escala la topología hasta ~n agentes iniciales. Sin esto, los 20 de siempre. */
  agents?: number;
  /**
   * Preset de escuadrón: un líder y tres hijos con la misma etiqueta, que se
   * hablan por `scope:'squad'`. `true` usa el nombre por defecto. Va siempre en
   * la primera máquina, para que quien lo busque sepa dónde mirar.
   */
  squad?: string | boolean;
  /** Cuántos miembros bajo el líder. Por defecto 3. */
  squadSize?: number;
}

/** Nombre del escuadrón del preset cuando nadie pide otro. */
export const DEFAULT_SQUAD = 'audit-01';

export function startFakeFleet(
  opts: FakeFleetOptions = {},
): { machines: FakeMachine[]; stop: () => void; standDown: () => Promise<void> } {
  const hub = opts.hub ?? `ws://localhost:${PORTS.hub}`;
  const token = opts.token ?? readToken();
  const speed = opts.speed ?? 1;
  const quiet = opts.quiet ?? false;

  const specs = scaleFleet(opts.agents ?? 0);
  const squadName = opts.squad === true ? DEFAULT_SQUAD
    : typeof opts.squad === 'string' && opts.squad ? opts.squad : null;
  const machines = specs.map((spec, i) => new FakeMachine(spec, {
    hub, token, quiet, speed,
    squad: squadName !== null && i === 0
      ? { name: squadName, size: opts.squadSize ?? 3 } : null,
  }));
  for (const m of machines) m.start();

  let chaosTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.chaos) {
    if (!quiet) console.log('[caos] activado: las máquinas caerán y volverán solas');
    chaosTimer = setInterval(() => {
      const victim = pick(machines);
      if (victim.connected && chance(0.6)) {
        victim.drop();
        setTimeout(() => victim.reconnect(), int(3_000, 20_000));
      }
    }, 12_000);
    chaosTimer.unref?.();
  }

  return {
    machines,
    stop: () => {
      if (chaosTimer) clearInterval(chaosTimer);
      for (const m of machines) m.stop();
    },
    /** Retirar la flota entera del hub antes de irse. Ver `FakeMachine.standDown`. */
    standDown: async () => {
      if (chaosTimer) clearInterval(chaosTimer);
      await Promise.all(machines.map((m) => m.standDown()));
    },
  };
}

/* ── aislamiento ──────────────────────────────────────────────────── */

/**
 * A qué hub HTTP corresponde un hub ws. El mock habla ws; preguntar por el
 * mando es HTTP, y las dos cosas viven en el mismo puerto.
 */
export function httpFromWs(url: string): string {
  return url.replace(/^ws/, 'http').replace(/\/+$/, '');
}

/**
 * Qué clase de hub hay al otro lado.
 *
 * `reachable: false` cuando no contesta, y eso NO es permiso para entrar: no
 * saber qué hay ahí es exactamente el caso en el que no se arranca. `harness`
 * lo dice el hub sobre sí mismo (`/api/health`, ver src/shared/synthetic.ts);
 * un hub viejo que no publique el campo cuenta como real, que es la dirección
 * segura del error.
 */
export async function hubPosture(hubHttp: string): Promise<{
  reachable: boolean;
  harness: boolean;
  capcom: { callsign: string; machineId: string } | null;
}> {
  try {
    const res = await fetch(`${hubHttp}/api/health`, { signal: AbortSignal.timeout(2500) });
    const health = await res.json() as {
      harness?: boolean;
      capcom?: { callsign?: string; machineId?: string } | null;
    };
    const cap = health.capcom;
    return {
      reachable: true,
      harness: health.harness === true,
      capcom: cap ? { callsign: cap.callsign ?? '?', machineId: cap.machineId ?? '?' } : null,
    };
  } catch { return { reachable: false, harness: false, capcom: null }; }
}

/**
 * ¿Manda alguien en ese hub? `null` cuando no, y también cuando no se puede
 * preguntar: un hub que no contesta no tiene un CAPCOM que proteger.
 */
export async function liveCapcom(
  hubHttp: string,
): Promise<{ callsign: string; machineId: string } | null> {
  return (await hubPosture(hubHttp)).capcom;
}

/**
 * La puerta del mock, como función pura: qué hacer dado lo que hay al otro
 * lado y lo que pidió la línea de comandos.
 *
 * Está separada de `main` para que la prueba pueda interrogarla sin levantar
 * nada, y porque la regla que impone es la que falló la última vez y merece
 * poder leerse entera de un vistazo. El hub tiene la suya —rechaza el `hello`
 * de una máquina sintética si no se declara de pruebas— y ésta es la de este
 * lado: el mismo criterio, dicho antes y con un mensaje que explica la salida.
 */
export function doorVerdict(o: {
  reachable: boolean;
  harness: boolean;
  capcom: { callsign: string } | null;
  anyway: boolean;
}): { go: true } | { go: false; why: string[] } {
  if (!o.reachable) {
    return { go: false, why: [
      'ese hub no contesta a /api/health, así que no sé qué es.',
      'no arranco a ciegas: usa --isolated para un mundo propio.',
    ] };
  }
  /*
   * La regla nueva, y la razón de todo esto.
   *
   * `--anyway` sigue existiendo para lo que se inventó —un hub de pruebas que
   * ya tiene un CAPCOM dentro— pero dejó de ser una llave maestra. Contra un
   * hub que no se declara de pruebas no abre nada: el 2026-09-07 abrió, y
   * fueron ~1.330 agentes y siete proyectos falsos en la consola del operador.
   * Aunque alguien lo fuerce aquí, el hub cierra la conexión igual.
   */
  if (!o.harness) {
    return { go: false, why: [
      'ese hub NO se declara de pruebas, así que no admite máquinas sintéticas.',
      '--anyway no sirve para esto y el hub cerraría la conexión de todas formas.',
      'usa --isolated: levanta un hub propio, con su ORCA_HOME y su puerto.',
    ] };
  }
  if (o.capcom && !o.anyway) {
    return { go: false, why: [
      `ese hub de pruebas tiene mando vivo (${o.capcom.callsign}).`,
      'usa --isolated para un hub propio, o --anyway si de verdad quieres.',
    ] };
  }
  return { go: true };
}

/**
 * Un mundo propio: su `ORCA_HOME`, su puerto, su hub.
 *
 * Mismo aislamiento que `test/visual.ts --isolated` y por la misma razón: lo
 * que este proceso invente no tiene por qué aparecer en la consola de nadie.
 * El hub escribe su token dentro del `ORCA_HOME` temporal, así que se lee de
 * ahí y no del de la máquina.
 */
async function isolate(): Promise<{ hub: string; token: string; port: number; home: string }> {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { mkdtempSync, rmSync } = await import('node:fs');

  const home = mkdtempSync(join(tmpdir(), 'orca-mock-'));
  process.env['ORCA_HOME'] = home;
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });

  const root = new URL('..', import.meta.url).pathname;
  const child = spawn('npx', ['tsx', 'src/hub/server.ts'], {
    cwd: root, stdio: 'inherit',
    // `ORCA_HARNESS`: este hub nace para el arnés y es el único que admite
    // máquinas sintéticas. Es lo que lo distingue del de 4479, y va en el
    // entorno del proceso porque es lo único que no se puede pedir por el
    // cable. Ver src/shared/synthetic.ts.
    env: { ...process.env, ORCA_PORT: String(port), ORCA_HOME: home, [HARNESS_ENV]: '1' },
  });
  child.unref();
  process.on('exit', () => {
    // El hub de este mundo es nuestro, y su ORCA_HOME no contenía más que su
    // propio estado: los dos se van con nosotros. Igual que test/visual.ts.
    try { child.kill('SIGTERM'); } catch { /* ya no está */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* da igual */ }
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch { /* todavía no */ }
    if (Date.now() > deadline) throw new Error(`el hub aislado no arrancó en ${port}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`[fake] aislado: hub propio en ${port}, ORCA_HOME=${home}`);
  console.log(`[fake] la consola de este mundo: ORCA_PORT=${port} npx vite`);
  return { hub: `ws://127.0.0.1:${port}`, token: readToken(), port, home };
}

const runDirectly = (process.argv[1] ?? '').endsWith('fake-collector.ts');
if (runDirectly) {
  const hubFlag = process.argv.find((a) => a.startsWith('--hub='));
  const speedFlag = process.argv.find((a) => a.startsWith('--speed='));
  const agentsFlag = process.argv.find((a) => a.startsWith('--agents='));
  const squadFlag = process.argv.find((a) => a === '--squad' || a.startsWith('--squad='));

  const isolated = process.argv.includes('--isolated');
  const anyway = process.argv.includes('--anyway');
  const world = isolated
    ? await isolate()
    : { hub: hubFlag?.slice('--hub='.length) ?? `ws://localhost:${PORTS.hub}`, token: readToken() };

  /*
   * La puerta. Ver `doorVerdict`, que es donde está la regla.
   *
   * Un mundo hecho con `--isolated` no pasa por aquí: su hub acaba de nacer
   * con la marca puesta y no hay nada que preguntarle.
   */
  if (!isolated) {
    const posture = await hubPosture(httpFromWs(world.hub));
    const verdict = doorVerdict({ ...posture, anyway });
    if (!verdict.go) {
      console.error(`[fake] ${world.hub}: ${verdict.why[0]}`);
      for (const line of verdict.why.slice(1)) console.error(`[fake] ${line}`);
      process.exit(1);
    }
  }

  const fleet = startFakeFleet({
    squad: squadFlag === undefined ? false
      : squadFlag === '--squad' ? true : squadFlag.slice('--squad='.length) || true,
    hub: world.hub,
    token: world.token,
    chaos: process.argv.includes('--chaos'),
    speed: speedFlag ? Number(speedFlag.slice('--speed='.length)) || 1 : 1,
    agents: agentsFlag ? Number(agentsFlag.slice('--agents='.length)) || 0 : 0,
    quiet: process.argv.includes('--quiet'),
  });
  const total = fleet.machines.reduce((n, m) => n + m.spec.agents, 0);
  console.log(`[fake] ${fleet.machines.length} máquinas, ${total} agentes iniciales`);

  // Retirarse antes de morir, y sólo una vez: un segundo Ctrl-C no puede dejar
  // la retirada a medias, así que el segundo sale sin esperar.
  let leaving = false;
  const bye = (): void => {
    if (leaving) process.exit(0);
    leaving = true;
    void fleet.standDown().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
