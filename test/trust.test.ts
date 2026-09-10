/**
 * Lanzar sobre una carpeta nueva: confianza, diálogo nativo y alta de proyecto.
 *
 * El 2026-09-08 un squad de cinco se quedó 25 minutos parado en el diálogo de
 * confianza de Claude Code sobre `/Users/…/projects/ventures`, recién creada.
 * Tres cosas fallaron a la vez y esta suite cubre las tres:
 *
 *  1. la carpeta no estaba confiada y `bypassPermissions` no salta ese diálogo;
 *  2. ORCA no supo decir qué pasaba — lo contó como «nada se ha pintado en 20s»;
 *  3. el proyecto no existía para el hub y el spawn fallaba con «desconocido».
 *
 * La pantalla de `TRUST_263` es una captura REAL de Claude Code 2.1.263 en un
 * pane de 160x45, tomada ese día contra una carpeta sin entrada previa.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandRunner, type CommandDeps } from '../src/collector/commands.ts';
import { nativeDialogSignal, NATIVE_DIALOG_MARK } from '../src/collector/index.ts';
import { promptOn } from '../src/collector/screen.ts';
import { shimDir, shimsFor, HUMAN_COMMAND, WORKER_COMMANDS } from '../src/collector/shims.ts';
import { attachHint } from '../src/collector/tmux.ts';
import { grantTrust, trustOf } from '../src/collector/trust.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { ok, test, type TestModule } from './harness.ts';

/**
 * Un temporal por su ruta REAL.
 *
 * En macOS `/var/folders/…` es un symlink a `/private/var/folders/…`, y la
 * confianza se indexa por la ruta resuelta —que es la que el CLI ve como su
 * cwd— así que un test que compare contra la ruta sin resolver comprueba una
 * clave que nadie escribe. Ver `trustKey`.
 */
function temp(): string { return realpathSync(mkdtempSync(join(tmpdir(), 'orca-trust-'))); }

/** La pantalla exacta que vieron los cinco workers, recortada a lo visible. */
const TRUST_263 = [
  '',
  '─'.repeat(160),
  ' Accessing workspace:',
  '',
  ' /Users/danielcardenas/projects/ventures',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,",
  " take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/* ── 1 · el estado de confianza ───────────────────────────────────── */

const readsAndGrants = test('la confianza se lee y se concede sin tocar el resto del fichero', () => {
  const dir = temp();
  try {
    const file = join(dir, '.claude.json');
    const target = join(dir, 'ventures');
    mkdirSync(target);
    writeFileSync(file, JSON.stringify({
      numStartups: 7,
      projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
    }, null, 2), { mode: 0o600 });

    const before = trustOf(target, file);
    const first = grantTrust(target, file);
    const after = trustOf(target, file);
    const again = grantTrust(target, file);
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      numStartups: number;
      projects: Record<string, { hasTrustDialogAccepted?: boolean; allowedTools?: string[] }>;
    };
    const mode = statSync(file).mode & 0o777;

    return ok('la confianza se lee y se concede sin tocar el resto del fichero',
      before === 'untrusted' && after === 'trusted'
      && first.ok && first.changed && again.ok && !again.changed
      && json.numStartups === 7
      && json.projects['/elsewhere']?.hasTrustDialogAccepted === true
      && json.projects['/elsewhere']?.allowedTools?.[0] === 'Bash'
      && json.projects[target]?.hasTrustDialogAccepted === true
      // El modo del original se conserva: este fichero lleva credenciales.
      && mode === 0o600,
      `${before} → ${after}, escrituras: ${first.changed}/${again.changed}, modo ${mode.toString(8)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const refusesToGuess = test('un fichero roto o ausente no se reescribe ni se inventa', () => {
  const dir = temp();
  try {
    const broken = join(dir, 'broken.json');
    const missing = join(dir, 'nope.json');
    writeFileSync(broken, '{ not json');
    const onBroken = grantTrust(dir, broken);
    const onMissing = grantTrust(dir, missing);
    return ok('un fichero roto o ausente no se reescribe ni se inventa',
      !onBroken.ok && !onBroken.changed && readFileSync(broken, 'utf8') === '{ not json'
      && trustOf(dir, broken) === 'unreadable'
      && !onMissing.ok && !onMissing.changed
      // Sin fichero, la respuesta honesta es "habrá diálogo", no "confiada".
      && trustOf(dir, missing) === 'untrusted',
      `roto: ${onBroken.detail} · ausente: ${onMissing.detail}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ── 2 · lo que ORCA dice cuando aun así se atasca ────────────────── */

const dialogIsRead = test('el diálogo de confianza real de 2.1.263 se reconoce y trae su pregunta', () => {
  const p = promptOn(TRUST_263);
  return ok('el diálogo de confianza real de 2.1.263 se reconoce y trae su pregunta',
    p?.kind === 'trust' && p.onceKey === null
    && p.question === 'Quick safety check: Is this a project you created or one you trust?',
    `${p?.kind} · ${p?.question}`);
});

const blockNamesTheSocket = test('el bloqueo dice qué se pregunta y con qué comando contestarlo', () => {
  const p = promptOn(TRUST_263)!;
  const pane = 'orca-c80a611a-2ea3-4ced-8dd6-f1179825cc3d';
  const block = nativeDialogSignal(p.question, attachHint(pane), 1_700_000_000_000);
  return ok('el bloqueo dice qué se pregunta y con qué comando contestarlo',
    block.kind === 'input'
    && block.summary.startsWith(NATIVE_DIALOG_MARK)
    && block.summary.includes('Is this a project you created or one you trust?')
    // El socket: `tmux ls` a secas contesta «no sessions» y manda a nadie.
    && block.summary.includes(`tmux -L orca attach -t =${pane}`)
    // Y no se parece al parón genérico, que es lo que se leyó ese día.
    && !block.summary.includes('nothing has been painted'),
    block.summary);
});

/* ── 3 · los comandos que el brief promete ────────────────────────── */

const shimsExist = test('los comandos orca-* quedan ejecutables en el PATH del worker', () => {
  const dir = temp();
  const prev = process.env['ORCA_HOME'];
  try {
    process.env['ORCA_HOME'] = dir;
    const full = shimDir({ human: true });
    const squad = shimDir({ human: false });
    if (!full || !squad) return ok('los comandos orca-* quedan ejecutables en el PATH del worker', false, 'no se pudo escribir el directorio');
    const runnable = (base: string, cmd: string): boolean => {
      try { return (statSync(join(base, cmd)).mode & 0o111) !== 0; } catch { return false; }
    };
    const tell = readFileSync(join(full, 'orca-tell'), 'utf8');
    return ok('los comandos orca-* quedan ejecutables en el PATH del worker',
      WORKER_COMMANDS.every((c) => runnable(full, c) && runnable(squad, c))
      // Al miembro de un escuadrón se le quita la herramienta, no se le pide
      // que no la use: su puerta al humano es su líder.
      && runnable(full, HUMAN_COMMAND) && !runnable(squad, HUMAN_COMMAND)
      && shimsFor('audit-01', false).human === false
      && shimsFor('audit-01', true).human === true
      && shimsFor(null, false).human === true
      // Con el node de este proceso y la ruta absoluta del .mjs.
      && tell.includes(process.execPath) && tell.includes('orca-tell.mjs'),
      `full=${full}`);
  } finally {
    if (prev === undefined) delete process.env['ORCA_HOME']; else process.env['ORCA_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4 · el caso entero: carpeta nueva, worker que trabaja ────────── */

/** Un `claude` de mentira que se niega a arrancar si la carpeta no está confiada. */
function trustAwareClaude(dir: string, configFile: string): { bin: string; ran: () => string[] | null } {
  const argvFile = join(dir, 'argv.json');
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    `const config = ${JSON.stringify(configFile)};`,
    // Lo mismo que hace el CLI real: sin entrada de confianza, abre el diálogo
    // y se queda ahí. Aquí se traduce a "no escribe su argv y no termina bien".
    'const json = JSON.parse(fs.readFileSync(config, "utf8"));',
    'if (json.projects?.[process.cwd()]?.hasTrustDialogAccepted !== true) {',
    '  console.log("Quick safety check: Is this a project you created or one you trust?");',
    '  process.exit(7);',
    '}',
    `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("Started background session a1b2c3d4");',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return {
    bin,
    ran: () => { try { return JSON.parse(readFileSync(argvFile, 'utf8')) as string[]; } catch { return null; } },
  };
}

function spawnDeps(dir: string, project: { id: string; name: string; path: string }, over: Partial<CommandDeps>): CommandDeps {
  return {
    projects: { get: (id: string) => (id === project.id ? project : null) },
    keys: { materialize: () => ({}) },
    tmux: { available: () => false },
    lineage: new LineageIndex(join(dir, 'lineage.json')),
    escalations: {}, messages: {}, artifacts: {},
    agent: () => null,
    awaitSpawn: async () => null,
    onResync: () => { /* no se usa */ },
    onKeysChanged: () => { /* no se usa */ },
    ...over,
  } as unknown as CommandDeps;
}

/** Ver el comentario de `heldOpen` en squads.test.ts: `run()` lanza con detach. */
async function heldOpen<T>(fn: () => Promise<T>): Promise<T> {
  const keep = setInterval(() => { /* sólo para tener ref */ }, 200);
  try { return await fn(); } finally { clearInterval(keep); }
}

const newFolderLaunches = test('una carpeta sin confianza previa arranca y trabaja, sin humano', async () => {
  const dir = temp();
  const prevBin = process.env['ORCA_CLAUDE_BIN'];
  try {
    const work = join(dir, 'ventures');
    mkdirSync(work);
    const config = join(dir, '.claude.json');
    // Un `~/.claude.json` como el real: el padre confiado, la carpeta nueva no.
    writeFileSync(config, JSON.stringify({
      projects: { [dir]: { hasTrustDialogAccepted: true } },
    }, null, 2), { mode: 0o600 });

    const fake = trustAwareClaude(dir, config);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    const project = { id: 'p1', name: 'ventures', path: work };
    const runner = new CommandRunner(spawnDeps(dir, project, { trustFile: config }));
    const res = await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', background: true, parentId: null,
      prompt: 'Write the first draft of the ventures README.',
      mission: 'ventures README',
    }));

    const argv = fake.ran();
    const json = JSON.parse(readFileSync(config, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    return ok('una carpeta sin confianza previa arranca y trabaja, sin humano',
      res.ok
      // Arrancó de verdad: el binario escribió su argv, que es lo que sólo
      // ocurre pasada la puerta de la confianza.
      && argv !== null && argv.includes('Write the first draft of the ventures README.')
      && json.projects[work]?.hasTrustDialogAccepted === true
      // Y la confianza del padre sigue donde estaba: no se tocó nada más.
      && json.projects[dir]?.hasTrustDialogAccepted === true,
      `ok=${res.ok} detail=${res.detail} argv=${argv ? argv.length : 'ninguno'}`);
  } finally {
    if (prevBin === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

const refusesInsteadOfFreezing = test('con la concesión apagada el spawn se rechaza, no se congela', async () => {
  const dir = temp();
  const prevBin = process.env['ORCA_CLAUDE_BIN'];
  const prevTrust = process.env['ORCA_TRUST_SPAWNS'];
  try {
    const work = join(dir, 'ventures');
    mkdirSync(work);
    const config = join(dir, '.claude.json');
    writeFileSync(config, JSON.stringify({ projects: {} }, null, 2), { mode: 0o600 });
    const fake = trustAwareClaude(dir, config);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    process.env['ORCA_TRUST_SPAWNS'] = '0';
    const project = { id: 'p1', name: 'ventures', path: work };
    const runner = new CommandRunner(spawnDeps(dir, project, { trustFile: config }));
    const res = await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', background: true, parentId: null,
      prompt: 'Write the first draft of the ventures README.',
      mission: 'ventures README',
    }));
    const json = JSON.parse(readFileSync(config, 'utf8')) as { projects: Record<string, unknown> };
    return ok('con la concesión apagada el spawn se rechaza, no se congela',
      !res.ok
      && res.detail?.includes('Is this a project you created or one you trust?') === true
      && res.detail?.includes('ORCA_TRUST_SPAWNS=0') === true
      && fake.ran() === null
      && Object.keys(json.projects).length === 0,
      res.detail ?? '(sin detalle)');
  } finally {
    if (prevBin === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prevBin;
    if (prevTrust === undefined) delete process.env['ORCA_TRUST_SPAWNS'];
    else process.env['ORCA_TRUST_SPAWNS'] = prevTrust;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5 · el alta del proyecto ─────────────────────────────────────── */

const registersByPath = test('una carpeta sin sesiones se da de alta por su ruta', async () => {
  const dir = temp();
  try {
    const work = join(dir, 'ventures');
    mkdirSync(work);
    const { ProjectRegistry } = await import('../src/collector/projects.ts');
    const remembered = join(dir, 'projects.json');
    const registry = new ProjectRegistry('m1', undefined, remembered);
    let resynced = 0;
    const runner = new CommandRunner(spawnDeps(dir, { id: 'p1', name: 'x', path: work }, {
      projects: registry,
      onResync: () => { resynced++; },
      trustFile: false,
    }));
    const before = registry.all().length;
    const res = await runner.execute({ k: 'project:register', machineId: 'm1', path: work });
    const twice = await runner.execute({ k: 'project:register', machineId: 'm1', path: work });
    const nowhere = await runner.execute({ k: 'project:register', machineId: 'm1', path: join(dir, 'no-existe') });
    const relative = await runner.execute({ k: 'project:register', machineId: 'm1', path: 'ventures' });
    const data = res.data as { projectId: string; code: string; path: string } | undefined;
    // Y sobrevive a un reinicio del collector: un registro sólo en memoria
    // obligaría al operador a darla de alta otra vez cada vez que ORCA arranca.
    const fresh = new ProjectRegistry('m1', undefined, remembered);
    const adopted = fresh.adopt();
    return ok('una carpeta sin sesiones se da de alta por su ruta',
      before === 0 && res.ok && !!data?.projectId
      && adopted.length === 1 && fresh.get(data.projectId)?.path === work
      // Idempotente: el mismo id la segunda vez, y un solo proyecto.
      && twice.ok && (twice.data as { projectId: string }).projectId === data.projectId
      && registry.all().length === 1
      // El hub tiene que verlo ANTES de que conteste el ack.
      && resynced >= 1
      && !nowhere.ok && !relative.ok,
      `${data?.code} ${data?.projectId} · resyncs ${resynced}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const tests = [
  readsAndGrants,
  refusesToGuess,
  dialogIsRead,
  blockNamesTheSocket,
  shimsExist,
  newFolderLaunches,
  refusesInsteadOfFreezing,
  registersByPath,
];

const suite: TestModule = { suite: 'collector · carpeta nueva: confianza, diálogo y alta', tests };
export default suite;
