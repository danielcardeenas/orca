/**
 * El canal del revisor, con el CLI de verdad.
 *
 * `orca-improve` es lo único que un agente revisor tiene para archivar lo que
 * propone, y el brief se lo promete con la línea entera escrita. Si el comando
 * no existe, no escribe donde el collector mira, o no le devuelve nada, la
 * revisión se pierde y nadie se entera — que es exactamente lo que pasó con
 * `orca-tell` hasta que se puso en el PATH (ver collector/shims.ts).
 *
 * Así que aquí se ejecuta el binario de verdad, como subproceso, contra el
 * vigilante de verdad, sobre un directorio de verdad. Lo único simulado es la
 * respuesta del hub, que es lo que este archivo no está probando.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMPROVE_DROP_DIR, ImproveDropWatcher, MAX_DROP_BYTES, type ImproveDrop } from '../src/collector/improve-drop.ts';
import { REVIEW_COMMAND, WORKER_COMMANDS, shimsFor } from '../src/collector/shims.ts';
import { ok, test, type TestModule } from './harness.ts';

const CLI = fileURLToPath(new URL('../bin/orca-improve.mjs', import.meta.url));

interface Run { code: number; stdout: string; stderr: string }

function run(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Un proyecto vigilado, como el que ORCA prepara al lanzar un agente. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-rev-cli-'));
  mkdirSync(join(dir, '.orca'), { recursive: true });
  return dir;
}

const DRAFT = {
  key: 'queue-order',
  title: 'The queue buries the oldest escalation',
  summary: 'Sort by age.',
  area: 'usability', kind: 'observed',
  evidence: ['avg wait 14m'],
};

const tests = [
  test('the reviewer files, the collector picks it up, and the answer comes back to it', async () => {
    const dir = project();
    const watcher = new ImproveDropWatcher({ resolveAgent: (_p, hint) => hint ?? 'sess_fallback' });
    const seen: ImproveDrop[] = [];
    // El hub contesta: aquí lo hace la prueba, que es lo único simulado.
    watcher.onDrop((d) => { seen.push(d); void watcher.ack(d.ackFile, { ok: true, filed: 1, merged: 0, rejected: ['"A guess": needs measurements'] }); });
    watcher.track('p1', dir);
    watcher.start(100);
    try {
      const out = await run(
        ['report', '--review', 'rev_abc', '--json', JSON.stringify({ proposals: [DRAFT] }), '--project', dir, '--agent', 'sess_rev'],
        dir,
      );
      const left = readdirSync(join(dir, IMPROVE_DROP_DIR));
      return ok('exit 0, the drop is gone, and the refusal reached the agent',
        out.code === 0 && seen.length === 1
        && seen[0]!.reviewId === 'rev_abc' && seen[0]!.agentId === 'sess_rev'
        && (seen[0]!.proposals[0] as { key: string }).key === 'queue-order'
        && out.stdout.includes('1 filed') && out.stdout.includes('refused: "A guess": needs measurements')
        && left.length === 0,
        `${out.code} · ${out.stdout.trim().split('\n')[0]} · ${left.length} file(s) left`);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  test('a report the hub refuses whole exits non-zero and says why', async () => {
    const dir = project();
    const watcher = new ImproveDropWatcher({ resolveAgent: () => 'sess_rev' });
    watcher.onDrop((d) => { void watcher.ack(d.ackFile, { ok: false, error: 'review rev_abc belongs to R2' }); });
    watcher.track('p1', dir);
    watcher.start(100);
    try {
      const out = await run(['report', '--review', 'rev_abc', '--json', JSON.stringify([DRAFT]), '--project', dir], dir);
      return ok('the agent can tell a refusal from a success',
        out.code === 3 && out.stderr.includes('belongs to R2'), `${out.code} · ${out.stderr.trim()}`);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  test('outside a watched project it says so instead of dropping a file nobody reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-rev-bare-'));
    try {
      const out = await run(['report', '--review', 'rev_abc', '--json', JSON.stringify([DRAFT]), '--project', dir], dir);
      return ok('exit 2 and a sentence the agent can put in its summary',
        out.code === 2 && out.stderr.includes('not watching'), out.stderr.trim());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('bad JSON and an empty report are refused before anything is written', async () => {
    const dir = project();
    try {
      const bad = await run(['report', '--review', 'r', '--json', '{not json'], dir);
      const empty = await run(['report', '--review', 'r', '--json', '{"proposals":[]}'], dir);
      const noReview = await run(['report', '--json', '{"proposals":[{}]}'], dir);
      return ok('three bad calls, three usable messages, no drops',
        bad.code === 1 && bad.stderr.includes('valid JSON')
        && empty.code === 1 && empty.stderr.includes('at least one proposal')
        && noReview.code === 1 && noReview.stderr.includes('--review'),
        empty.stderr.trim());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('an oversized report is refused by the collector, with the reason on disk', async () => {
    const dir = project();
    const drop = join(dir, IMPROVE_DROP_DIR);
    mkdirSync(drop, { recursive: true });
    const watcher = new ImproveDropWatcher({ resolveAgent: () => 'sess_rev' });
    const seen: ImproveDrop[] = [];
    watcher.onDrop((d) => seen.push(d));
    watcher.track('p1', dir);
    watcher.start(50);
    try {
      writeFileSync(join(drop, 'huge.json'), JSON.stringify({ proposals: [{ title: 'x'.repeat(MAX_DROP_BYTES + 100) }] }));
      await new Promise((r) => setTimeout(r, 400));
      const left = readdirSync(drop);
      return ok('nothing reached the hub, and the agent has an answer',
        seen.length === 0 && left.includes('huge.ack.json') && !left.includes('huge.json'),
        left.join(', '));
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  test('only a reviewer gets the command, and a reviewer gets no line to the human', () => {
    const reviewer = shimsFor(null, false, true);
    const solo = shimsFor(null, false);
    const member = shimsFor('audit-01', false);
    return ok('three sets, and each one is the tools that role should have',
      reviewer.review === true && reviewer.human === false
      && solo.human === true && solo.review !== true
      && member.human === false && member.review !== true
      && !(WORKER_COMMANDS as readonly string[]).includes(REVIEW_COMMAND),
      `${REVIEW_COMMAND} is reviewer-only`);
  }),
];

export default { suite: 'AUTOMEJORA · orca-improve', tests } satisfies TestModule;
