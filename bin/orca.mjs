#!/usr/bin/env node
/**
 * orca — the fleet, from a shell.
 *
 * The operator's side of ORCA's command surface. Everything here is one HTTP
 * call to the hub's MCP server — the same `launch_squad`, `list_fleet`,
 * `stop_squad` that CAPCOM has — dressed for a terminal, so a fleet can be
 * driven from a script, a cron, an ssh session, or a phone with a shell on it,
 * with no browser and no model in the loop.
 *
 *   orca ls                                    the fleet: projects, blocked, squads
 *   orca ls --blocked                          only what is waiting on a human
 *   orca inspect K9                            one agent, in full
 *   orca inspect squad:audit-01                one squad, in full
 *   orca spawn AX "<brief>" [--squad s --lead] one agent on a project
 *   orca squad audit --project AX \
 *        --lead "<brief>" --member "<brief>" --member @deps.md
 *                                              a squad: lead first, members off it
 *   orca fleets [--full]                       the saved presets
 *   orca launch audit [--project AX]           launch a preset
 *   orca say K9 "<text>"                       text into a running agent
 *   orca tell "<subject>" --to squad:audit-01 --kind warning [--body ...]
 *   orca stop K9 --reason "<why>"              stop one; `squad:<name>` stops all
 *   orca traffic [--waiting]                   what the agents say to each other
 *   orca recall "<question>"                   what the human already answered
 *   orca remember "<question>" "<rule>"        a standing rule
 *   orca tools                                 every verb the hub serves
 *   orca health                                is the hub up, and who is on it
 *
 * A brief argument beginning with `@` is read from that file: briefs are long,
 * and a shell line is not where they should live.
 *
 * Where the hub is:  --hub URL · ORCA_HUB_HTTP · ORCA_HUB_URL (ws:// is fine)
 *                    · default http://127.0.0.1:4479
 * The token:         --token · ORCA_TOKEN · ~/.orca/token (ORCA_HOME moves it)
 *
 * `--json` prints the tool's result as JSON and nothing else, for scripts.
 *
 * Exit codes:
 *   0  done
 *   1  bad usage
 *   2  the hub could not be reached, or refused the token
 *   3  the hub answered, and the tool said no (unknown agent, thin brief…)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);

/* ── Arguments ────────────────────────────────────────────────────── */

/**
 * `--name value`, `--name=value`, `--flag`, repeated `--member a --member b`,
 * and bare positionals, in one pass. `--` ends options.
 */
function parse(args) {
  const opts = {};
  const pos = [];
  const multi = new Set(['member']);
  const flags = new Set(['json', 'blocked', 'waiting', 'full', 'fg', 'help', 'h']);
  // `--lead` is a flag on `spawn` and carries the lead's brief on `squad`.
  const maybe = new Set(['lead']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (maybe.has(key)) val = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
    else if (!flags.has(key)) val = args[++i];
    else val = true;
    if (multi.has(key)) (opts[key] ??= []).push(val);
    else opts[key] = val;
  }
  return { opts, pos };
}

const { opts, pos } = parse(argv);
const json = opts.json === true;

function usage() {
  console.log(`orca — drive the fleet from a shell

  orca ls [--blocked]                          projects, who is blocked, squads
  orca inspect <K9 | squad:name>               one agent or one squad, in full
  orca spawn <project> "<brief>"               one agent · --squad s [--lead] --parent K9 --model m --fg
  orca squad <name> --project <p> --lead "<brief>" --member "<brief>" [--member ...]
                                               a squad: lead first, members hanging off it
  orca fleets [--full]                         the saved presets (~/.orca/fleets)
  orca launch <preset> [--project <p>]         launch a preset
  orca say <K9> "<text>"                       text into a running agent
  orca tell "<subject>" --to <K9|project:p|squad:s> [--kind notice|handoff|warning] [--body "..."]
  orca stop <K9 | squad:name> --reason "<why>"
  orca traffic [--waiting] [--project <p>]
  orca recall "<question>"  ·  orca remember "<question>" "<rule>" [--project <p>]
  orca tools  ·  orca health

  A <project> is its code (AX), its name, or its id. A brief beginning with @
  is read from that file. --json prints the result as JSON, for scripts.

  --hub URL      ORCA_HUB_HTTP / ORCA_HUB_URL     default http://127.0.0.1:4479
  --token T      ORCA_TOKEN / ~/.orca/token

  Exit: 0 done · 1 usage · 2 hub unreachable or token refused · 3 the tool said no`);
}

/* ── Where the hub is ─────────────────────────────────────────────── */

function hubUrl() {
  const raw = opts.hub ?? process.env.ORCA_HUB_HTTP ?? process.env.ORCA_HUB_URL ?? 'http://127.0.0.1:4479';
  return String(raw)
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/ws\/collector\/?$/, '')
    .replace(/\/+$/, '');
}

function token() {
  if (opts.token) return String(opts.token);
  if (process.env.ORCA_TOKEN) return process.env.ORCA_TOKEN.trim();
  const home = process.env.ORCA_HOME ?? join(homedir(), '.orca');
  const file = join(home, 'token');
  try { if (existsSync(file)) return readFileSync(file, 'utf8').trim(); } catch { /* no token file */ }
  return '';
}

const HUB = hubUrl();
const TOKEN = token();

function fail(code, message) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`orca: ${message}`);
  process.exit(code);
}

/* ── Talking to the hub ───────────────────────────────────────────── */

async function http(method, path, body) {
  let res;
  try {
    res = await fetch(`${HUB}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    fail(2, `cannot reach the hub at ${HUB} — ${err.message}. Is it running? (--hub, ORCA_HUB_URL)`);
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (res.status === 401) {
    fail(2, `the hub at ${HUB} refused the token. Pass --token, set ORCA_TOKEN, or read ~/.orca/token on the hub's machine.`);
  }
  return { status: res.status, body: parsed, text };
}

let rpcId = 0;

/** One MCP tool, by name. Returns `{ summary, result, isError }`. */
async function tool(name, args) {
  const { status, body } = await http('POST', '/mcp', {
    jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args },
  });
  if (status !== 200 || !body || body.error) {
    fail(2, `the hub answered ${status}: ${body?.error?.message ?? 'not a tool result'}`);
  }
  const r = body.result ?? {};
  const text = r.content?.[0]?.text ?? '{}';
  let out;
  try { out = JSON.parse(text); } catch { out = { summary: text, result: text }; }
  return { summary: out.summary ?? '', result: out.result, isError: r.isError === true };
}

/** The whole world, for resolving what a person typed into what the hub wants. */
async function world() {
  const { status, body } = await http('GET', '/api/world');
  if (status !== 200 || !body) fail(2, `the hub answered ${status} to /api/world`);
  return body;
}

/**
 * A project the way a person names it — "AX", "axolots", or the id — into the
 * id the tools take. Ambiguity is an error, never a guess: a spawn on the
 * wrong repo is an hour of somebody's output in the wrong place.
 */
async function projectId(ref) {
  if (!ref) return null;
  const w = await world();
  const all = Object.values(w.projects ?? {});
  const r = String(ref).trim().toLowerCase();
  const exact = all.filter((p) => p.id === ref);
  if (exact.length === 1) return exact[0].id;
  const byCode = all.filter((p) => String(p.code).toLowerCase() === r);
  if (byCode.length === 1) return byCode[0].id;
  const byName = all.filter((p) => String(p.name).toLowerCase() === r);
  if (byName.length === 1) return byName[0].id;
  const hits = [...byCode, ...byName];
  if (hits.length > 1) {
    fail(1, `"${ref}" matches ${hits.length} projects: ${hits.map((p) => `${p.code} ${p.name} (${p.id})`).join(', ')} — use the id`);
  }
  fail(1, `no project "${ref}". Known: ${all.map((p) => `${p.code} ${p.name}`).join(', ') || 'none — is a collector running?'}`);
}

/** `@path` reads the file; anything else is the text itself. */
function brief(v) {
  if (typeof v !== 'string') return '';
  if (!v.startsWith('@')) return v;
  const file = resolve(v.slice(1));
  try { return readFileSync(file, 'utf8').trim(); } catch (err) { fail(1, `cannot read brief ${file}: ${err.message}`); }
}

/* ── Output ───────────────────────────────────────────────────────── */

function print(out) {
  if (json) {
    console.log(JSON.stringify({ ok: !out.isError, summary: out.summary, result: out.result }, null, 2));
  } else if (out.isError) {
    console.error(`orca: ${typeof out.result === 'string' ? out.result : out.summary}`);
  } else {
    console.log(out.summary);
  }
  if (out.isError) process.exit(3);
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;

function printFleet(r) {
  const projects = r.projects ?? [];
  const blocked = r.blocked ?? [];
  const squads = r.squads ?? [];
  if (!projects.length) console.log('no agents in the fleet window');
  for (const p of projects) {
    const by = p.by_state ?? {};
    const states = ['booting', 'thinking', 'working', 'blocked', 'idle', 'done', 'dead']
      .filter((s) => by[s]).map((s) => `${by[s]} ${s}`).join(' · ');
    console.log(`${pad(p.code, 4)} ${pad(p.name, 22)} ${pad(p.branch ?? '', 14)} ${pad(`${p.agents} agents`, 10)} ${pad(money(p.spend_usd), 8)} ${states}`);
  }
  if (blocked.length) {
    console.log('\nwaiting on a human:');
    for (const b of blocked) {
      console.log(`  ${pad(b.callsign, 5)} ${pad(`${b.waiting_sec ?? '?'}s`, 7)} ${b.wants ?? ''}`);
    }
  }
  if (squads.length) {
    console.log('\nsquads:');
    for (const s of squads) {
      console.log(`  ${pad(s.name, 20)} lead ${pad(s.lead ?? '—', 6)} ${s.members.join(' ')}`);
    }
  }
}

function printSquad(r) {
  console.log(`${r.name}  ·  ${r.totals.alive}/${r.totals.members} alive · ${r.totals.blocked} blocked · ${money(r.totals.spend_usd)}`);
  for (const m of r.members) {
    console.log(`  ${pad(m.callsign, 5)} ${pad(m.lead ? 'LEAD' : '', 5)} ${pad(m.state, 9)} ${pad(m.tool ?? '', 10)} ${m.blocked_on ? `! ${m.blocked_on}` : (m.mission ?? '')}`);
  }
  if (r.waiting?.length) {
    console.log('  waiting:');
    for (const w of r.waiting) console.log(`    ${w.message_id}  ${w.from} → ${w.to}  ${w.subject}  (${w.age_sec}s)`);
  }
}

function printLaunch(r) {
  console.log(`squad ${r.squad} on ${r.project} (${r.source})`);
  if (r.lead) console.log(`  lead     ${r.lead.callsign ?? '(pending)'} ${r.lead.agent_id ?? ''}`);
  for (const m of r.members ?? []) console.log(`  member ${String(m.member).padStart(2, '0')} ${m.callsign ?? '(pending)'} ${m.agent_id ?? ''}`);
  for (const f of r.failures ?? []) console.log(`  member ${String(f.member).padStart(2, '0')} FAILED  ${f.error}`);
  if (r.note) console.log(`  note: ${r.note}`);
  console.log(`  address: ${r.address}`);
}

function printFleets(r) {
  const list = r.presets ?? [];
  if (!list.length) { console.log(typeof r === 'string' ? r : 'no presets saved'); return; }
  for (const p of list) {
    console.log(`${p.name}  ·  ${p.agents.length} agents  ·  ${p.squad}${p.project ? `  ·  project ${p.project}` : ''}`);
    for (const a of p.agents) {
      console.log(`  ${a.lead ? 'LEAD ' : '     '}${a.mission}`);
      if (a.prompt) console.log(`       ${a.prompt.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
}

function printTraffic(r) {
  const msgs = r.messages ?? [];
  if (!msgs.length) console.log('no traffic');
  for (const m of msgs) {
    console.log(`${pad(m.kind, 8)} ${pad(m.from, 5)} → ${pad(m.to, 14)} ${m.waiting ? '⏳ ' : ''}${m.subject}  (${m.age_sec}s)${m.answer ? `\n         ↳ ${m.answer}` : ''}`);
  }
  for (const c of r.collisions ?? []) {
    console.log(`COLLISION ${c.path}  ${c.agents.join(' + ')}  (${c.open_sec}s${c.acknowledged ? ', acknowledged' : ''})`);
  }
}

/* ── Commands ─────────────────────────────────────────────────────── */

const cmd = pos[0];

/** A ref like `squad:audit-01` → the squad name; anything else → null. */
function squadOf(ref) {
  return typeof ref === 'string' && ref.startsWith('squad:') ? ref.slice(6) : null;
}

async function main() {
  if (!cmd || opts.help || opts.h || cmd === 'help') { usage(); process.exit(cmd ? 0 : 1); }

  switch (cmd) {
    case 'ls': case 'fleet': case 'list': {
      const out = await tool('list_fleet', { only_blocked: opts.blocked === true });
      if (json || out.isError) return print(out);
      return printFleet(out.result);
    }

    case 'inspect': case 'show': {
      const ref = pos[1];
      if (!ref) fail(1, 'inspect what? a callsign like K9, or squad:<name>');
      const sq = squadOf(ref);
      const out = sq
        ? await tool('inspect_squad', { squad: sq })
        : await tool('inspect_agent', { agent_id: ref });
      if (json || out.isError) return print(out);
      if (sq) return printSquad(out.result);
      return console.log(JSON.stringify(out.result, null, 2));
    }

    case 'spawn': {
      const [, proj, mission] = pos;
      if (!proj || !mission) fail(1, 'orca spawn <project> "<brief>"');
      const out = await tool('spawn_agent', {
        project_id: await projectId(proj),
        mission: brief(mission),
        parent_agent_id: opts.parent ?? null,
        background: opts.fg !== true,
        squad: opts.squad ?? null,
        lead: opts.lead === true,
      });
      if (json || out.isError) return print(out);
      const s = out.result?.spawned ?? {};
      return console.log(`${out.summary}${s.callsign ? ` → ${s.callsign} ${s.agentId ?? ''}` : ''}`);
    }

    case 'squad': {
      const name = pos[1];
      if (!name) fail(1, 'orca squad <name> --project <p> --lead "<brief>" --member "<brief>" [--member ...]');
      if (!opts.lead || opts.lead === true) fail(1, 'a squad needs --lead "<brief>": the one that hands work out and answers for the rest');
      const members = (opts.member ?? []).map(brief);
      if (!members.length) fail(1, 'a squad needs at least one --member "<brief>"');
      const out = await tool('launch_squad', {
        project_id: await projectId(opts.project),
        preset: null,
        squad: name,
        lead_mission: brief(opts.lead),
        lead_model: opts['lead-model'] ?? null,
        members: members.map((m) => ({ mission: m, model: opts.model ?? null })),
        background: opts.fg !== true,
      });
      if (json || out.isError) return print(out);
      return printLaunch(out.result);
    }

    case 'launch': {
      const preset = pos[1];
      if (!preset) fail(1, 'orca launch <preset> [--project <p>]  ·  see `orca fleets`');
      const out = await tool('launch_squad', {
        project_id: opts.project ? await projectId(opts.project) : null,
        preset,
        squad: null, lead_mission: null, members: null, lead_model: null,
        background: opts.fg !== true,
      });
      if (json || out.isError) return print(out);
      return printLaunch(out.result);
    }

    case 'fleets': case 'presets': {
      const out = await tool('list_fleets', { full: opts.full === true });
      if (json || out.isError) return print(out);
      return printFleets(out.result);
    }

    case 'say': {
      const [, ref, text] = pos;
      if (!ref || !text) fail(1, 'orca say <K9> "<text>"');
      return print(await tool('send_to_agent', { agent_id: ref, text: brief(text) }));
    }

    case 'tell': case 'relay': {
      const subject = pos[1];
      const to = opts.to;
      if (!subject || !to) fail(1, 'orca tell "<subject>" --to <K9|project:p|squad:s> [--kind notice|handoff|warning] [--body "..."]');
      const kind = opts.kind ?? 'notice';
      if (!['notice', 'handoff', 'warning'].includes(kind)) fail(1, `--kind is notice, handoff or warning (not ${kind})`);
      const sq = squadOf(to);
      const proj = String(to).startsWith('project:') ? await projectId(String(to).slice(8)) : null;
      return print(await tool('relay', {
        kind,
        agent_id: sq || proj ? null : to,
        project_id: proj,
        squad: sq,
        subject,
        body: opts.body ? brief(opts.body) : null,
      }));
    }

    case 'stop': {
      const ref = pos[1];
      if (!ref) fail(1, 'orca stop <K9 | squad:name> --reason "<why>"');
      const reason = opts.reason ?? pos[2] ?? '';
      if (!reason) fail(1, 'say why: --reason "<why>". It is written into the agent\'s record.');
      const sq = squadOf(ref);
      return print(sq
        ? await tool('stop_squad', { squad: sq, reason })
        : await tool('stop_agent', { agent_id: ref, reason }));
    }

    case 'traffic': {
      const out = await tool('read_traffic', {
        project_id: opts.project ? await projectId(opts.project) : null,
        kind: opts.kind ?? null,
        only_waiting: opts.waiting === true,
      });
      if (json || out.isError) return print(out);
      return printTraffic(out.result);
    }

    case 'recall': {
      const q = pos[1];
      if (!q) fail(1, 'orca recall "<question>"');
      const out = await tool('recall', { question: q, project_id: opts.project ? await projectId(opts.project) : null });
      if (json || out.isError) return print(out);
      if (typeof out.result === 'string') return console.log(out.result);
      for (const h of out.result) console.log(`${h.similarity}  ${h.past_question}\n      ↳ ${h.answer}`);
      return;
    }

    case 'remember': {
      const [, q, rule] = pos;
      if (!q || !rule) fail(1, 'orca remember "<question as an agent would ask it>" "<the rule>" [--project <p>]');
      return print(await tool('remember', {
        question: q, answer: rule, project_id: opts.project ? await projectId(opts.project) : null,
      }));
    }

    case 'tools': {
      const { status, body } = await http('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      if (status !== 200 || !body?.result) fail(2, `the hub answered ${status}`);
      const list = body.result.tools ?? [];
      if (json) return console.log(JSON.stringify(list, null, 2));
      for (const t of list) console.log(`${pad(t.name, 20)} ${t.description.split('. ')[0]}.`);
      return;
    }

    case 'health': {
      const { status, body } = await http('GET', '/api/health');
      if (json) return console.log(JSON.stringify(body, null, 2));
      if (status !== 200) fail(2, `the hub answered ${status}`);
      const c = body.connections ?? {};
      return console.log(`hub ${HUB} up · ${c.collectors ?? 0} collectors · ${c.consoles ?? 0} consoles · protocol ${body.protocol ?? '?'}`);
    }

    default:
      fail(1, `unknown command "${cmd}". Try: orca help`);
  }
}

main().catch((err) => fail(2, err.message));
