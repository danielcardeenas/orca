import { prepareProvider } from '../src/collector/provider-handoff.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
const p = JSON.parse(process.argv[2]!) as ProviderHandoffPlan;
process.stdout.write(JSON.stringify(await prepareProvider(p, 'Isolated preparation; no history. ORCA_HANDOFF_READY_fixture')));
