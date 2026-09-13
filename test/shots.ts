/**
 * Corre los shots: `test/*.shots.ts`, uno detrás de otro, y sale distinto de
 * cero si alguno falla. Tres estados: pasa, falla y OMITE —lo que un shot
 * dice cuando el fixture no le dio con qué afirmar nada (`shot-skip.ts`)—,
 * que se cuenta aparte y nunca como verde.
 *
 *   npm run shots                    los dieciséis
 *   npm run shots -- hud improve     los que llevan alguno de esos en el nombre
 *   npm run shots -- --list          decir cuáles hay, sin correr ninguno
 *   npm run shots -- --headed        verlos pasar
 *   npm run shots -- --timeout=900   más margen por shot (por defecto 600 s)
 *
 * Por qué existe.
 *
 * Un shot es una prueba entera —abre la consola de verdad en Chromium, siembra
 * un estado y afirma treinta cosas sobre lo que ve—, pero hasta ahora no lo
 * corría nadie: `npm test` descubre `test/*.test.ts` y no los ve, y
 * `npm run visual` corre sus propias escenas. Sólo existían si alguien los
 * tecleaba de memoria. `test/hud-improve.shots.ts` llevaba roto semanas
 * comprobando su compás contra CERO filas mientras `npm test` daba 1338/1338:
 * el panel de AUTOMEJORA estaba sin red y nadie podía saberlo.
 *
 * Esto no los mete en `npm test` a propósito. La suite ya pasa de diez minutos
 * y estos necesitan navegador, GPU y un hub por shot: mezclarlos haría que la
 * verificación de un cambio de dos ficheros costase media hora, y la
 * alternativa real a eso no es esperar, es no correr nada. Son la puerta de lo
 * visual, al lado de `npm run visual`, y lo que se pide de ellos es que se
 * corran cuando se toca la UI y antes de entregar.
 *
 * Tampoco hay `--changed` aquí. El grafo de imports que usa `npm test` no
 * sirve para un shot: un shot no importa la UI, la ABRE en un navegador, así
 * que su dependencia real es todo lo que acabe pintado en la pantalla. Decidir
 * cuáles correr es, de momento, del que toca el código.
 *
 * En serie, y no por prudencia de más: cada shot levanta su hub, su Vite, su
 * flota sintética y su Chromium. En paralelo compiten por la máquina del
 * operador y las medidas de animación —que es lo que la mitad de estos
 * comprueban— empiezan a mentir.
 *
 * Y siempre aislados (`ORCA_VISUAL_ISOLATED=1`): puertos propios y un
 * `ORCA_HOME` de usar y tirar. Una puerta que se corre a menudo no puede
 * escribir en el ~/.orca del operador ni asomarse a su flota, y no depende de
 * que quien la lanza se acuerde del flag.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SKIP_CODE, skipReasonOf } from './shot-skip.ts';

const DIR = new URL('.', import.meta.url).pathname;
const ROOT = dirname(DIR.replace(/\/$/, ''));
const ARGS = process.argv.slice(2);
const FILTERS = ARGS.filter((a) => !a.startsWith('--'));
const TIMEOUT_MS = Number(ARGS.find((a) => a.startsWith('--timeout='))?.slice('--timeout='.length) ?? 600) * 1000;

/** Lo que se enseña de un shot que falla: el final, que es donde está la aserción. */
const TAIL = 30;

/**
 * Tres estados, no dos. Un shot que se omite —le faltó del fixture lo que
 * necesitaba para afirmar nada— no es verde: contarlo como éxito es lo que
 * hacía que `shelf-routes.shots.ts` se leyera como una prueba pasada seis
 * veces sin haber mirado la foto. Ver `shot-skip.ts`.
 */
type Status = 'ok' | 'skip' | 'fail';
type Verdict = { file: string; status: Status; secs: number; why: string; out: string };

/**
 * Un shot, en su propio proceso.
 *
 * Su propio proceso porque cada uno levanta servidores y se despide de ellos
 * en su `finally`: importarlos aquí los encadenaría a una sola vida, y el
 * primero que muriese se llevaría la corrida entera.
 */
function runShot(file: string): Promise<Verdict> {
  return new Promise((resolve) => {
    const argv = ['tsx', join(DIR, file), ...ARGS.filter((a) => a === '--headed' || a === '--keep')];
    const t0 = Date.now();
    const p = spawn('npx', argv, {
      cwd: ROOT,
      env: { ...process.env, ORCA_VISUAL_ISOLATED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    p.stderr.on('data', (b: Buffer) => { out += b.toString(); });

    /*
     * Un shot colgado es un fallo, no una espera. Se le pide que se vaya y, si
     * no se va, se le mata —a él, por su pid, nunca por patrón: los procesos
     * de este repo se parecen demasiado a los del ORCA de verdad del operador.
     * Lo que deje servidor arriba lo barre la siguiente corrida del arnés
     * (`sweepStaleRuns` en visual.ts), que para eso existe.
     */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGTERM');
      setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 5000);
    }, TIMEOUT_MS);

    p.on('close', (code) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - t0) / 1000);
      const status = statusOf(timedOut, code);
      resolve({
        file, secs, out, status,
        why: timedOut ? `se colgó (${Math.round(TIMEOUT_MS / 1000)}s)`
          : status === 'skip' ? skipReasonOf(out) || 'omitido sin decir por qué'
          : status === 'ok' ? '' : `salió con ${code}`,
      });
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ file, secs: Math.round((Date.now() - t0) / 1000), out: String(err), status: 'fail', why: 'no arrancó' });
    });
  });
}

/**
 * Qué fue de un shot, por su código de salida y nada más.
 *
 * Por señal y no por lo que imprima: el motivo del skip es texto para un
 * humano, pero lo que decide el veredicto es el `SKIP_CODE`, que ningún
 * cambio de mensaje puede desafinar. Un cuelgue es un fallo, no una omisión:
 * el shot no decidió nada, se lo llevó el reloj.
 */
export function statusOf(timedOut: boolean, code: number | null): Status {
  if (timedOut) return 'fail';
  if (code === 0) return 'ok';
  if (code === SKIP_CODE) return 'skip';
  return 'fail';
}

/** La aserción que falló, si la hay: es lo único que se quiere leer de 400 líneas. */
export function assertionOf(out: string): string {
  return out.split('\n').find((l) => /AssertionError|Error:/.test(l))?.trim().slice(0, 160) ?? '';
}

/**
 * Qué se corre: los shots del directorio, filtrados por nombre.
 *
 * Aparte y pura para que una suite pueda comprobarla sin levantar dieciséis
 * navegadores. Lo que se quiere garantizar es que un shot nuevo entra en la
 * puerta por existir —nadie tiene que apuntarlo en una lista— y que un filtro
 * escoge, no descarta en silencio.
 */
export function pickShots(files: readonly string[], filters: readonly string[]): string[] {
  const shots = files.filter((f) => f.endsWith('.shots.ts')).sort();
  return filters.length ? shots.filter((f) => filters.some((x) => f.includes(x))) : shots;
}

/**
 * El recuento, con las omisiones en su propia columna.
 *
 * Aparte y pura porque es lo que se lee del tablero, y lo que no se puede
 * dejar volver a mentir: un omitido no suma en los que pasan.
 */
export function tally(verdicts: readonly { status: Status }[]): { ok: number; skip: number; fail: number } {
  return {
    ok: verdicts.filter((v) => v.status === 'ok').length,
    skip: verdicts.filter((v) => v.status === 'skip').length,
    fail: verdicts.filter((v) => v.status === 'fail').length,
  };
}

async function main() {
  const files = pickShots(await readdir(DIR), FILTERS);

  if (ARGS.includes('--list')) {
    console.log(files.join('\n'));
    return;
  }
  if (!files.length) {
    console.log(`ningún shot${FILTERS.length ? ` con ${FILTERS.join(', ')}` : ''}`);
    process.exit(1);
  }

  console.log(`${files.length} shot(s), en serie · cada uno levanta su hub, su vite y su flota\n`);
  const verdicts: Verdict[] = [];
  for (const [i, f] of files.entries()) {
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${files.length}  ${f.padEnd(28)}`);
    const v = await runShot(f);
    verdicts.push(v);
    console.log(v.status === 'ok' ? `\x1b[32mOK\x1b[0m    ${v.secs}s`
      : v.status === 'skip' ? `\x1b[33mOMITE\x1b[0m ${v.secs}s  ${v.why}`
      : `\x1b[31mFALLA\x1b[0m ${v.secs}s  ${v.why}`);
    if (v.status === 'fail') console.log(v.out.split('\n').slice(-TAIL).map((l) => `      ${l}`).join('\n'));
  }

  const { ok, skip, fail } = tally(verdicts);
  const secs = verdicts.reduce((a, v) => a + v.secs, 0);
  /*
   * El denominador son los que de verdad afirmaron algo: `12/12 shots pasan`
   * con cuatro omitidos al lado dice la verdad; `16/16` la escondería.
   */
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${ok}/${ok + fail} shots pasan\x1b[0m`
    + (skip ? ` · \x1b[33m${skip} omitido(s)\x1b[0m` : '')
    + ` · ${Math.round(secs / 60)}m`);
  for (const v of verdicts.filter((x) => x.status === 'fail')) {
    console.log(`  \x1b[31m${v.file}\x1b[0m  ${assertionOf(v.out) || v.why}`);
  }
  // Una omisión es legítima, pero se dice: es lo que nadie miró en esta corrida.
  for (const v of verdicts.filter((x) => x.status === 'skip')) {
    console.log(`  \x1b[33m${v.file}\x1b[0m  ${v.why}`);
  }
  process.exit(fail ? 1 : 0);
}

/*
 * Sólo cuando se le llama a él. Importarlo —lo hace su suite, para mirar la
 * selección sin levantar dieciséis navegadores— no corre nada. Mismo criterio
 * que `test/visual.ts`.
 *
 * El nombre entero, no el sufijo: `endsWith('shots.ts')` también case con
 * `tether.shots.ts`, y bastaría con que un shot importase algo de aquí para
 * que abriese dieciséis navegadores dentro de sí mismo.
 */
if (/(?:^|\/)shots\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('el runner de shots se cayó:', err);
    process.exit(1);
  });
}
