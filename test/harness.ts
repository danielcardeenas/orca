/**
 * ORCA's own test harness.
 *
 * Two kinds of test, one runner:
 *
 *   unit    — a function returns {name, pass, detail}. No framework, no
 *             globals, no magic. A test file exports `tests` and that is all.
 *   visual  — Playwright drives the real console against a real hub and a
 *             synthetic fleet, and writes PNGs to test/shots/.
 *
 * The visual half is the one that matters for this project. The claim being
 * made is "it looks and moves like the /system comp", and the only way to
 * check a claim like that is to look at it. So the harness makes looking
 * cheap: one command, a folder of frames, every state the console can be in.
 */

export interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export type TestFn = () => TestResult | Promise<TestResult>;

export interface TestModule {
  /** Shown as the section heading. */
  suite: string;
  tests: TestFn[];
}

/* ── Assertions ───────────────────────────────────────────────────── */

export function ok(name: string, cond: boolean, detail = ''): TestResult {
  return { name, pass: cond, detail: cond ? detail : (detail || 'expected true') };
}

export function eq<T>(name: string, actual: T, expected: T, detail = ''): TestResult {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return {
    name,
    pass: a === b,
    detail: a === b ? detail : `expected ${b}, got ${a}${detail ? ` (${detail})` : ''}`,
  };
}

export function near(name: string, actual: number, expected: number, tol: number): TestResult {
  const d = Math.abs(actual - expected);
  return {
    name, pass: d <= tol,
    detail: d <= tol ? `${actual}` : `expected ~${expected} (±${tol}), got ${actual}`,
  };
}

export function throws(name: string, fn: () => unknown, detail = ''): TestResult {
  try { fn(); return { name, pass: false, detail: detail || 'expected a throw' }; }
  catch { return { name, pass: true, detail }; }
}

/** Wrap a body so an unexpected throw fails the test instead of the run. */
export function test(name: string, body: () => TestResult | Promise<TestResult>): TestFn {
  return async () => {
    try {
      return await body();
    } catch (err) {
      return { name, pass: false, detail: `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}` };
    }
  };
}

/* ── Reporting ────────────────────────────────────────────────────── */

const C = {
  dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  amber: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m',
};

export async function runSuite(mod: TestModule): Promise<{ pass: number; fail: number }> {
  process.stdout.write(`\n${C.bold}${mod.suite}${C.off}\n`);
  let pass = 0, fail = 0;
  for (const t of mod.tests) {
    const r = await t();
    if (r.pass) {
      pass++;
      process.stdout.write(`  ${C.green}OK${C.off}   ${r.name}${r.detail ? `  ${C.dim}${r.detail}${C.off}` : ''}\n`);
    } else {
      fail++;
      process.stdout.write(`  ${C.red}FAIL${C.off} ${r.name}\n       ${C.red}${r.detail ?? ''}${C.off}\n`);
    }
  }
  return { pass, fail };
}

/* ── Small helpers used across suites ─────────────────────────────── */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn` is true or the deadline passes. Returns whether it settled. */
export async function until(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** Find a free TCP port, so parallel test runs never collide. */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
