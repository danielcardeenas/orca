/**
 * El sustrato tmux: donde vive un agente hospedado.
 *
 * Se ejercita el tmux de verdad en un socket propio de la prueba, nunca el de
 * ORCA (`-L orca`): si estas pruebas dejaran un pane colgado se lo encontraría
 * el collector. Sin tmux en la máquina se dice y se pasa; el contrato del
 * argv (nada de shell, `;` rechazado) se prueba igual.
 */

import { TmuxHost, paneName, parseControlLine, sessionIdOfPane, resolveTmuxBin } from '../src/collector/tmux.ts';
import { ok, eq, test, sleep, type TestModule } from './harness.ts';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const SOCKET = `orca-test-${process.pid}`;

async function withTmux<T>(fn: (t: TmuxHost) => Promise<T>): Promise<T | null> {
  if (!resolveTmuxBin()) return null;
  const t = new TmuxHost(SOCKET);
  try {
    return await fn(t);
  } finally {
    // El servidor de prueba entero, no sólo sus sesiones: la conf de ORCA lo
    // deja vivo sin sesiones (exit-empty off) y cada corrida dejaba uno más.
    await t.killServer();
  }
}

async function until(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(60);
  }
  return false;
}

const tests = [
  test('read-only observer in another session cannot block or redirect paste and named keys', async () => {
    const r = await withTmux(async (t) => {
      const target = 'orca-routing-target';
      const observer = 'orca-routing-observer';
      for (const name of [target, observer]) {
        const s = await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/sh', '-c', 'while IFS= read -r line; do printf "received:<%s>\\n" "$line"; done'] });
        if (!s.ok) return { ok: false, detail: s.detail };
      }
      const rw = t.attach(target, 80, 24);
      if (!rw.ok) return { ok: false, detail: rw.detail };
      rw.tty.onData(() => {});
      const pty = createRequire(import.meta.url)('node-pty');
      const ro = pty.spawn(t.bin, ['-L', t.socket, 'attach-session', '-r', '-t', `=${observer}`], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: '/',
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TERM: 'xterm-256color' },
      });
      ro.onData(() => {});
      const clients = () => execFileSync(t.bin!, ['-L', t.socket, 'list-clients', '-F', '#{session_name}:#{client_readonly}'], { encoding: 'utf8' });
      try {
        const ready = await until(async () => clients().includes(`${observer}:1`), 3000);
        const pasted = await t.paste(target, 'only-target');
        const keys = await t.keys(target, ['Enter']);
        const delivered = await until(async () => (await t.capture(target, 20)).stdout.includes('received:<only-target>'), 3000);
        // Also works with no writable viewer attached anywhere.
        rw.tty.kill();
        await until(async () => !clients().includes(`${target}:0`), 3000);
        const second = await t.paste(target, 'without-viewer');
        const deliveredAgain = await until(async () => (await t.capture(target, 20)).stdout.includes('received:<without-viewer>'), 3000);
        const other = await t.capture(observer, 20);
        return { ok: ready && pasted.ok && keys.ok && second.ok && delivered && deliveredAgain
          && !other.stdout.includes('received:') && !other.stdout.includes('only-target')
          && clients().includes(`${observer}:1`), detail: JSON.stringify({ pasted, keys, second, delivered, deliveredAgain }) };
      } finally { ro.kill(); try { rw.tty.kill(); } catch { /* already detached */ } }
    });
    return ok('read-only observer cannot change routing or permissions', r === null || r.ok, r?.detail ?? 'tmux unavailable');
  }),
  test('el nombre del pane se deriva del id de sesión, y vuelve', () => {
    const sid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const name = paneName(sid);
    return ok('el nombre del pane se deriva del id de sesión, y vuelve',
      name === `orca-${sid}` && sessionIdOfPane(name!) === sid && paneName('a b') === null && sessionIdOfPane('otra-cosa') === null,
      `${name}`);
  }),

  test('un argv con ";" suelto se rechaza antes de tocar tmux', async () => {
    const t = new TmuxHost(SOCKET);
    const r = await t.spawn({ name: 'orca-rechazo', cwd: '/', env: {}, argv: ['/bin/echo', 'a', ';', 'b'] });
    return ok('un argv con ";" suelto se rechaza antes de tocar tmux',
      !r.ok && /";"/.test(r.detail), r.detail);
  }),

  test('las líneas del modo control se leen: %output con su pane, %exit, y el resto es ruido', () => {
    return eq('parse', [
      parseControlLine('%output %12 Sun Sep  6 11:04:28\\015\\012'),
      parseControlLine('%exit'),
      parseControlLine('%exit detached'),
      parseControlLine('%begin 1788663845 284 0'),
      parseControlLine('%session-changed $0 t'),
    ], [{ kind: 'output', pane: '%12' }, { kind: 'exit' }, { kind: 'exit' }, null, null]);
  }),

  test('un cliente de control avisa cuando el pane pinta y cuando la sesión muere', async () => {
    const name = 'orca-watch-test-0001';
    const r = await withTmux(async (t) => {
      const spawned = await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/sh', '-c', 'while true; do date; sleep 0.2; done'] });
      if (!spawned.ok) return { ok: false, detail: spawned.detail };
      let outputs = 0;
      let exited = '';
      const w = t.watchOutput(name, { output: () => { outputs++; }, exit: (reason) => { exited = reason; } });
      if (!w) return { ok: false, detail: 'watchOutput devolvió null' };
      const painted = await until(async () => outputs >= 2, 3000);
      await t.kill(name);
      const gone = await until(async () => exited !== '', 3000);
      w.close();
      return { ok: painted && gone, detail: `outputs=${outputs} exit="${exited}"` };
    });
    if (r === null) return ok('un cliente de control avisa cuando el pane pinta y cuando la sesión muere', true, 'sin tmux en esta máquina');
    return ok('un cliente de control avisa cuando el pane pinta y cuando la sesión muere', r.ok, r.detail);
  }),

  test('un pane arranca con su argv intacto y su env, y se lista', async () => {
    const name = 'orca-argv-test-0001';
    const r = await withTmux(async (t) => {
      const spawned = await t.spawn({
        name, cwd: '/', env: { ORCA_PROBE: 'a b' },
        argv: ['/bin/sh', '-c', 'printf "argv:[%s] env:[%s]\\n" "$0" "$ORCA_PROBE"; sleep 20', 'x;y z'],
      });
      if (!spawned.ok) return { ok: false, detail: spawned.detail };
      const listed = await until(async () => (await t.list()).has(name), 3000);
      const cap = await t.capture(name, 5);
      return { ok: listed && cap.stdout.includes('argv:[x;y z] env:[a b]'), detail: `listed=${listed} screen="${cap.stdout.trim()}"` };
    });
    if (r === null) return ok('un pane arranca con su argv intacto y su env, y se lista', true, 'sin tmux en esta máquina');
    return ok('un pane arranca con su argv intacto y su env, y se lista', r.ok, r.detail);
  }),

  test('paste entrega texto multilínea como un solo mensaje, y Enter después', async () => {
    const name = 'orca-paste-test-0001';
    const r = await withTmux(async (t) => {
      const spawned = await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/cat'] });
      if (!spawned.ok) return { ok: false, detail: spawned.detail };
      await until(async () => (await t.list()).has(name), 3000);
      const pasted = await t.paste(name, 'línea uno "con" $comillas\nlínea dos');
      if (!pasted.ok) return { ok: false, detail: pasted.detail };
      const seen = await until(async () => (await t.capture(name, 10)).stdout.includes('línea dos'), 3000);
      const cap = await t.capture(name, 10);
      return { ok: seen && cap.stdout.includes('línea uno "con" $comillas'), detail: cap.stdout.trim().replace(/\n/g, ' ⏎ ') };
    });
    if (r === null) return ok('paste entrega texto multilínea como un solo mensaje', true, 'sin tmux en esta máquina');
    return ok('paste entrega texto multilínea como un solo mensaje', r.ok, r.detail);
  }),

  test('concurrent messages arrive as separate ordered submissions', async () => {
    const r = await withTmux(async (t) => {
      const name = 'orca-ordered-test-0001';
      const started = await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/sh', '-c', 'read -r a; read -r b; printf "received:<%s>|<%s>\\n" "$a" "$b"; sleep 5'] });
      if (!started.ok) return false;
      const results = await Promise.all([t.paste(name, 'first-message'), t.paste(name, 'second-message')]);
      const received = await until(async () => (await t.capture(name, 20)).stdout.includes('received:<first-message>|<second-message>'), 3000);
      return results.every((r) => r.ok) && received;
    });
    return ok('concurrent messages arrive separately and in order', r === null || r, r === null ? 'tmux unavailable' : 'two messages, two submissions');
  }),

  test('attach devuelve un pty con los bytes del pane y acepta teclado', async () => {
    const name = 'orca-attach-test-0001';
    const r = await withTmux(async (t) => {
      const spawned = await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/cat'] });
      if (!spawned.ok) return { ok: false, detail: spawned.detail };
      await until(async () => (await t.list()).has(name), 3000);
      const att = t.attach(name, 80, 24);
      if (!att.ok) return { ok: false, detail: att.detail };
      let out = '';
      att.tty.onData((d) => { out += d; });
      await sleep(300);
      att.tty.write('hola-desde-el-pty\r');
      const echoed = await until(async () => out.includes('hola-desde-el-pty'), 3000);
      att.tty.kill();
      // Soltar el pty no mata el pane: el agente sigue.
      await sleep(200);
      const still = await t.has(name);
      return { ok: echoed && still, detail: `echoed=${echoed} paneAlive=${still} bytes=${out.length}` };
    });
    if (r === null) return ok('attach devuelve un pty con los bytes del pane', true, 'sin tmux en esta máquina');
    return ok('attach devuelve un pty con los bytes del pane', r.ok, r.detail);
  }),

  test('kill cierra el pane y has() lo dice', async () => {
    const name = 'orca-kill-test-0001';
    const r = await withTmux(async (t) => {
      await t.spawn({ name, cwd: '/', env: {}, argv: ['/bin/sleep', '30'] });
      await until(async () => t.has(name), 3000);
      const before = await t.has(name);
      await t.kill(name);
      const after = await until(async () => !(await t.has(name)), 3000);
      return { ok: before && after, detail: `before=${before} gone=${after}` };
    });
    if (r === null) return eq('kill cierra el pane y has() lo dice', true, true, 'sin tmux en esta máquina');
    return ok('kill cierra el pane y has() lo dice', r.ok, r.detail);
  }),
];

const suite: TestModule = { suite: 'collector · tmux', tests };
export default suite;
