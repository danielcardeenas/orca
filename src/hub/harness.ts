/**
 * Los procesos del arnés, vistos desde el hub.
 *
 * El complemento de la frontera. `shared/synthetic.ts` impide que una máquina
 * de fixture ENTRE; esto es lo que se hace con el proceso que la estaba
 * empujando, y hace falta porque un mock vivo vuelve a conectarse: purgar el
 * mundo sin pararlo primero es barrer mientras alguien sigue tirando arena.
 *
 * El 2026-09-07, cuando el mock apareció dentro del hub real, la única salida
 * fue que el operador tecleara el `kill` a mano: CAPCOM no podía. La respuesta
 * NO es darle a CAPCOM un `kill` genérico —el permiso más ancho para el
 * problema más estrecho— sino esto: una operación que sólo sabe reconocer los
 * tres programas del arnés y sólo mata los que apuntan a ESTE hub. Un `kill`
 * de shell habría podido con cualquier pid de la máquina; esto no puede con
 * ninguno que no sea del arnés, y esa diferencia es toda la seguridad.
 *
 * Lo que se reconoce, y por qué sólo esto:
 *
 *   test/fake-collector.ts   la flota sintética. Es lo que se coló.
 *   test/visual.ts           el arnés visual, que arranca una flota.
 *   test/field-stress.ts     el de rendimiento, que arranca varias.
 *
 * `test/run.ts` NO está en la lista a propósito: `npm test` no le mete nada al
 * hub real y matarlo sería tirar la verificación de otro agente.
 *
 * El caso impreciso, dicho en voz alta: `test/visual.ts` no lleva `--hub=`, así
 * que se le atribuye el puerto canónico y una purga sobre ese hub lo alcanza
 * aunque hubiera levantado el suyo. Se acepta a sabiendas —un visual colgado es
 * justo uno de los procesos que hay que poder terminar— y el que se aisló queda
 * fuera igual, que es el que de verdad no está molestando a nadie.
 */

import { execFileSync } from 'node:child_process';

import { PORTS } from '../shared/protocol.ts';

/** Los programas del arnés que meten máquinas sintéticas en un hub. */
export const HARNESS_SCRIPTS = [
  'test/fake-collector.ts',
  'test/visual.ts',
  'test/field-stress.ts',
] as const;

/**
 * Quién puede estar EJECUTANDO uno de esos scripts.
 *
 * El 2026-09-09 esta operación mató a un agente de la flota. La regla era
 * `command.includes('test/fake-collector.ts')` sobre la línea entera de `ps`, y
 * el agente estaba trabajando precisamente en el arnés: su brief citaba
 * `tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway`, y
 * ese texto viaja en su línea de comandos. Coincidió el script y coincidió el
 * puerto —los dos leídos de un PROMPT— y se le mandó SIGTERM al grupo.
 *
 * Una cadena que aparece en cualquier parte de la línea no dice nada: un
 * editor abriendo el archivo, un `grep`, un agente al que le hablan de él y
 * este mismo comentario en la pantalla de alguien encajan igual. Lo que sí
 * dice algo es la ESTRUCTURA: quién es el ejecutable, y en qué posición está
 * el script. Un intérprete corriendo el archivo es un hecho; el archivo
 * nombrado dentro de una frase es texto.
 *
 * Por eso la lista es blanca y corta. `claude`, `codex`, `grok`, `zsh`, `vim`,
 * `grep` y cualquier otro no están, y no por olvido: aunque lleven el nombre
 * del script en los argumentos, lo que tienen es una frase sobre él.
 *
 * Y por eso, además, la forma ENTERA se compara contra una lista de invocaciones
 * conocidas en vez de descartarse opción a opción. Se intentó lo segundo dos
 * veces —primero prohibiendo los módulos sueltos, después las opciones que no
 * ejecutan— y las dos veces quedaron formas fuera: `--eval=0` y `-e0` llevan su
 * valor pegado, y `--title` es una opción con valor que nadie había enumerado.
 * La lista de lo que node acepta no se puede completar desde aquí; la de lo que
 * ORCA arranca de verdad cabe en cinco líneas. Se reconoce esa, y **lo que no
 * encaje no se toca**.
 */

/** El ejecutable, para las formas cuya primera palabra ya decide. */
const NODE_EXE = /^node(?:\d+(?:\.\d+)*)?$/;

/**
 * El binario de `tsx` puesto como programa de node: `node .../node_modules/.bin/tsx`.
 * Es la forma que sale en `ps` en esta máquina cuando algo arranca por `tsx`.
 */
const TSX_BIN = /^tsx$/;

/**
 * Un módulo que se precarga: `.../tsx/dist/preflight.cjs`,
 * `file:///.../tsx/dist/loader.mjs`. Tiene que TERMINAR en `.cjs`, `.mjs` o
 * `.js` — nunca un `.ts`, y por tanto nunca uno de los scripts del arnés, que
 * es lo que hacía pasar por «cargador» a `--require test/fake-collector.ts`.
 */
const LOADER_VALUE = /\.(?:mjs|cjs|js)(?:[?#].*)?$/;

/** Las opciones de node que preceden a un módulo de carga, y sólo ésas. */
const LOADER_OPT = /^(?:-r|--require|--import|--loader|--experimental-loader)$/;

/**
 * Las formas de invocación que ORCA arranca de verdad, y el contrato completo
 * de lo que esta operación reconoce. Cada una está sacada de una línea de `ps`
 * observada en esta máquina o de un script de `package.json`:
 *
 *   tsx test/X.ts …                                    `npm run mock`, `npm run visual`
 *   node …/.bin/tsx test/X.ts …                        lo que `ps` enseña de lo anterior
 *   node --require …/preflight.cjs --import file://…/loader.mjs test/X.ts …
 *                                                      el proceso hijo real de tsx
 *   npx tsx test/X.ts …                                a mano
 *   npm exec [--] tsx test/X.ts …                      a mano
 *
 * El preámbulo admitido es exactamente eso: pares de opción de carga con su
 * módulo (juntos con `=` o separados), y opcionalmente el binario de `tsx`. NO
 * hay «cualquier otra opción»: `--check`, `--eval=0`, `-e0`, `--title`,
 * `--max-old-space-size=4096` y todo lo demás rompen la forma y la línea deja
 * de clasificar. Se pierde así algún arranque legítimo raro —queda vivo, y se
 * para a mano—, y a cambio ninguna frase que nombre el script puede colarse
 * por una opción que nadie enumeró.
 */
function skipPreamble(argv: readonly string[], from: number): number | null {
  let i = from;
  for (;;) {
    const tok = argv[i] ?? '';
    const eq = tok.indexOf('=');
    const opt = eq > 0 ? tok.slice(0, eq) : tok;
    if (LOADER_OPT.test(opt)) {
      // `--require=x.cjs` lleva el módulo pegado; `--require x.cjs`, en el
      // token siguiente. En los dos casos el valor tiene que ser un módulo.
      const value = eq > 0 ? tok.slice(eq + 1) : argv[++i] ?? '';
      if (!LOADER_VALUE.test(value)) return null;
      i++;
      continue;
    }
    return i;
  }
}

/**
 * ¿Es esta línea de `ps` una de las invocaciones conocidas del arnés?
 *
 * Devuelve el script y SUS argumentos —los tokens que van después—, que son los
 * únicos donde tiene sentido leer `--hub=` o `--isolated`: en la línea entera
 * los leería también de una frase, que es como se llegó a apuntar al hub real
 * desde el prompt de un agente.
 *
 * Es un reconocedor, no un parser: la línea encaja entera en una de las cinco
 * formas o no encaja. Una ruta con espacios rompe el troceo y no clasifica; una
 * opción que no esté en el contrato, tampoco. Es el lado seguro del error: un
 * proceso del arnés que no se reconoce se queda vivo, y eso se arregla a mano;
 * uno de otro que sí se reconoce se muere.
 */
export function harnessInvocation(command: string): { script: string; args: string[] } | null {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length < 2) return null;
  const exe = (argv[0] ?? '').split('/').pop() ?? '';

  let i: number | null = null;
  if (TSX_BIN.test(exe)) {
    // `tsx test/X.ts`: el script va justo detrás, sin nada en medio.
    i = 1;
  } else if (NODE_EXE.test(exe)) {
    // `node [pares de carga] [.../.bin/tsx] test/X.ts`.
    i = skipPreamble(argv, 1);
    if (i !== null && TSX_BIN.test((argv[i] ?? '').split('/').pop() ?? '')) i++;
  } else if (exe === 'npx' || exe === 'npm') {
    // `npx tsx test/X.ts` y `npm exec [--] tsx test/X.ts`.
    i = 1;
    if (exe === 'npm') {
      if (argv[i] !== 'exec' && argv[i] !== 'x') return null;
      i++;
    }
    if (argv[i] === '--') i++;
    if (!TSX_BIN.test((argv[i] ?? '').split('/').pop() ?? '')) return null;
    i++;
  }
  if (i === null) return null;

  const tok = argv[i] ?? '';
  const script = HARNESS_SCRIPTS.find((s) => tok === s || tok.endsWith(`/${s}`));
  if (!script) return null;
  return { script, args: argv.slice(i + 1) };
}

export interface HarnessProc {
  pid: number;
  /** Cuál de `HARNESS_SCRIPTS` es. */
  script: string;
  /** La línea de comandos, recortada, para que quien lo lea reconozca lo que murió. */
  command: string;
}

/**
 * Qué procesos del arnés apuntan a este hub, leído de la salida de `ps`.
 *
 * Puro y con la salida de `ps` como entrada para que se pueda probar sin
 * matar nada, que en una función cuyo trabajo es matar cosas no es un detalle
 * de estilo.
 *
 * Tres condiciones, y las tres tienen que darse:
 *
 *  1. la línea es un intérprete EJECUTANDO uno de los tres programas del arnés
 *     (`harnessInvocation`), no una que los nombre;
 *  2. sus argumentos —los del script, no los de la línea— no llevan
 *     `--isolated`, porque ése ya tiene su propio hub y su propio `ORCA_HOME`
 *     y no está tocando a nadie;
 *  3. apunta a NUESTRO puerto — el `--hub=` de esos mismos argumentos, o el
 *     canónico cuando no lo dice, que es el defecto del mock.
 *
 * Que (2) y (3) se lean sólo de los argumentos del script es la mitad de la
 * corrección del 2026-09-09: leídos de la línea entera, el prompt de un agente
 * podía declarar el puerto del hub real y traerse la purga encima.
 *
 * Y nunca nosotros mismos ni nuestro padre: el hub puede haberlo arrancado el
 * propio arnés, y suicidarse en mitad de una purga no es contención.
 */
export function harnessProcs(
  psOutput: string,
  o: { hubPort: number; exclude?: readonly number[] },
): HarnessProc[] {
  const exclude = new Set(o.exclude ?? []);
  const out: HarnessProc[] = [];
  for (const raw of psOutput.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2] ?? '';
    if (!Number.isFinite(pid) || pid <= 1 || exclude.has(pid)) continue;

    const inv = harnessInvocation(command);
    if (!inv) continue;
    if (inv.args.some((a) => a === '--isolated')) continue;

    const hub = inv.args.map((a) => /^--hub=(\S+)$/.exec(a)).find(Boolean);
    const port = hub ? portOf(hub[1] ?? '') : PORTS.hub;
    if (port !== o.hubPort) continue;
    const script = inv.script;

    out.push({ pid, script, command: command.length > 300 ? `${command.slice(0, 297)}...` : command });
  }
  return out;
}

/** El puerto de una url ws/http, o el canónico del hub si no lo lleva. */
function portOf(url: string): number {
  const m = /:(\d+)(\/|$)/.exec(url);
  return m ? Number(m[1]) : PORTS.hub;
}

/** La foto de los procesos de la máquina. Aislado para poder inyectarla en pruebas. */
export function snapshotPs(): string {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch {
    // Sin `ps` no se mata nada; la purga del mundo sigue siendo útil por sí sola.
    return '';
  }
}

export interface StoppedProc extends HarnessProc {
  /**
   * `term` si se fue con SIGTERM, `kill` si hizo falta SIGKILL, `gone` si ya
   * no estaba, y `changed` si al ir a señalarlo ese pid ya era otro proceso:
   * no se le mandó nada. Se informa en vez de callarlo, porque un pid que
   * cambia entre la foto y la señal es justo la forma de matar a un tercero.
   */
  how: 'term' | 'kill' | 'gone' | 'changed';
}

/** Lo que hace falta saber de un pid justo antes de señalarlo. */
export interface ProcIdentity {
  /** Su línea de comandos ahora, no la de la foto. */
  command: string;
  /** Su grupo de proceso. Sólo se señala al grupo si el pid ES el grupo. */
  pgid: number;
}

/**
 * Quién es el pid EN ESTE INSTANTE. Una segunda lectura, deliberadamente
 * separada de la foto: entre una y otra el proceso puede haberse ido y el
 * número puede estar reutilizado por cualquiera.
 */
export function identify(pid: number): ProcIdentity | null {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    if (!m) return null;
    return { pgid: Number(m[1]), command: (m[2] ?? '').trim() };
  } catch {
    return null;
  }
}

/**
 * Parar los procesos del arnés que apuntan a este hub.
 *
 * SIGTERM primero: el mock tiene retirada ordenada —se lleva sus agentes y sus
 * preguntas antes de morir— y dársela deja menos que purgar después. SIGKILL
 * sólo para el que la ignore. Al grupo de proceso cuando se puede, porque
 * `npx` bifurca y señalar sólo al envoltorio deja la flota viva, que es
 * exactamente el error que ya se cometió una vez (ver test/visual.ts).
 */
export async function stopHarnessProcs(o: {
  hubPort: number;
  ps?: string;
  graceMs?: number;
  /** Inyectables para poder probar la señal sin mandar ninguna. */
  deps?: {
    identify?: (pid: number) => ProcIdentity | null;
    send?: (target: number, sig: NodeJS.Signals) => void;
  };
}): Promise<StoppedProc[]> {
  const idOf = o.deps?.identify ?? identify;
  const send = o.deps?.send ?? ((target: number, sig: NodeJS.Signals) => { process.kill(target, sig); });
  const found = harnessProcs(o.ps ?? snapshotPs(), {
    hubPort: o.hubPort,
    exclude: [process.pid, process.ppid],
  });
  if (found.length === 0) return [];

  /*
   * Segunda comprobación, justo antes de la señal y sobre el proceso vivo.
   *
   * La foto de `ps` y el momento de matar no son el mismo instante, y un pid
   * libre lo hereda cualquiera. Así que se vuelve a leer el pid y se le vuelve
   * a aplicar la MISMA regla: si lo que hay ahí ya no es una invocación del
   * arnés contra este hub, no se le manda nada. Una regla usada dos veces vale
   * más que dos reglas parecidas.
   */
  const targets: { p: HarnessProc; leader: boolean }[] = [];
  const skipped: StoppedProc[] = [];
  for (const p of found) {
    const now = idOf(p.pid);
    if (!now) { skipped.push({ ...p, how: 'gone' }); continue; }
    const still = harnessProcs(`${p.pid} ${now.command}`, { hubPort: o.hubPort });
    if (still.length === 0) { skipped.push({ ...p, how: 'changed', command: now.command.slice(0, 300) }); continue; }
    /*
     * Al grupo SÓLO si este pid es el grupo. Señalar `-pid` de un proceso que
     * no lo lidera alcanza a todo su grupo —el pane de tmux de un agente, su
     * shell, sus hermanos—, que es daño que nadie pidió: aquí se vino a parar
     * un proceso, no una sesión.
     */
    targets.push({ p, leader: now.pgid === p.pid });
  }
  if (targets.length === 0) return skipped;

  for (const t of targets) signalTo(send, t, 'SIGTERM');
  await new Promise((r) => setTimeout(r, o.graceMs ?? 1500));

  return [...skipped, ...targets.map(({ p, leader }) => {
    if (!alive(p.pid)) return { ...p, how: 'term' as const };
    signalTo(send, { p, leader }, 'SIGKILL');
    return { ...p, how: alive(p.pid) ? 'gone' as const : 'kill' as const };
  })];
}

/**
 * Al grupo cuando el proceso lo lidera —`npx` bifurca, y señalar sólo al
 * envoltorio deja la flota viva—, y al proceso solo cuando no. Un fallo aquí
 * no es excepcional: ya se murió.
 */
function signalTo(
  send: (target: number, sig: NodeJS.Signals) => void,
  t: { p: HarnessProc; leader: boolean },
  sig: NodeJS.Signals,
): void {
  try { send(t.leader ? -t.p.pid : t.p.pid, sig); } catch { /* ya no está */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
