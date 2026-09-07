#!/usr/bin/env node
// Supervisors use the same recovery tools as CAPCOM. Never print credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [action, agent, file, ...extra] = process.argv.slice(2);
if (!['inspect', 'decide'].includes(action) || !agent) {
  console.log('orca-recover inspect <agent-id-or-callsign> [--models]\norca-recover decide <agent-id-or-callsign> <decision.json>\nDecision JSON: incident, action (wait/model/handoff/retry), reason, supervisor_id; optional review_at (epoch ms), model, runtime. Use inspect first.');
  process.exit(action === '--help' ? 0 : 1);
}
try {
  const home = process.env.ORCA_HOME ?? path.join(os.homedir(), '.orca');
  const token = process.env.ORCA_TOKEN ?? fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  const base = process.env.ORCA_HUB_HTTP ?? 'http://127.0.0.1:4479';
  const args = action === 'inspect' ? { agent_id: agent, models: file === '--models' || extra.includes('--models') }
    : { ...JSON.parse(fs.readFileSync(file, 'utf8')), agent_id: agent };
  if (action === 'decide') {
    args.supervisor_id ??= process.env.CLAUDE_SESSION_ID ?? process.env.ORCA_PANE?.replace(/^orca-/, '');
    if (!args.supervisor_id) throw new Error('Include supervisor_id in the decision: your own session id or callsign.');
  }
  const response = await fetch(new URL('/mcp', base), { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: action === 'inspect' ? 'inspect_recovery' : 'recover_agent', arguments: args } }),
  });
  if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}`);
  const out = await response.json();
  if (out.error) throw new Error(out.error.message);
  for (const content of out.result?.content ?? []) if (content.type === 'text') console.log(content.text);
  process.exitCode = out.result?.isError ? 4 : 0;
} catch (e) { console.error('orca-recover:', e.message); process.exitCode = 2; }
