/**
 * Los puertos del arnés visual: quién puede compartir servidores y quién no.
 *
 * 4478/4479 son de la máquina, no del árbol. Antes eran constantes, y dos
 * corridas simultáneas se pisaban en silencio: la segunda encontraba los
 * servidores de la primera, los tomaba por un `npm run dev` y fotografiaba
 * otro worktree bajo otro hub; luego la primera terminaba y se los llevaba por
 * debajo. Los frames salían con buena cara. Eso es peor que un error.
 *
 * Lo que merece prueba, porque cada cosa falla sin ruido:
 *
 *  1. `sharing` — la regla de qué se reutiliza. El caso fino es el Vite: solo
 *     sirve si además estamos en el hub canónico, porque un Vite proxea a un
 *     hub fijado al arrancar. Heredar el Vite del vecino con hub propio da una
 *     consola que dibuja nuestro árbol y habla con su flota.
 *  2. `isolatedRun` — un worktree enlazado se aísla solo. Ahí es donde ORCA
 *     pone a cada agente, y nadie va a acordarse de pasar `--isolated`.
 *  3. Leer un puerto antes de resolverlo revienta en vez de devolver 4479.
 *  4. El proxy de Vite sigue al hub que le digan. Es la pieza que hace posible
 *     todo lo anterior: sin ella, un Vite en puerto propio seguiría hablando
 *     con 4479, que es el hub de otro.
 *
 * Los puertos de verdad no se prueban aquí: eso pide levantar hub y Vite, y es
 * lo que hace `npx tsx test/visual.ts --isolated`.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUNS_DIR, hubPort, isolatedRun, markOf, sharing, sweepStaleRuns, uiPort } from './visual.ts';
import { PORTS } from '../src/shared/protocol.ts';
// Estático a propósito, y no sólo por el caso por defecto: `--changed` sale del
// grafo de imports, y un `import()` con query no aparece en él. Sin esta línea,
// tocar vite.config.ts no traería esta suite.
import viteConfig from '../vite.config.ts';
import { eq, ok, test, throws, type TestModule } from './harness.ts';

/** Lo que interesa del config, con el tipo que Vite no promete. */
function server(cfg: unknown): { port: number; proxy: Record<string, { target: string }> } {
  return (cfg as { server: { port: number; proxy: Record<string, { target: string }> } }).server;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Un repo con un commit y un worktree enlazado colgando de él. */
function repoConWorktree(): { main: string; worktree: string; cleanup(): void } {
  const main = mkdtempSync(join(tmpdir(), 'orca-vp-'));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'ORCA Test');
  git(main, 'config', 'user.email', 'test@orca.invalid');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'first');
  const worktree = join(main, '..', `orca-vp-wt-${process.pid}`);
  git(main, 'worktree', 'add', '--detach', '-q', worktree, 'HEAD');
  return {
    main,
    worktree,
    cleanup() {
      try { git(main, 'worktree', 'remove', '--force', worktree); } catch { /* ya no está */ }
      rmSync(main, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    },
  };
}

const tests = [
  test('aislado no comparte nada, aunque el dev esté arriba', () => {
    const p = sharing({ alone: true, hubUp: true, uiUp: true });
    return eq('aislado no comparte nada, aunque el dev esté arriba', `${p.hub}/${p.ui}`, 'own/own');
  }),

  test('sin aislar y con el dev arriba, se reutilizan los dos', () => {
    const p = sharing({ alone: false, hubUp: true, uiUp: true });
    return eq('con el dev arriba se reutilizan los dos', `${p.hub}/${p.ui}`, 'reuse/reuse');
  }),

  test('un Vite canónico sin su hub no se hereda: proxearía al hub equivocado', () => {
    const p = sharing({ alone: false, hubUp: false, uiUp: true });
    return eq('un Vite sin su hub no se hereda: proxearía al hub equivocado', `${p.hub}/${p.ui}`, 'own/own');
  }),

  test('hub compartido y Vite propio es una combinación válida', () => {
    const p = sharing({ alone: false, hubUp: true, uiUp: false });
    return eq('hub compartido con Vite propio es válido', `${p.hub}/${p.ui}`, 'reuse/own');
  }),

  test('arranque en frío: nada arriba, nada que compartir', () => {
    const p = sharing({ alone: false, hubUp: false, uiUp: false });
    return eq('en frío no hay nada que compartir', `${p.hub}/${p.ui}`, 'own/own');
  }),

  test('--isolated y ORCA_VISUAL_ISOLATED=1 bastan por sí solos', () => {
    const porFlag = isolatedRun(['boot', '--isolated'], {}, '/');
    const porEnv = isolatedRun(['boot'], { ORCA_VISUAL_ISOLATED: '1' }, '/');
    const ninguno = isolatedRun(['boot'], { ORCA_VISUAL_ISOLATED: '0' }, '/');
    return ok('--isolated y ORCA_VISUAL_ISOLATED=1 bastan por sí solos',
      porFlag && porEnv && !ninguno, `flag=${porFlag} env=${porEnv} off=${ninguno}`);
  }),

  test('un worktree enlazado se aísla solo; el checkout principal no', async () => {
    const r = repoConWorktree();
    try {
      const enWorktree = isolatedRun([], {}, r.worktree);
      const enPrincipal = isolatedRun([], {}, r.main);
      return ok('un worktree enlazado se aísla solo; el principal no', enWorktree && !enPrincipal,
        `worktree=${enWorktree} principal=${enPrincipal}`);
    } finally {
      r.cleanup();
    }
  }),

  test('fuera de git no se aísla: sin worktree no hay a quién pisar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-vp-nogit-'));
    try {
      return ok('fuera de git no se aísla: no hay worktree a quién pisar', !isolatedRun([], {}, dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  test('sin env, el config se queda en los puertos canónicos', () => {
    const srv = server(viteConfig);
    return eq('canónicos', `${srv.port} ${srv.proxy['/api']?.target}`,
      `${PORTS.ui} http://127.0.0.1:${PORTS.hub}`);
  }),

  test('el proxy de Vite apunta al hub que dice ORCA_PORT, no al canónico', async () => {
    const antes = { port: process.env['ORCA_PORT'], ui: process.env['ORCA_UI_PORT'] };
    process.env['ORCA_PORT'] = '5561';
    process.env['ORCA_UI_PORT'] = '5560';
    try {
      // Query distinta: el config lee las env al evaluarse, una sola vez por módulo.
      const mod = await import(`../vite.config.ts?probe=${Date.now()}`) as { default: unknown };
      const srv = server(mod.default);
      return eq('puerto y proxy salen de las env',
        `${srv.port} ${srv.proxy['/api']?.target} ${srv.proxy['/ws']?.target}`,
        '5560 http://127.0.0.1:5561 ws://127.0.0.1:5561');
    } finally {
      if (antes.port === undefined) delete process.env['ORCA_PORT']; else process.env['ORCA_PORT'] = antes.port;
      if (antes.ui === undefined) delete process.env['ORCA_UI_PORT']; else process.env['ORCA_UI_PORT'] = antes.ui;
    }
  }),

  /*
   * El barrido de restos. Lo que se defiende: una corrida que muere sin poder
   * despedirse —SIGKILL, una tarea cortada, un `--keep` interrumpido— deja sus
   * servidores sirviendo para siempre, porque están en su propio grupo a
   * propósito y ya no hay quien les mande una señal. Se acumulan: siete Vite
   * de quince horas, cada uno con su esbuild.
   *
   * Y lo que NO puede pasar, que es lo que haría el barrido inaceptable: matar
   * a un tercero. Un pid se recicla, y el número solo no prueba nada.
   */
  test('lo que dejó una corrida muerta se barre; lo de una viva y lo ajeno, no', async () => {
    const owner = spawnSync('true');                       // un dueño que ya no existe
    const mine = spawn('sleep', ['637'], { detached: true, stdio: 'ignore' });
    // Su comando CONTIENE lo apuntado («sleep 638») pero no termina en ello:
    // nombrar no es ejecutar, y un `includes` lo habría matado.
    const theirs = spawn('sleep', ['638'], { detached: true, stdio: 'ignore' });
    const live = spawn('sleep', ['639'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 150));
    const dead = owner.pid ?? 999999;
    mkdirSync(RUNS_DIR, { recursive: true });
    const files = [
      // Corrida muerta: uno suyo de verdad, y uno cuyo pid heredó otro proceso
      // que NOMBRA lo que se lanzó sin ejecutarlo — el caso que el 2026-09-09
      // paró a un agente por su brief (docs/SYNTHETIC-HARNESS.md).
      [join(RUNS_DIR, `${dead}.json`), {
        owner: dead, at: Date.now(), procs: [
          { pid: mine.pid, mark: markOf('sleep', ['637']) },
          { pid: theirs.pid, mark: markOf('sleep', ['638', 'y', 'algo', 'más']) },
        ],
      }],
      // Corrida viva: puede ser un `--keep` a propósito, y no se toca.
      [join(RUNS_DIR, `${process.pid + 100000}.json`), {
        owner: process.pid, at: Date.now(), procs: [{ pid: live.pid, mark: markOf('sleep', ['639']) }],
      }],
    ] as const;
    for (const [path, rec] of files) writeFileSync(path, JSON.stringify(rec), 'utf8');

    try {
      sweepStaleRuns();
      await new Promise((r) => setTimeout(r, 250));
      const gone = (p: ReturnType<typeof spawn>) => {
        try { process.kill(p.pid!, 0); return false; } catch { return true; }
      };
      const barrido = gone(mine), ajeno = gone(theirs), viva = gone(live);
      return ok('lo que dejó una corrida muerta se barre; lo de una viva y lo ajeno, no',
        barrido && !ajeno && !viva,
        `el suyo ${barrido ? 'cerrado' : 'SIGUE'} · el del pid reciclado ${ajeno ? 'MUERTO' : 'intacto'} · el de la corrida viva ${viva ? 'MUERTO' : 'intacto'}`);
    } finally {
      for (const p of [mine, theirs, live]) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* ya no está */ } }
      for (const [path] of files) rmSync(path, { force: true });
    }
  }),

  test('leer un puerto antes de resolverlo falla en vez de mentir', () => {
    const hub = throws('hubPort', () => hubPort(), 'hubPort() devolvió un puerto sin resolverlos');
    const ui = throws('uiPort', () => uiPort(), 'uiPort() devolvió un puerto sin resolverlos');
    return ok('leer un puerto antes de resolverlo falla en vez de mentir',
      hub.pass && ui.pass, hub.pass && ui.pass ? 'ambos lanzan' : `${hub.detail} ${ui.detail}`);
  }),
];

export default { suite: 'visual ports', tests } satisfies TestModule;
