import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { eq, ok, test, type TestModule } from './harness.ts';

function cli(args: string[], root: string) {
  const child = spawn(process.execPath, [new URL('../bin/orca-read.mjs', import.meta.url).pathname, '--project', root, ...args], {
    env: { ...process.env, ORCA_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (s) => { stdout += s; });
  child.stderr.on('data', (s) => { stderr += s; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish')); }, 5000);
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

export default {
  suite: 'mail-wait',
  tests: [
    test('wait subscribes before reading, accepts atomic delivery, and closes its watcher', async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wait-'));
      try {
        const modulePath = new URL('../bin/lib/wait-for.mjs', import.meta.url).href;
        const { waitFor } = await import(modulePath);
        let ready = false;
        const started = Date.now();
        const pending = waitFor(root, () => ready ? 'answer' : null, 3000);
        ready = true;
        writeFileSync(join(root, '.tmp'), 'answer');
        renameSync(join(root, '.tmp'), join(root, 'answer.json'));
        const result = await pending;
        return ok('filesystem delivery wakes without the reconciliation poll', result === 'answer' && Date.now() - started < 2000);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }),
    test('orca-read waits for mail, prints it, then marks it read', async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wait-'));
      const inbox = join(root, '.orca', 'in');
      mkdirSync(inbox, { recursive: true });
      try {
        const pending = cli(['--wait', '--timeout', '2', '--json'], root);
        const timer = setTimeout(() => {
          writeFileSync(join(inbox, '.tmp'), JSON.stringify({ id: 'm1', subject: 'Finished migration', at: Date.now() }));
          renameSync(join(inbox, '.tmp'), join(inbox, 'm1.json'));
        }, 150);
        let first;
        try { first = await pending; } finally { clearTimeout(timer); }
        const second = await cli(['--json'], root);
        return ok('one delivery, no duplicate on next read', first.code === 0 && JSON.parse(first.stdout)[0]?.subject === 'Finished migration' && second.stdout.trim() === '[]', first.stderr);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }),
    test('orca-read timeout is explicit and invalid timeouts fail', async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wait-'));
      try {
        const expired = await cli(['--wait', '--timeout', '0.05'], root);
        const invalid = await cli(['--wait', '--timeout', 'NaN'], root);
        return eq('exit 3 for timeout, 1 for bad usage', [expired.code, invalid.code], [3, 1]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }),
  ],
} satisfies TestModule;
