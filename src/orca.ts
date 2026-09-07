/**
 * ORCA entry point — the hub that CAPCOM commands through.
 *
 *   npx tsx src/orca.ts                 hub, ready for a CAPCOM session
 *   npx tsx src/orca.ts --port 8080
 *
 * The collector runs separately, on every machine that has agents, and exactly
 * one of them carries the command session:
 *   npx tsx src/collector/index.ts              (on the hub's machine: CAPCOM too)
 *   npx tsx src/collector/index.ts --capcom     (to carry CAPCOM on another machine)
 *
 * ── Who commands ───────────────────────────────────────────────────
 *
 * CAPCOM, and only CAPCOM: a CLI session out in the fleet whose tools are this
 * hub's MCP server. It runs on the operator's Claude subscription, so
 * commanding a fleet costs no API spend at all, and this process never calls a
 * model. There used to be a second mind here — an API-driven "CEO" that took
 * over when no CAPCOM was live. It was removed on 2026-09-06: two minds with
 * two names commanding one fleet was the thing the operator could not tell
 * apart. Without CAPCOM nothing pretends to command: what you type gets one
 * plain line saying so, and agent questions go straight to you.
 */

import { startHub } from './hub/server.ts';

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const port = Number(value('port') ?? process.env['ORCA_PORT'] ?? 4479);

  const hub = await startHub({ port });

  /*
   * Quién manda, dicho en voz alta al arrancar.
   *
   * Es la primera pregunta que se hace quien mira este log —"¿estoy pagando
   * API?"— y merece una respuesta sin ambigüedad.
   */
  console.log('');
  console.log('[command] CAPCOM, when a session is live — zero API spend. It is a CLI session');
  console.log('[command]   on your subscription, and its tools are this hub\'s MCP server:');
  console.log(`[command]   http://localhost:${hub.port}/mcp`);
  console.log('[command]   The collector on this machine starts it by default;');
  console.log('[command]   elsewhere: npx tsx src/collector/index.ts --capcom  (ONE machine)');
  console.log('[command]   Without CAPCOM nothing commands this fleet: what you type is recorded,');
  console.log('[command]   and agent questions go straight to you.');
  console.log('');
  // Bajo `npm run dev` el collector y Vite ya los arrancó concurrently; repetir
  // las instrucciones ahí sólo confunde a quien ya hizo lo correcto.
  if (process.env['npm_lifecycle_event'] === 'dev:orca') {
    console.log('[orca] console → http://127.0.0.1:4478/');
    console.log('[orca] the collector for this machine is already running alongside.');
    console.log('[orca] on any OTHER machine: npx tsx src/collector/index.ts');
  } else {
    console.log('[orca] console:   npx vite   → http://127.0.0.1:4478/');
    console.log('[orca] collector: npx tsx src/collector/index.ts   (here: brings CAPCOM up too)');
    console.log('[orca] elsewhere: the same, plus --capcom on ONE machine if not this one');
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

main().catch((err) => {
  console.error('[orca] failed to start:', err);
  process.exit(1);
});
