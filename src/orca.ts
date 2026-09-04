/**
 * ORCA entry point — hub + CEO in one process.
 *
 *   npx tsx src/orca.ts                 hub and CEO
 *   npx tsx src/orca.ts --no-ceo        hub only (no model calls, no spend)
 *   npx tsx src/orca.ts --port 8080
 *
 * The collector runs separately, on every machine that has agents:
 *   npx tsx src/collector/index.ts
 *
 * Credentials: the CEO reads ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile — whichever it finds. Keys are given to the machine
 * once and never travel over the console link.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startHub } from './hub/server.ts';
import { attachCeo } from './agents/runtime.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const noCeo = flag('no-ceo');
  const port = Number(value('port') ?? process.env['ORCA_PORT'] ?? 4479);

  // Standing orders: whatever the operator has told the CEO about how the
  // fleet should be run, kept in a file so it survives every restart and can
  // be edited without touching code.
  const standingOrders = await readOptional(
    process.env['ORCA_ORDERS'] ?? join(homedir(), '.orca', 'ORDERS.md'),
  );

  // The wiring is circular by nature — the hub needs the CEO's callbacks, the
  // CEO needs the hub — so the hooks are late-bound through this holder.
  let runtime: ReturnType<typeof attachCeo> | null = null;

  const hub = await startHub({
    port,
    onCeoSay: (text) => runtime?.onCeoSay(text),
    onEscalation: (id) => runtime?.onEscalation(id),
  });

  const hasKey = !!(process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']);
  const fake = flag('fake-ceo');
  runtime = attachCeo(hub, {
    disabled: noCeo,
    standingOrders: standingOrders ?? undefined,
    model: process.env['ORCA_MODEL'],
    // Without credentials the scripted CEO takes over. It cannot reason, but
    // it still recalls past answers and still puts everything else in front of
    // the human — which is the behaviour that must never regress.
    fallbackReason: fake ? 'running in --fake-ceo mode'
      : (!hasKey ? 'no Anthropic credentials on this machine' : undefined),
  });

  console.log('');
  if (noCeo) {
    console.log('[ceo] disabled (--no-ceo). Agent questions go straight to the human.');
  } else {
    console.log(`[ceo] ${process.env['ORCA_MODEL'] ?? 'claude-opus-5'}, ` +
      `credentials: ${hasKey ? 'env' : 'ant profile or none'}`);
    if (standingOrders) {
      console.log(`[ceo] standing orders loaded (${standingOrders.length} chars)`);
    } else {
      console.log('[ceo] no standing orders. Write ~/.orca/ORDERS.md to give it a policy.');
    }
    if (fake) {
      console.log('[ceo] --fake-ceo: scripted, deterministic, spends nothing.');
    } else if (!hasKey) {
      console.log('[ceo] ⚠ no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found.');
      console.log('[ceo]   Running the scripted CEO instead: it recalls past answers');
      console.log('[ceo]   and routes everything else to you. Set a key and restart');
      console.log('[ceo]   to get the real one.');
    }
  }
  console.log('');
  console.log(`[orca] console: run \`npx vite\` and open http://127.0.0.1:4478/`);
  console.log(`[orca] collector: run \`npx tsx src/collector/index.ts\` on each machine`);

  const bye = async () => {
    console.log('\n[orca] shutting down');
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error('[orca] failed to start:', err);
  process.exit(1);
});
