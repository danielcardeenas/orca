/**
 * ORCA entry point — the hub, and whatever commands the fleet.
 *
 *   npx tsx src/orca.ts                 hub, ready for a CAPCOM session
 *   npx tsx src/orca.ts --api-command   force the API CEO even if CAPCOM is up
 *   npx tsx src/orca.ts --no-ceo        hub only (no model calls, no spend)
 *   npx tsx src/orca.ts --port 8080
 *
 * The collector runs separately, on every machine that has agents, and exactly
 * one of them carries the command session:
 *   npx tsx src/collector/index.ts
 *   npx tsx src/collector/index.ts --capcom     (on ONE machine)
 *
 * ── Who commands ───────────────────────────────────────────────────
 *
 * CAPCOM is a CLI session out in the fleet whose tools are this hub's MCP
 * server. It runs on the operator's Claude subscription, so commanding a fleet
 * costs no API spend at all. When a live CAPCOM exists the hub routes to it and
 * never calls the API; the API CEO below is the fallback for a machine with no
 * CLI, and the scripted one is the fallback for no credentials at all. No path
 * leaves the fleet without a command.
 *
 * Credentials (fallback only): the API CEO reads ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile — whichever it finds.
 * Keys are given to the machine once and never travel over the console link.
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
  const apiCommand = flag('api-command');
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
    apiCommand,
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

  /*
   * Quién manda, dicho en voz alta al arrancar.
   *
   * Es la primera pregunta que se hace quien mira este log —"¿estoy pagando
   * API?"— y merece una respuesta sin ambigüedad, no una deducción a partir de
   * tres líneas sobre credenciales.
   */
  console.log('');
  if (apiCommand) {
    console.log('[command] API CEO forced (--api-command). A CAPCOM session, if any, gets nothing.');
  } else {
    console.log('[command] CAPCOM when a session is live — zero API spend. It is a CLI session');
    console.log('[command]   on your subscription, and its tools are this hub\'s MCP server:');
    console.log(`[command]   http://localhost:${hub.port}/mcp`);
    console.log('[command]   Start it on ONE machine:  npx tsx src/collector/index.ts --capcom');
    console.log(`[command] Until then, the fallback below commands the fleet.`);
  }
  if (noCeo) {
    console.log('[ceo] fallback disabled (--no-ceo). Without CAPCOM, agent questions go straight to you.');
  } else {
    console.log(`[ceo] fallback: ${process.env['ORCA_MODEL'] ?? 'claude-opus-5'}, ` +
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
      console.log('[ceo]   Running the scripted fallback instead: it recalls past answers');
      console.log('[ceo]   and routes everything else to you. Start CAPCOM, or set a key,');
      console.log('[ceo]   to get a command that can think.');
    }
  }
  console.log('');
  // Bajo `npm run dev` el collector y Vite ya los arrancó concurrently; repetir
  // las instrucciones ahí sólo confunde a quien ya hizo lo correcto.
  if (process.env['npm_lifecycle_event'] === 'dev:orca') {
    console.log('[orca] console → http://127.0.0.1:4478/');
    console.log('[orca] the collector for this machine is already running alongside.');
    console.log('[orca] on any OTHER machine: npx tsx src/collector/index.ts');
  } else {
    console.log('[orca] console:   npx vite   → http://127.0.0.1:4478/');
    console.log('[orca] collector: npx tsx src/collector/index.ts   (on each machine)');
    console.log('[orca] command:   npx tsx src/collector/index.ts --capcom   (on ONE machine)');
    console.log('[orca] or all three at once:  npm run dev');
  }

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
