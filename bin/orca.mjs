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
 *   orca retire K9 --reason "<why>"            declare a ghost gone: its session gets marked dead
 *                                              and stops generating notices nobody can silence
 *   orca land K9 [--no-tests] [--message "…"]  a worker's branch into the project's (ORCA_WORKTREES=1)
 *   orca discard K9 [--force]                  drop a worker's worktree and branch
 *   orca archive [--project AX] [--squad s] [--older-than 24h] [--state done|dead] [--dry-run]
 *                                              archive finished agents (done/dead) on the hub
 *   orca traffic [--waiting]                   what the agents say to each other
 *   orca recall "<question>"                   what the human already answered
 *   orca remember "<question>" "<rule>"        a standing rule
 *   orca journal [--project AX --squad s --kind end --since 24h --text "..."]
 *                                              the fleet journal: launches, ends, escalations, rotations
 *   orca journal --stats [--project AX --since 7d]
 *                                              cost and duration per project, done vs dead, briefs that escalated
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
  const flags = new Set(['json', 'blocked', 'waiting', 'full', 'fg', 'help', 'h', 'dry-run', 'hidden', 'stats', 'asc', 'no-tests', 'force', 'synthetic']);
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
  orca spawn <project> "<brief>"               one agent · --squad s [--lead] --parent K9 --model m --runtime codex --fg
  orca squad <name> --project <p> --lead "<brief>" --member "<brief>" [--member ...]
                                               a squad: lead first, members hanging off it
  orca fleets [--full]                         the saved presets (~/.orca/fleets)
  orca launch <preset> [--project <p>]         launch a preset
      --machine <host|id>                      spawn, squad, launch: run it on that machine. Without it, a repo
                                               cloned on several machines goes to the least busy one
  orca say <K9> "<text>"                       text into a running agent
  orca tell "<subject>" --to <K9|project:p|squad:s> [--kind notice|handoff|warning] [--body "..."]
  orca stop <K9 | squad:name> --reason "<why>"
  orca retire <K9 | agent-id> --reason "<why>"
                                               the way out for a ghost: a session whose pane and process
                                               are gone but that the hub still counts alive, so it keeps
                                               firing notices no tool can silence. Marks it dead with your
                                               reason and makes it archivable. Check it really is gone
                                               (tmux -L orca ls, pgrep); if it keeps working, the hub
                                               undoes the burial on its own.
  orca land <K9 | squad:name> [--no-tests] [--message "<title>"]
                                               rebase a worker's branch onto the project's, run the suite, one commit
  orca discard <K9 | squad:name> [--force]     drop a worker's worktree and branch; --force even with unlanded work
  orca purge-transcripts [--yes]                delete the transcripts of ALREADY ARCHIVED agents;
                                               frees real space and cannot be undone; counts without --yes
  orca archive [--project <p>] [--squad <s>] [--older-than 24h|2d] [--state done|dead] [--hidden] [--dry-run]
                                               archive finished agents on the hub; --dry-run only counts;
                                               --hidden only the ones left in CAPCOM's directory or a scratchpad
  orca traffic [--waiting] [--project <p>]
  orca recall "<question>"  ·  orca remember "<question>" "<rule>" [--project <p>]
  orca journal [--project <p>] [--squad <s>] [--task <id>] [--agent <K9>] [--kind launch|end|escalation|answer|rotation|landing]
               [--since 24h|2d|<iso>] [--until ...] [--state done|dead] [--by human|capcom|agent] [--text "..."]
               [--limit 50] [--asc] [--full] [--synthetic]
                                               what the fleet has done, newest first; --synthetic adds the
                                               test-harness entries, which every count leaves out
  orca journal --stats [--project <p>] [--squad <s>] [--since 7d]
                                               cost and duration per project, done vs dead, briefs that escalated
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
 *
 * One exception, which is not ambiguity: the same repository cloned on two
 * machines is two projects with one code and one path. Those are handed to
 * the hub by code, and the hub sends the work to the least busy clone —
 * unless `--machine` names one, in which case only that machine's clone
 * counts.
 */
async function projectId(ref, machineRef = null) {
  if (!ref) return null;
  const w = await world();
  const machines = Object.values(w.machines ?? {});
  let all = Object.values(w.projects ?? {});
  if (machineRef) {
    const m = machineId(machines, machineRef);
    all = all.filter((p) => p.machineId === m);
  }
  const r = String(ref).trim().toLowerCase();
  const exact = all.filter((p) => p.id === ref);
  if (exact.length === 1) return exact[0].id;
  const byCode = all.filter((p) => String(p.code).toLowerCase() === r);
  if (byCode.length === 1) return byCode[0].id;
  const byName = all.filter((p) => String(p.name).toLowerCase() === r);
  if (byName.length === 1) return byName[0].id;
  const hits = [...new Set([...byCode, ...byName])];
  if (hits.length > 1) {
    const clones = new Set(hits.map((p) => `${p.code}|${p.path}`)).size === 1
      && new Set(hits.map((p) => p.machineId)).size === hits.length;
    if (clones) return hits[0].code;
    fail(1, `"${ref}" matches ${hits.length} projects: ${hits.map((p) => `${p.code} ${p.name} (${p.id})`).join(', ')} — use the id`);
  }
  const where = machineRef ? ` on ${machineRef}` : '';
  fail(1, `no project "${ref}"${where}. Known: ${all.map((p) => `${p.code} ${p.name}`).join(', ') || 'none — is a collector running?'}`);
}

/** `--machine` the way a person types it — hostname, its first label, or the id — into the id. */
function machineId(machines, ref) {
  const r = String(ref).trim().toLowerCase();
  const hit = machines.find((m) => m.id === ref)
    ?? machines.find((m) => String(m.hostname).toLowerCase() === r)
    ?? machines.find((m) => String(m.hostname).toLowerCase().split('.')[0] === r);
  if (!hit) fail(1, `no machine "${ref}". Reporting: ${machines.map((m) => `${m.hostname}${m.online ? '' : ' (offline)'}`).join(', ') || 'none'}`);
  return hit.id;
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
/**
 * Uso, que es lo que ORCA mide desde el 2026-09-12. El dinero se fue de todas
 * las superficies: la flota va con plan plano y un dólar no medía ningún cobro.
 */
const tokens = (n) => {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
};

/** Los tokens de una entrada `end` del journal: la regla de `ceilingTokens`. */
const entryTokens = (e) => {
  const t = e?.tokens;
  if (!t) return null;
  const base = (t.input ?? 0) + (t.output ?? 0);
  return typeof t.cacheWrite === 'number' ? base + t.cacheWrite : base + (t.cacheRead ?? 0);
};

function printFleet(r) {
  const projects = r.projects ?? [];
  const blocked = r.blocked ?? [];
  const squads = r.squads ?? [];
  if (!projects.length) console.log('no agents in the fleet window');
  for (const p of projects) {
    const by = p.by_state ?? {};
    const states = ['booting', 'thinking', 'working', 'blocked', 'idle', 'done', 'dead']
      .filter((s) => by[s]).map((s) => `${by[s]} ${s}`).join(' · ');
    console.log(`${pad(p.code, 4)} ${pad(p.name, 22)} ${pad(p.branch ?? '', 14)} ${pad(`${p.agents} agents`, 10)} ${pad(tokens(p.tokens), 8)} ${states}`);
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
  console.log(`${r.name}  ·  ${r.totals.alive}/${r.totals.members} alive · ${r.totals.blocked} blocked · ${tokens(r.totals.tokens)} tokens`);
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

function printArchive(r, summary) {
  console.log(summary);
  const ago = (s) => s >= 86400 ? `${Math.round(s / 86400)}d` : s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`;
  for (const a of r.archived ?? []) {
    console.log(`  ${pad(a.callsign, 5)} ${pad(a.state, 5)} ${pad(a.project, 4)} ${pad(a.squad ?? '', 14)} ${pad(`${ago(a.finished_ago_sec)} ago`, 8)} ${a.mission ?? ''}`);
  }
  for (const k of r.kept ?? []) console.log(`  ${pad(k.callsign, 5)} kept  ${k.reason}`);
  if (r.squads_retired?.length) console.log(`  squads retired: ${r.squads_retired.join(', ')}`);
  if (r.next) console.log(`  ${r.next}`);
}

/* ── Journal ──────────────────────────────────────────────────────── */

const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(5, 16);
const span = (ms) => {
  const s = Math.round(Number(ms ?? 0) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const rest = Math.round((s % 3600) / 60);
  return `${Math.floor(s / 3600)}h${rest ? `${rest}m` : ''}`;
};
const oneLine = (s, n) => {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One line per entry: when, what, who, and the part of it a person scans for. */
function printJournal(r) {
  const entries = r?.entries ?? [];
  if (!entries.length) return console.log('journal: nothing matches');
  for (const e of entries) {
    const who = `${pad(e.callsign ?? e.agentId ?? '?', 6)} ${pad(e.project ? `[${e.project}]` : '', 6)}`;
    let tail = '';
    switch (e.kind) {
      case 'launch':
        tail = `by ${e.by ?? '?'}${e.squad ? ` · ${e.squad}${e.lead ? ' (lead)' : ''}` : ''}${e.taskId ? ` · ${e.taskId}` : ''} · ${e.runtime ?? '?'}${e.model ? `/${e.model}` : ''}: ${oneLine(e.brief, 100)}`;
        break;
      case 'end':
        tail = `${e.state}${e.late ? ' (late)' : ''} · ${entryTokens(e) === null ? '— tokens' : `${tokens(entryTokens(e))} tokens`} · ${span(e.durationMs)}`
          + (e.lines && (e.lines.added || e.lines.removed) ? ` · +${e.lines.added}/-${e.lines.removed}` : '')
          + (e.taskId ? ` · ${e.taskId}` : '') + (e.lastSay ? `: ${oneLine(e.lastSay, 100)}` : '');
        break;
      case 'escalation':
        tail = `asked${e.urgency === 'blocking' ? ' (BLOCKING)' : ''}: ${oneLine(e.question, 110)}${e.options?.length ? ` [${e.options.join(' | ')}]` : ''}`;
        break;
      case 'answer':
        tail = `answered by ${e.answeredBy ?? '?'}${e.waitedMs != null ? ` after ${span(e.waitedMs)}` : ''}: ${oneLine(e.answer, 80)}${e.question ? `  (re: ${oneLine(e.question, 60)})` : ''}`;
        break;
      case 'rotation':
        tail = `CAPCOM rotated ${e.fromId ?? '?'} → ${e.toId ?? '(never came back)'}`
          + (e.turns != null ? ` · ${e.turns} turns, ${e.compactions ?? 0} compactions` : '') + (e.note ? ` · ${e.note}` : '');
        break;
      case 'landing':
        tail = `${e.ok === false ? 'FAILED to land' : 'landed'}${e.branch ? ` ${e.branch}` : ''}${e.target ? ` → ${e.target}` : ''}${e.commit ? ` @${e.commit}` : ''}${e.detail ? `: ${oneLine(e.detail, 80)}` : ''}`;
        break;
      default:
        tail = oneLine(e.note ?? '', 100);
    }
    console.log(`${when(e.at)}  ${pad(e.kind, 10)} ${who} ${tail}`);
  }
}

function printJournalStats(s) {
  const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
  console.log(`launches ${s.launches} (human ${s.byLauncher?.human ?? 0}, capcom ${s.byLauncher?.capcom ?? 0}, agent ${s.byLauncher?.agent ?? 0})`
    + ` · done ${s.ends?.done ?? 0} / dead ${s.ends?.dead ?? 0} (${pct(s.doneRate)} done)`
    + ` · ${tokens(s.usage?.tokens)} legacy mixed tokens over ${s.usage?.measured ?? 0} measured, ${s.usage?.avgTokens != null ? tokens(s.usage.avgTokens) : '—'} avg, ${s.duration?.avgMs != null ? span(s.duration.avgMs) : '—'} avg`
    // Las mismas cuatro cifras que el digest de AUTOMEJORA y journal_stats:
    // retirada no es sin respuesta, y `open` es lo que sigue sin contestar.
    + ` · escalations ${s.escalations?.asked ?? 0} (capcom ${s.escalations?.answeredByCapcom ?? 0}, human ${s.escalations?.answeredByHuman ?? 0}, withdrawn ${s.escalations?.withdrawn ?? 0}, open ${s.escalations?.unanswered ?? 0})`
    + ` · rotations ${s.rotations ?? 0} · landings ${s.landings?.ok ?? 0} ok / ${s.landings?.failed ?? 0} failed`);
  // Un total que cambia sin explicación al lado es peor que uno equivocado:
  // lo que el diario aparta por ser del arnés se dice aquí, no en un comentario.
  if (s.excluded > 0) console.log(`(${s.excluded} harness entries in this window are NOT counted above)`);
  if (s.byProject?.length) {
    console.log(`\n${pad('project', 8)} ${pad('launch', 6)} ${pad('done', 5)} ${pad('dead', 5)} ${pad('rate', 5)} ${pad('tokens', 9)} ${pad('avg tok', 8)} ${pad('avg time', 9)} esc`);
    for (const p of s.byProject) {
      console.log(`${pad(p.project ?? p.projectId ?? '?', 8)} ${pad(p.launches, 6)} ${pad(p.done, 5)} ${pad(p.dead, 5)} ${pad(pct(p.doneRate), 5)} ${pad(tokens(p.totalTokens), 9)} ${pad(p.avgTokens != null ? tokens(p.avgTokens) : '—', 8)} ${pad(p.avgDurationMs != null ? span(p.avgDurationMs) : '—', 9)} ${p.escalations}`);
    }
  }
  if (s.escalatedBriefs?.length) {
    console.log('\nbriefs that ended in an escalation — write these better next time:');
    for (const b of s.escalatedBriefs) {
      console.log(`  ${pad(b.callsign ?? b.agentId ?? '?', 6)} ${pad(b.project ? `[${b.project}]` : '', 6)} ${b.state ?? 'running'} · asked "${oneLine(b.question, 70)}" → ${b.answeredBy ?? 'unanswered'}`);
      if (b.brief) console.log(`         brief: ${oneLine(b.brief, 110)}`);
    }
  }
}

/**
 * `--older-than 24h`, `2d`, `90m`, or a bare number of hours → hours. The hub
 * takes hours; a shell wants to say "a day".
 */
function hoursOf(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|hours?|d|days?|m|min|minutes?)?\s*$/i.exec(String(v));
  if (!m) fail(1, `--older-than takes hours like 24, 24h, 2d or 90m (not "${v}")`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  return unit.startsWith('d') ? n * 24 : unit.startsWith('m') ? n / 60 : n;
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
        project_id: await projectId(proj, opts.machine ?? null),
        machine: opts.machine ?? null,
        mission: brief(mission),
        parent_agent_id: opts.parent ?? null,
        background: opts.fg !== true,
        squad: opts.squad ?? null,
        lead: opts.lead === true,
        runtime: opts.runtime ?? null,
        model: opts.model ?? null,
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
        project_id: await projectId(opts.project, opts.machine ?? null),
        machine: opts.machine ?? null,
        preset: null,
        squad: name,
        lead_mission: brief(opts.lead),
        lead_model: opts['lead-model'] ?? null,
        runtime: opts.runtime ?? null,
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
        project_id: opts.project ? await projectId(opts.project, opts.machine ?? null) : null,
        machine: opts.machine ?? null,
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

    case 'land': {
      const ref = pos[1];
      if (!ref) fail(1, 'orca land <K9 | squad:name> [--no-tests] [--message "<title>"]');
      const sq = squadOf(ref);
      const out = await tool('land', {
        agent_id: sq ? null : ref, squad: sq,
        run_tests: opts['no-tests'] !== true,
        message: opts.message ?? null,
      });
      if (json) return print(out);
      // The summary is one line; a refusal is the part worth reading in full.
      const r = out.result && typeof out.result === 'object' ? out.result : {};
      console.log(out.summary);
      for (const l of r.landed ?? []) console.log(`  ${l.callsign}  ${String(l.commit).slice(0, 8)} on ${l.onto}  ${(l.files ?? []).length} file(s)${l.tests ? `  tests ok (${l.tests.command}, ${l.tests.seconds}s)` : l.note ? `  ${l.note}` : ''}`);
      for (const f of r.refused ?? []) {
        console.log(`  ${f.callsign}  ${f.reason}: ${f.detail}`);
        for (const c of f.conflicts ?? []) console.log(`      conflict: ${c}`);
        if (f.tests?.output) console.log(`      ${String(f.tests.output).split('\n').slice(-12).join('\n      ')}`);
      }
      if (r.next) console.log(`  next: ${r.next}`);
      if (out.isError) process.exit(3);
      return;
    }

    case 'discard': {
      const ref = pos[1];
      if (!ref) fail(1, 'orca discard <K9 | squad:name> [--force]');
      const sq = squadOf(ref);
      const out = await tool('discard', { agent_id: sq ? null : ref, squad: sq, force: opts.force === true });
      if (json) return print(out);
      const r = out.result && typeof out.result === 'object' ? out.result : {};
      console.log(out.summary);
      for (const k of r.kept ?? []) console.log(`  ${k.callsign}  kept: ${k.detail}`);
      if (r.next) console.log(`  next: ${r.next}`);
      if (out.isError) process.exit(3);
      return;
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

    /**
     * Retirar un fantasma.
     *
     * Está aquí y no sólo en MCP porque una sesión de CAPCOM negocia su lista
     * de herramientas al arrancar: una herramienta que nace después no existe
     * para el CAPCOM en funciones hasta que reconecte. La única salida para un
     * agente fantasma no puede ser algo que quien recibe el aviso no puede
     * invocar. Un terminal siempre está.
     */
    case 'retire': {
      const ref = pos[1];
      if (!ref) fail(1, 'orca retire <K9 | agent-id> --reason "<why>"');
      const reason = opts.reason ?? pos[2] ?? '';
      if (!reason) fail(1, 'say how you know it is gone: --reason "<why>". It goes in the feed and in the tombstone.');
      if (squadOf(ref)) fail(1, 'retire takes one agent: a squad is retired member by member, and each one deserves its own reason.');
      const out = await tool('retire_agent', { agent_id: ref, reason });
      if (json) return print(out);
      console.log(out.summary);
      // Un rechazo trae el motivo en `result` como texto plano, y el motivo es
      // justo lo que el operador necesita: "ya está en done, archívalo" es una
      // instrucción, y tragársela deja al operador con un código de salida.
      if (typeof out.result === 'string' && out.result.trim() && out.result !== out.summary) {
        console.log(`  ${out.result.trim()}`);
      }
      const r = out.result && typeof out.result === 'object' ? out.result : {};
      if (r.retired > 1) console.log(`  ${r.retired} sessions retired (the agent and its Task subagents), ${r.archived} archived`);
      for (const k of r.kept ?? []) console.log(`  ${k.callsign}  kept: ${k.reason}`);
      if (r.next) console.log(`  next: ${r.next}`);
      if (out.isError) process.exit(3);
      return;
    }

    case 'archive': case 'cleanup': {
      const state = opts.state ?? null;
      if (state && state !== 'done' && state !== 'dead') fail(1, `--state is done or dead (not ${state})`);
      const out = await tool('archive_agents', {
        project_id: opts.project ? await projectId(opts.project) : null,
        squad: squadOf(opts.squad) ?? opts.squad ?? null,
        older_than_hours: opts['older-than'] !== undefined ? hoursOf(opts['older-than']) : null,
        state,
        // Lo que quedó fuera de la flota por vivir donde no hay proyecto: el
        // directorio de CAPCOM, un scratchpad de sesión. El campo va siempre,
        // porque el schema de la herramienta lo pide siempre.
        hidden: opts.hidden === true,
        dry_run: opts['dry-run'] === true,
      });
      if (json || out.isError) return print(out);
      return printArchive(out.result, out.summary);
    }

    /*
     * Lo único que borra de verdad, y por eso pide dos pasos: primero
     * `orca archive`, que retira; y sólo lo retirado llega aquí. Sin
     * `--yes` cuenta y no toca nada.
     */
    case 'purge-transcripts': {
      const out = await tool('purge_transcripts', { dry_run: opts.yes !== true });
      if (json || out.isError) return print(out);
      // Sin nada archivado la herramienta contesta en prosa: es el caso normal
      // de quien no ha retirado nada todavía, no un resultado que desglosar.
      const raw = out.result;
      if (typeof raw === 'string' && !raw.trimStart().startsWith('{')) return console.log(raw);
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (d.dry_run) {
        console.log(`${d.purged.length} transcript(s), ${d.kilobytes} KB — nothing deleted`);
        if (d.skipped.length) for (const s of d.skipped.slice(0, 10)) console.log(`  kept ${s.id}: ${s.why}`);
        console.log('run again with --yes to delete them for good');
      } else console.log(`deleted ${d.purged.length} transcript(s), ${d.kilobytes} KB`);
      if (d.errors?.length) for (const e of d.errors) console.log(`  ! ${e}`);
      return;
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

    case 'journal': case 'log': {
      const project = opts.project ? await projectId(opts.project) : null;
      const squad = squadOf(opts.squad) ?? opts.squad ?? null;
      if (opts.stats === true) {
        const out = await tool('journal_stats', { project, squad, since: opts.since ?? null, until: opts.until ?? null });
        if (json || out.isError) return print(out);
        return printJournalStats(out.result);
      }
      const out = await tool('journal', {
        project, squad,
        task_id: opts.task ?? null, agent: opts.agent ?? null, kind: opts.kind ?? null,
        since: opts.since ?? null, until: opts.until ?? null,
        state: opts.state ?? null, by: opts.by ?? null, text: opts.text ?? null,
        limit: opts.limit !== undefined ? Number(opts.limit) : null,
        newest_first: opts.asc !== true, full: opts.full === true,
        // La serie completa, arnés incluido, sólo si se pide por su nombre.
        include_synthetic: opts.synthetic === true,
      });
      if (json || out.isError) return print(out);
      return printJournal(out.result);
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
