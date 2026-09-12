# ORCA

A containment console for a fleet of Claude Code agents.

You run agents across several machines — a laptop, a VPS, a container. ORCA
shows you all of them at once, tells you which ones need a human, and gives you
one thing to talk to instead of twenty terminal tabs.

It reads what Claude Code already writes to disk. It does not replace Claude
Code, does not wrap it, and does not need it patched.

```
collector  ──(ws, outbound)──▶  hub  ◀──(ws)──  console
 per machine                   │                 browser
   └── CAPCOM ──(MCP/http)─────┘
```

Every connection is **outbound from the machine**. A VPS behind a firewall and a
laptop behind NAT are equivalent citizens; nothing needs an open port but the
hub.

## Run it

```bash
npm install

npx tsx src/orca.ts                    # the hub              (prints your token)
npx tsx src/collector/index.ts         # on each machine with agents
npx vite                               # console → http://127.0.0.1:4478
```

Or all three at once: `npm run dev`.

The collector on the hub's machine also starts **CAPCOM**, the one voice that
speaks to the fleet on your behalf. It is a Claude Code session like any other,
so it runs on your subscription and commanding a fleet costs no API spend at
all. Exactly one machine carries it: the hub's by default, another one with
`--capcom`, none with `--no-capcom`. See [CAPCOM](#capcom).

Without CAPCOM ORCA still runs as a fleet monitor: nothing commands, what you
type is recorded with a line saying so, and every agent question goes straight
to you. The hub itself never calls a model.

## What it shows

There is no dashboard. The whole viewport is **the field**: an infinite,
navigable space you drag or scroll to pan, pinch or ⌘-scroll to zoom, and tilt with `O` to see the
fleet's shape. Depth is attention — agents that need a human ride forward, dead
ones sink back. Behind everything sits the radar's dot grid, so panning feels
like moving rather than nothing happening.

Every agent is a **tile** on that field, a notched rectangle drawn by one
instanced shader. State rides the left edge; a working tile carries a
travelling band whose speed is its tokens/sec; a tile waiting on *you* inverts
to amber and breathes; a dead one is a red ghost. Callsign, project code and
what it is doing appear as real text once the tile is big enough to read.
Projects cluster into outlined regions, and dragging a tile pins it there for
good — your arrangement always beats the automatic one. A whole project moves
as one: drag its label and the region, its outline, its tiles and its squads go
together. A squad moves the same way, by its label or by the gaps inside its
outline. A right-click gives either back its place.

Everything answers a **right-click** with its own menu — a tile, a squad, a
project's label, an artifact on the field, the empty field, a window's chrome,
a tile in the tray, and every row of the fleet, queue and gallery lists. The
rows are the console's own verbs (open, fly, say, spawn, frame, select, stop),
put where the pointer already is; each has a key, and Esc leaves.

Relationships are **pipes**: thick orthogonal runs with square ports. Grey from
parent to child, lime while the child is alive. An unanswered `ask` is amber
and points at whoever owes the answer. A notice is blue and fades over a
minute; a file collision is red and dotted. A message in flight is a bright
square that runs its pipe once.

Everything else is a **window** you open over the field — an agent's interior,
CAPCOM, the interrupt queue, the feed, a project, an artifact. Drag the header
to move it, the corner to resize it. A window is either pinned to an agent, in
which case it follows that tile as the camera moves and draws a tether to it,
or docked to the glass. An interrupt opens itself, anchored to the tile that
raised it, carrying the question, what CAPCOM tried, one-tap options, and
`UNBLOCKS n` — because how many agents a question frees is what decides which
one you answer first. Tick **REMEMBER** and CAPCOM answers it itself next
time.

One **command line** sits at the bottom, always there. Plain text talks to
CAPCOM — the one agent that surveys, spawns with real briefs, unblocks and stops
the ones burning money. `@K9 …` talks to an agent, `@LZ …` to every agent in a
project, and `/spawn /find /frame /queue /ceo /feed /fleet /tilt` do the rest.
Shift-drag lassoes a group and it becomes the target on the line; `Enter` sends
to all of them.

Fold a window with `—` and it goes to the **tray**, a row of notched tiles
bottom-left still lit by the state of what they hold, so a folded window keeps
reporting. Click one and it comes back where it was.

The console also **speaks**: one dry terminal voice per event, muted until `S`,
remapped and auditioned from the SFX window — which also keeps the eleven cuts
of the reference film, score and all, for anyone who wants them.

## Who is on the field

The collectors report every session on the machine; the console decides who
gets a tile. By default that is the fleet: every agent ORCA launched (a
finished one lingers a day, then leaves), plus any other session only while
it works or needs you — an idle one that has not said a line in an hour is a
tab someone left open, not an agent, and goes. `DISMISS` on an agent (H in
its menu, `/dismiss K9`, `/dismiss finished` for every finished one) hides
it now; SETTINGS › SHOW ALL reveals everyone, dismissed included, and BRING
BACK clears the dismissals. Nothing here touches disk: a hidden session is
still watched, and the first thing it does puts it back on the field.

The rule lives in one place, `store.ts`, and every consumer — the field, the
mast counts, the windows, the command line — reads the filtered view.
`updatedAt` is the last line that was conversation (a prompt, a reply, a tool
result), not the file's mtime: an idle Claude Code session appends
housekeeping every half hour, which used to make forty of them look awake.

## The loop that matters

```
agent asks  →  CAPCOM checks memory  →  answers it, and you never see it
                                     →  or cannot, and it lands in your queue
                                        with what it tried and why it punted
you answer  →  goes back to the agent, and into memory
```

The queue gets quieter the more you use it. That is the whole design.

## CAPCOM

In mission control, CAPCOM is the one person allowed to talk to the crew. Here
it is the one session allowed to talk to the fleet on your behalf — and it is a
session, not a service: a Claude Code process in `~/.orca/capcom/`, launched by
a collector, appearing on the field like any other agent with `role: 'capcom'`
on it. Its window is its transcript.

That design decision is the whole point. The command used to be a model loop
inside the hub, paying the API per turn and welded to one vendor's SDK. Moving
it out into a CLI session does three things at once:

- **It costs nothing.** The session runs on the Claude subscription that already
  drives the rest of the fleet. Commanding twenty agents adds no API spend.
- **It is not tied to a vendor.** Its tools arrive over MCP. Any CLI that speaks
  MCP can be CAPCOM — Claude Code today, whatever has an adapter tomorrow.
- **It is visible.** You can watch it think, read what it did, and `claude
  attach` to it, because it is just an agent.

### Start it

```bash
npx tsx src/collector/index.ts              # on the hub's machine: on by default
npx tsx src/collector/index.ts --capcom     # on another machine (or: node bin/orca-capcom.mjs)
npx tsx src/collector/index.ts --no-capcom  # this machine must not carry it
```

The default follows the hub: with `ORCA_HUB_URL` unset or pointing at loopback
the collector brings CAPCOM up on its own, because a console with nobody
listening is the most confusing thing ORCA can show. Dialing a remote hub, it
stays off unless asked.

### Where it runs

With tmux on the machine, CAPCOM is hosted like any other agent ORCA launches:
one interactive session in a pane named `orca-<sessionId>`, id chosen up front.
What you type in the CAPCOM window is pasted into its prompt, so the session
never changes identity, and **TERMINAL** on that window is the whole
conversation, live, straight from the CLI, with a keyboard into it. From a
shell: `tmux -L orca attach -t orca-<sessionId>`.

The first time on a machine the CLI would ask whether to trust
`~/.orca/capcom`. The collector answers that in `~/.claude.json` for its own
directory before launching, so the session comes up without a dialog. If it
could not (no config file yet), the dialog shows in TERMINAL and you accept it
once.

Without tmux it falls back to `claude --bg`: every message is then a
`--bg --resume`, which makes a new session each time, and the window shows
only the last exchange. Install tmux and restart the collector: a remembered
`--bg` CAPCOM is stopped and relaunched hosted on the next start.

### It can move your camera

"Show me K9", "where is the audit squad", "take me to the agent running the
tests", "zoom out": CAPCOM has a `show` tool that points every open console
at one agent, several, a squad, a project, or the whole fleet. The console
flies there, selects it, and says who asked in the feed; Backspace brings you
back where you were. Anything CAPCOM launches — `spawn_agent`, `launch_squad`
— is followed the same way without asking, and a target that has not reached
the field yet (the session that just went up) is waited for, up to 45
seconds, then let go.

Its replies are places too. Every callsign, agent id and squad name CAPCOM
writes is a link in its window: click flies the camera there, ⌘-click (Ctrl on
a PC) opens the agent or the squad as well. Ask it to list the agents you
launched today and the list is the map.

### Permission prompts

A hosted agent that hits "Do you want to proceed?" is not stuck in silence. The
collector reads its pane, raises it as an escalation with the options
`allow | deny`, and the usual path takes over: CAPCOM answers it (its brief
says when to allow and when to deny), the human sees it in the interrupt queue
if CAPCOM does not answer within 90 seconds, and either answer goes back into
the pane as keystrokes. The agent window shows ALLOW / DENY too. Agents CAPCOM
spawns run in `auto` permission mode, so most of them never ask at all; a
`--bg` session has no screen to read, and there the 90-second suspicion in
`derive.ts` is all ORCA has.

**One machine only.** The hub delivers what you type to the session with
`role: 'capcom'`, so two of them would be two minds triaging the same question
and a console that cannot say whose transcript is the command window. Every
other machine runs the plain collector.

The collector keeps it alive: if the session dies it relaunches it 30 seconds
later, at most five times an hour, and says so in the feed. Past five it stops
and tells you to look, because a CAPCOM that cannot start, retried forever, is
a process bomb.

### Its tools are the hub, over MCP

The hub serves `POST /mcp` — Streamable HTTP, MCP 2025-03-26, JSON in and JSON
out — carrying the fleet's verbs:

`briefing` · `list_fleet` · `inspect_agent` · `list_agents` · `show` ·
`list_tasks` · `inspect_task` · `report_task` · `spawn_agent` · `launch_squad` ·
`list_fleets` · `inspect_squad` · `stop_squad` · `send_to_agent` ·
`interrupt_agent` · `stop_agent` ·
`archive_agents` · `recall` · `remember` · `answer_agent` · `ask_human` ·
`read_traffic` · `relay` · `answer_peer` · `resolve_collision` ·
`verify_agent` · `agent_diff` · `screenshot`

Three of them exist so that CAPCOM never has to remember anything:

| Tool | What it answers |
|---|---|
| `briefing {hours}` | the situation in one screen — blocked agents and what they ask, tasks waiting on a reply, workers finished in the last `hours` (6) whose result nobody reported, squads with no live member, projects with activity, the latest `remember` rules. Capped per section, text not JSON |
| `list_tasks {status, only_pending, limit}` | the task conversations (NEW TASK on the console), newest activity first, each with its agents and whether it is waiting on CAPCOM |
| `inspect_task {task_id}` | one task in full: the conversation, every agent with its last result, and exactly what is still owed |

The brief tells CAPCOM to call `briefing` first in every new session and again
after every context compaction. The hub is the record; the session is not.

### Interrupting a turn

Three verbs, and they are not interchangeable. `send_to_agent` waits: what you
write arrives when the agent finishes what it is doing, which on a ten-minute
detour arrives ten minutes late. `stop_agent` ends the session. In between sat
the thing an operator does without thinking — press Esc, say something else —
and until now ORCA could not do it at all.

`interrupt_agent {agent_id, text, reason}` is that Esc, at a distance. The
session, its id, its context and everything it already wrote survive; only the
turn in flight is dropped. `text` rides along so cancelling and correcting are
one action, which matters more than it sounds: **the two CLIs need the two
halves in opposite orders**, and both orders were measured against real panes,
not assumed.

| | Claude Code 2.1.263 | Codex CLI 0.153.4 |
|---|---|---|
| While working, the bar says | `esc to interrupt` | `esc to interrupt` |
| Order that works | Escape, then the message | the message (it queues), then Escape |
| What one Escape does | cuts the turn mid-sentence | with a queued message, cuts and delivers it; **with nothing queued it did not cut at all** |
| The CLI's own record | a `user` line reading `[Request interrupted by user]` | `turn_aborted` with `reason: "interrupted"` |

That last row is the whole reason the answer can be trusted. ORCA does not
report "interrupted" because it sent a key — a pane accepts any key without
saying what it did with it. It waits for the CLI's own mark to appear in the
transcript, and only then says `evidence: "confirmed"`. `"pending"` means the
key went out and the acknowledgement has not arrived; it never means failure,
and nothing anywhere claims the agent has *read* your correction, because no
transcript says that.

The message is reported just as carefully. After pasting, ORCA reads the pane:
if the screen shows the CLI's queue marker, the answer says `queued` rather
than `pasted`, because a queued correction is one the agent will see after
finishing the very thing you were interrupting. This is not hypothetical — at a
600 ms gap between the cancel and the paste, the cut landed and the text still
went to the queue. The gap is 1 s for that reason.

**Only a session ORCA hosts in a pane can be interrupted.** A `claude --bg`
session has no key to press and its CLI offers no cancel: `claude stop` ends
the session, which is a different thing entirely. Those answer `unsupported`
with the reason, and stopping is explicitly not offered as a fallback — no
kill, no double Ctrl-C, no relaunch, no delete. Losing a turn is reversible;
losing the session, its uuid and its context is not.

On the console, the agent window has INTERRUPT next to STOP. Type a correction
first and it becomes INTERRUPT + SEND. Unlike STOP it is not armed with a
confirm click: interrupting by mistake costs one turn, and the seconds an
arming click would cost are the seconds the correction was for.

### Verifying an agent's work

An agent's report is a claim. Three tools check it against the disk instead:

| Tool | What it answers |
|---|---|
| `verify_agent {agent_id}` | the summary: files the agent actually wrote (its `Edit`/`Write` calls, read from the transcript), `git diff --stat` of its working tree or worktree, the untracked count, and `last_test_run {command, ok, tail, at}` — the last `npm test` / `pytest` / `go test` / `cargo test` / `vitest` it ran, its exit, and the tail of its output. `ok: null` means it is still running |
| `agent_diff {agent_id, files, max_bytes, only_touched}` | the patch itself, against `HEAD`, plus untracked files. `files` narrows it to paths under the repo root; `only_touched` to what the agent wrote; `max_bytes` (64 KiB by default, 1 MiB at most) caps it, and a truncated patch says so on its last line |
| `screenshot {what, refs, open, wait_ms}` | a PNG of the console as the operator sees it, saved under `~/.orca/hub/shots/`. `what`/`refs` move the camera first, exactly like `show` |

The diff runs on the collector that owns the agent, never on the hub: `git` is
invoked read-only (`rev-parse`, `diff`, `status`), without a shell, and only
inside a project root the collector already discovered — the agent's `cwd`
from its transcript when that falls inside one (a `--bg` worktree does), the
project root otherwise. The tree git reports is checked against the same
roots before anything else runs. Paths in `files` go after `--` and anything
that escapes the tree is dropped and listed back as `ignored`.

`screenshot` drives a headless Chromium through Playwright, which is a
devDependency: on a hub that lacks it the tool says what to install
(`npm i -D playwright && npx playwright install chromium`). It opens
`ORCA_CONSOLE_URL` when set, else the console the hub serves (`dist/`), else
Vite on 4478, with the hub token, waits for the field to have its fleet, moves the camera,
lets it settle for `wait_ms` (1.8 s) and shoots. The page it opens is one more
console: a `show` sent before it exists is a `show` it never hears, which is
why the camera moves from inside the capture.

They are the same tools, from the same file, that the API command uses: one
implementation, so the two can never drift into being able to do different
things. Authentication is the hub's own token, in `Authorization: Bearer`,
`X-Orca-Token`, or `?token=` — the query form because a `.mcp.json` entry has
nowhere to put a header.

Three files are written into `~/.orca/capcom/` (or `ORCA_CAPCOM_DIR`) at every
start, so a changed token or port never leaves a session with no tools:

| File | What |
|---|---|
| `CLAUDE.md` | its brief — who it is, the loop, the standing rules |
| `.mcp.json` | `{"mcpServers":{"orca":{"type":"http","url":"…/mcp?token=…"}}}` |
| `.claude/settings.json` | approves that server, `auto` mode, every tool available |

**That directory is not a project.** Everything under `~/.orca/capcom` (or
`ORCA_CAPCOM_DIR`) is the command post, so the collector never registers it as
one: it produces no island, no two-letter code and no rollup. The live CAPCOM
session is still reported — with `role: 'capcom'`, drawn apart on the field
under its own CAPCOM · COMMAND label, and carrying a project id nobody
registered. Everything else that lives in there — the CAPCOM sessions that came
before this one, and anything somebody launched inside by mistake — is reported
with `hidden: true` and left out of `list_fleet`, `list_agents`, the field and
every counter. Nothing on disk is touched: the transcripts stay, `list_agents
{include_hidden: true}` shows them, SHOW ALL puts them back on the field, and
`archive_agents {hidden: true}` clears the ones that already finished. Session
scratchpads (`/tmp/claude-<uid>/…`) are excluded the same way and for the same
reason. Launching work in there is refused at every door — `spawn_agent`,
`launch_squad`, a console spawn and the `.orca/spawn` mailbox — because a worker
started there reads CAPCOM's `CLAUDE.md` and wakes up believing it is the
commander. The rule lives in `src/shared/workspaces.ts`.

CAPCOM has Bash, Edit and Write, and the brief tells it when to use them: small,
immediate things it does itself in its own directory; real work in a repo goes
to an agent with a proper brief, launched with whatever `permission_mode` the
mission needs. Those tools used to be denied, and the day that was measured
(2026-09-06) writing one log file took a squad, two sub-agents and eight
minutes. The brief lives in `src/collector/briefs.ts` and is meant to be
edited — it is the product, not configuration.

### The loop it runs

An agent's question reaches CAPCOM as a message beginning `[ESCALATION <id>]`.
It tries `recall` first, then either `answer_agent` — and you never see it — or
`ask_human`, carrying that same id so you read one question rather than two.
Anything you type reaches it unprefixed; it acts and answers in one line.

**If it does not answer within 90 seconds, the question goes to you anyway**,
marked `capcom did not answer in time`. Handing a question to a session that
might be wedged is otherwise indistinguishable from a quiet fleet, and an agent
would wait behind it forever with nobody watching.

### It is recycled before it forgets

A CLI session compacts its context when it fills up, and it does so for ever:
after the third or fourth compaction the commander works from a summary of a
summary, and nothing errors — answers just get vaguer. So the collector
**rotates** it: once the session has compacted `ORCA_CAPCOM_MAX_COMPACTIONS`
times (2) or run `ORCA_CAPCOM_MAX_TURNS` turns (300), and only when it is idle
— no turn in progress, no escalation pending on that machine, nothing
delivered to it for `ORCA_CAPCOM_ROTATE_IDLE_MS` (30 s) — it is stopped and a
fresh session starts with the same brief and a prompt that says to call
`briefing` and pick up what is owed. Compactions are the signal because each
one is an observed loss of memory; turns are the safety net for a CLI that
never writes the boundary line. `0` turns either off.

It is not a resume (a `--bg --resume` would carry the whole context along,
which is the thing being shed) and the hub does not see it as a death: the
collector announces the rotation first, the hub holds anything addressed to
CAPCOM — what you type, task prompts — for up to three minutes, and hands it to
the new session the moment it shows. The feed says
`CAPCOM rotado: N turnos, M compactaciones`. Rotations do not count against
the five-relaunches-an-hour cap. The policy is `src/collector/rotation.ts`.

### Without CAPCOM

There is one mind, and it is CAPCOM. There used to be a second one — an
API-driven "CEO" inside the hub that took over when no CAPCOM was live — and
it was removed on 2026-09-06: two minds with two names commanding one fleet
was exactly the thing an operator could not tell apart.

| Situation | Who commands |
|---|---|
| a live CAPCOM session | CAPCOM — no API spend |
| no CAPCOM | nobody: you get a line saying so, and every question goes to you |

The hub says so on startup, and again in the feed the first time CAPCOM takes
something.

## From a shell

The same verbs, without a browser or a model in the loop:

```bash
node bin/orca.mjs ls                       # projects, who is blocked, squads
orca inspect K9      ·  orca inspect squad:audit-01
orca spawn AX "<brief>" --squad audit-01   # one agent
orca squad payments --project AX \
     --lead @briefs/lead.md --member @briefs/charges.md --member "<brief>"
orca fleets          ·  orca launch audit --project AX
orca say K9 "<text>" ·  orca tell "<subject>" --to squad:audit-01 --kind warning
orca stop K9 --reason "<why>"  ·  orca stop squad:audit-01 --reason "<why>"
orca archive --older-than 24h --dry-run   # finished agents that would go
orca archive --project AX  ·  orca archive --squad audit-01  ·  orca archive --state dead
orca land K9 --message "charges: new schema"   # rebase, suite, one commit on the project branch
orca land squad:payments-01 --no-tests  ·  orca discard K9 --force   # worktrees, see Squads
orca traffic --waiting  ·  orca recall "<q>"  ·  orca remember "<q>" "<rule>"
orca journal --project AX --since 24h   ·  orca journal --kind escalation  ·  orca journal --stats
orca tools           ·  orca health
```

`orca` is `bin/orca.mjs` (`npm link` puts it on the PATH). It is one HTTP call
per command to the hub's MCP server, so anything it can do a script can do:
`--json` prints the tool's result and nothing else. A project is its code,
its name, or its id; an ambiguous one is an error, never a guess. A brief that
starts with `@` is read from that file.

It finds the hub through `--hub`, `ORCA_HUB_HTTP` or `ORCA_HUB_URL`, and the
token through `--token`, `ORCA_TOKEN` or `~/.orca/token`. Exit codes are the
contract: `1` usage, `2` the hub is unreachable or refused the token, `3` the
hub answered and the tool said no.

## Squads

A squad is lineage with a name on it, and one member who speaks for the rest.

`parentId` already says who launched whom, and that is a tree. What a tree
cannot say is "these five are the audit, and that one answers for them" — which
is the unit you actually think in when you send work out and want one answer
back. So an agent carries a `squad` label and, for one of them, `lead: true`.
Both are set by the `spawn` that created it (`Command.spawn` takes `squad` and
`lead`), persisted next to its mission in `~/.orca/lineage.json`, and derived
back into groups by `squadsOf()` in `src/shared/squads.ts`.

There is no squad record. Nothing to create, nothing to garbage-collect: a
squad is whoever carries the label right now. An agent leaves it by dying, and
a squad stops existing when its last member does.

**Launching one.** `launch_squad`, over MCP or from CAPCOM, does it in one
call: it takes a base name and one brief per agent, spawns the lead first,
waits for its session to be named, and hangs every member off it with the same
label. The name is numbered by the hub — `audit` becomes `audit-01`, then
`audit-02` — from a counter in `~/.orca/hub/squads.json` *and* the labels
already on the fleet, so two launches never merge into one squad. A member that
fails to launch is reported in the result, not hidden; the rest still go up.
If the lead's session has not shown after the collector's wait plus 15s more,
the members go up unparented and the result says so.

"Make me a squad of three auditors" typed at the console is exactly this: CAPCOM
writes the four briefs and calls it once.

By hand, the same thing is `spawn` with `squad` and `lead: true`; the ack comes
back with `data: { agentId, callsign, shortId }`, and that `agentId` is the
`parentId` you give each member. The collector waits up to 8s for the session to
actually appear before answering — a session that has not shown up yet answers
with `agentId: null` and arrives on its own via `agent:new`.

**Driving one.** `inspect_squad` is the lead, every member with its state and
spend, who is blocked, and the asks still waiting inside it. `relay` takes a
`squad` and reaches every live member; `stop_squad` stops them members-first
and the lead last. To redirect a squad, talk to its lead with `send_to_agent`
— that is what the lead is for.

**Growing one.** An agent can ask for another pair of hands without a hub
token or a socket: `orca-spawn "<brief>"` writes the brief into
`<project>/.orca/spawn/`, the collector picks it up, decides, launches, and
writes an ack next to it with the new agent's callsign. The child is the
asker's: spawned as its child, in its squad, never a lead — the asker's own
squad wins over any `--squad` it names. Two caps make this safe to hand to a
model: at most 8 live children per agent, at most 13 agents per squad, and a
refusal is written into the ack with its reason. `orca-install` links
`orca-spawn` next to `orca-tell`, and the lead's brief tells it the command
exists.

**What they are told.** At spawn time the collector appends a short brief to the
prompt (`src/collector/briefs.ts`). The leader is told its members arrive as
children, to hand work out with `orca-tell` and to reach the human with
`orca-ask` only when nobody in the squad can go further. A member is told which
squad it is in, who leads it, to report with `orca-tell --to <lead>`, and not to
use `orca-ask` at all. Without that, a stuck member escalates to the person —
which is the thing squads exist to prevent.

**Talking to one.** `orca-tell "…" --to squad:audit-01` is a `scope: 'squad'`
message, and the hub delivers it to every agent carrying that label on any
machine. Unlike a bad `project:`, an empty squad does *not* degrade to a
broadcast: waking twenty unrelated agents over a typo is worse than not
delivering, so it is reported undelivered in the feed instead.

**Where they write.** By default every worker runs on the project's own
working tree, uncommitted, and two of them editing the same file overwrite
each other. Opt in with `ORCA_WORKTREES=1` on the *collector* and each worker
gets a git worktree of its own instead:

```
<project>/.claude/worktrees/<short id>/     its files      (the same place `claude --bg` uses)
orca/<short id>                             its branch, cut from the project's HEAD
```

The agent record carries both (`worktree`, `branch`; `inspect_agent` shows
them), persisted in `~/.orca/lineage.json` like its mission. A squad launched
with `shared_worktree: true` shares one worktree and one branch named after
the squad, for members that are meant to edit the same files; without it,
one per member. The collector links `node_modules` into a new worktree when
the project has one and git ignores it, so a suite can run there. Without the
env var nothing changes: agents already running keep their working tree.

**Landing.** `land` (over MCP, or `orca land K9` / `orca land squad:payments-01`)
integrates a worker's branch into the project's branch, in this order:

1. whatever the worker left uncommitted is committed on *its* branch;
2. the branch is rebased onto the project's current branch, inside the
   worktree — a conflict is aborted there, the files are named, and the
   project branch has not been touched;
3. the project's suite runs in the rebased worktree, which is exactly what the
   project is about to become. The command is detected: `scripts.test` in
   package.json, a `test` target in the Makefile, Cargo, Go, pytest — or
   `{ "test": "npm run test:ci" }` (or `false`) in `<project>/.orca/land.json`;
4. if it passes, `git merge --squash` puts ONE commit on the project branch,
   titled `land <callsign>: <mission>` (or `--message`), with the worker's
   commit subjects and the suite result in the body. The worker's branch is
   then reset to the project branch, so it can keep working from there.

Rebase rather than merge, so history stays linear and a conflict shows up
where the worker can see it; squash rather than fast-forward, so the commit
says who and why instead of ten "wip"s. The project's working tree may be
dirty — the operator works there — and that is fine unless a dirty file is one
the branch changes, which is reported as a conflict; a project *index* with
staged changes refuses the landing outright. A failing suite or a conflict
lands nothing and returns why, so CAPCOM can send the files back to the
worker, resolve them, or `discard`.

`discard` removes a worker's worktree and branch, and refuses while it holds
unlanded work — uncommitted changes, or commits the project branch does not
have — unless `force`. A worker that is archived (`archive_agents`, `orca
archive`) or removed loses its worktree on its own when there is nothing to
lose; with unlanded work it stays, and the result says so.

`npm run mock -- --squad` adds a synthetic squad — one leader, three children,
talking to each other — to the fake fleet.

### Fleet presets

The squads you launch more than once are files: `~/.orca/fleets/<name>.json`,
one per preset, a name and one brief per agent with at most one marked `lead`.
The hub owns the directory and seeds it with `audit` and `ship` the first time
it is empty. Delete one and it stays deleted.

There is one list and two doors onto it. In the console, `/launch` shows the
presets, `/launch audit` fires one, and the window's JSON editor saves back
over `PUT /api/fleets` — the text is the list, so removing a preset from it
removes the file. From CAPCOM, `list_fleets` reads the same directory and
`launch_squad` with `preset: "audit"` launches it: "launch the nightly audit"
typed at the command line is those two calls. A preset that names a `project`
by code launches there without being told; one that fixes a `squad` keeps that
label instead of being numbered.

Both doors take the squad's number from the same counter on the hub
(`POST /api/squads/next`), so a launch from the browser and one from CAPCOM
can never share a label.

```json
{
  "name": "audit",
  "project": "AX",
  "agents": [
    { "lead": true, "mission": "Lead the audit…", "prompt": "You lead this audit. …" },
    { "mission": "Find dependencies that are unused…", "prompt": "Audit the manifest…" }
  ]
}
```

## State it derives

From `~/.claude/projects/**/*.jsonl`, tailed incrementally by byte offset (some
transcripts are 24MB — re-reading is not an option):

| State | Means |
|---|---|
| `booting` | spawned, no output yet |
| `thinking` | streaming, no tool call yet |
| `working` | running a tool — and which one |
| `blocked` | **needs a human** |
| `idle` | finished a turn, waiting on you |
| `done` / `dead` | over |

Plus spend, tokens/sec, lines changed, tool calls, turns, and the parent→child
lineage when an agent spawns subagents (read from each subagent's `.meta.json`,
which carries `agentType`, `description` and `spawnDepth`).

Two honest caveats, both properties of Claude Code rather than of ORCA:

- **A live agent legitimately shows `$0.00`.** Claude Code writes its
  `cost-state` line once, when the session ends. Only finished sessions have a
  total; running ones report what ORCA has observed since it attached.
- **A permission prompt cannot be answered from the console.** Claude Code
  2.1.260 exposes no way to reply to one from outside the process. ORCA detects
  the block and tells you which agent and which machine; you answer in its
  terminal. `Command.permit` is in the protocol waiting for the day the CLI
  supports it.
- **A background agent works inside a git worktree.** `claude --bg` runs the
  session in `<project>/.claude/worktrees/<name>/`, which has its own transcript
  slug. ORCA folds those back onto the parent project — without that, five
  background agents fragment one repo into six phantom regions on the field.
  The worktree is still visible as the agent's real working directory.

Only sessions touched inside the fleet window count — 24h by default,
`ORCA_FLEET_WINDOW_MS` to change it. Without that filter the console loads every
session the machine has ever had and stops being a console.

## Artifacts

Work an agent produced that is worth looking at — a chart, a screenshot, a
generated page — instead of a path in a log line you have to go open somewhere
else.

**What gets picked up automatically.** Any `Write`, `Edit`, `MultiEdit` or
`NotebookEdit` whose `file_path` ends in `.png .jpg .jpeg .gif .webp .svg .mp4
.webm .mov .html .htm .md .txt`. No cooperation from the agent is needed; it is
read from the transcript like everything else. Rewriting the same path updates
the same artifact rather than making a second one, so regenerating a chart
replaces it where you already had it.

**What an agent asks for explicitly.** `orca-show <path> [title]` files a small
JSON in `<project>/.orca/artifacts/`, which the collector watches the same way
it watches the message outbox. Use it when it matters *which* of forty frames
is the one, or when the file name does not say what it is. The path must be
inside the project, and must still be one of the extensions above.

**What an agent wants opened, not just filed.** `orca-show <path> --open` sets
`open: true` on the record, which travels through the collector and the hub
untouched. It is a request and nothing more: the console decides what opening
means and whether now is the moment. Automatic detection never sets it —
deciding on its own that some `.png` deserves to take over your screen is
exactly the behaviour that would make the whole feature something you turn off.

**How the bytes travel.** They do not, until somebody looks. The frame carries
a record — kind, title, size, image dimensions read from the header — and the
hub fetches the file with `artifact:read` on first view, caches it in
`~/.orca/artifacts/<id>`, and serves it at `/api/artifact/<id>` from then on.
That matters when the laptop that produced it is asleep: the record is still
true and the cached copy still renders.

`artifact:read` serves **only paths the collector registered itself**, keyed by
id. The hub never names a path, so a stolen hub token cannot become "read me
any file on that machine". An artifact over **16 MB** does not travel at all —
it stays where it is and the console shows the path. An `.html` is served with
`Content-Security-Policy: sandbox`, so a page an agent wrote cannot turn around
and talk to the hub with your session.

Bounds, same as everything else: **200 per machine** in the collector, **300 or
24h** in the hub. Falling off either drops the cached copy too; the file on the
agent's disk is never touched.

## Runtimes

ORCA is a console for coding agents, not a Claude Code console. Everything
above the collector — the hub, the protocol, the agent↔agent channel, the
escalations, the artifacts, the tmux pane and the terminal on it — is files,
frames and a pty, and any CLI with a prompt can use it. What is
runtime-specific is small: where the CLI writes its session, how those lines
become an `Agent`, and the argv that launches it. That lives in
`src/collector/runtime.ts` (which binaries this machine has), `derive.ts`
(Claude) and `codex.ts` (Codex).

| Runtime | Status |
|---|---|
| `claude` | ready — `~/.claude/projects` transcripts; `claude --session-id <uuid> <prompt>` in a pane, `--bg` without tmux |
| `codex` | ready — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `codex -C <cwd> <prompt>` in a pane |
| `grok` | adapter pending — needs its session format and a headless entry point |

Both run on their subscriptions — Claude Max and ChatGPT — never on API keys;
ORCA only ever launches the CLI you already log into. Every agent carries
`runtime`; the tile shows `CX` for Codex, the spawn form has a picker, the
CLI takes `--runtime codex`, and CAPCOM's `spawn_agent` tool takes `runtime`.
A `spawn` naming a runtime this machine cannot drive is refused with the
reason.

What is different about Codex, and why:

- **the id comes after the process.** Codex does not accept a session id up
  front, so its pane is born as `orca-cx-<nonce>` and renamed to
  `orca-<sessionId>` the moment the rollout appears (a second or two). The
  ack waits for that like it waits for a Claude transcript.
- **the project is the rollout's `cwd`.** There is no per-project directory;
  the first line of the rollout says where it ran, and that maps onto the
  same project Claude sessions of that directory belong to.
- **approvals are not in the rollout.** A pending exec approval lives in the
  TUI only, so ORCA applies the same suspicion it applies to Claude — a tool
  open for 90 s under a policy that can ask is reported blocked on
  permission — and the TERMINAL is where you answer it. `plan` maps to
  `-s read-only`, `manual` to `-a untrusted`, the default to
  `-a on-request -s workspace-write`.
- **cost is zero and tokens are real.** `token_count` gives input, cached,
  output and reasoning tokens per thread; there is no dollar figure because
  there is no bill.
- **a Codex session you started yourself has no liveness.** Claude's
  `claude agents --json` lists every session; Codex has no equivalent the
  collector reads yet, so a non-hosted Codex session is "alive" while its
  rollout moves and `done` a minute after it stops. Hosted ones are alive as
  long as their pane is. `say`, `stop` and `logs` need a pane and say so.

Codex 0.153 also ships a local app-server daemon (JSON-RPC over a socket or
websocket, `codex app-server generate-ts` for typed bindings), `codex agents`,
`codex queue --thread`, `codex exec --json` and remote-control pairing. None
of it is used yet; the daemon is the obvious source for live approvals and
liveness when this adapter grows.

## Terminals

An agent ORCA launches hosted does not run as a detached `--bg` job. It runs
as an ordinary interactive CLI inside a tmux pane on ORCA's own server
(`tmux -L orca`, session `orca-<sessionId>`), and that pane is what the
console attaches to when you open a TERMINAL: `TERM` on an agent's window,
`T` in its menu, or `/term K9`. What you see is the CLI itself — its prompts,
its permission questions, its `/commands` — streamed byte for byte, and what
you type goes straight back. Closing the window detaches; the agent never
notices.

Why a pane and not a job:

- **it survives ORCA.** tmux is its own daemon. Restart the collector, close
  the lid, and the fleet is still there; `resume` only exists for panes that
  actually died.
- **`say` is a paste, not a fork.** `claude --bg --resume` moves the
  conversation to a new session id (docs/CONTRACT-REQUESTS.md §24). Into a
  pane, text is pasted at the prompt with bracketed paste, so the session
  keeps its id, its history and its place in the lineage.
- **the id is chosen up front.** The collector launches with
  `--session-id <uuid>` and names the pane after it, so the ack names the
  agent without waiting for a short id to be printed and matched.
- **any CLI fits.** Codex, Grok, anything with a prompt is "that binary in a
  pane"; the terminal, `say`, `stop` and `logs` are the same for all of them.

What it needs: `tmux` on the machine (`brew install tmux`) and `node-pty`,
which `npm install` brings. Without tmux the collector says so at start and
every spawn falls back to `--bg`; the TERMINAL button reads NO PANE. The
spawn form's HOSTED toggle, `pane: false` on the `spawn` command, or a
machine without tmux are the three ways to get a `--bg` job instead.

Wire: the console sends `term:open {termId, agentId, cols, rows}`; the hub
looks up the agent's machine and forwards it; the collector attaches a pty
running `tmux attach` and streams `term:data` up. `term:input` and
`term:resize` go down the same id; `term:close` from either side, or either
socket dropping, ends it. Bytes are capped per frame, attachments per
machine and per console, and a `term:data` for an id that machine does not
own is dropped. The pane uses `window-size latest`, so the console that
resized last sets its size.

`stop` on a hosted agent is two Ctrl-C — the way you leave the CLI by hand —
and a `kill-session` six seconds later if it is still there. `logs` is
`capture-pane`: the screen as tmux has it composed, no escapes to strip.
Sessions you start from your own shell are watched like any other but have no
pane: they can be seen, not attached to.

## History

The console can be scrubbed. The hub keeps a compact snapshot of the whole
fleet every 20 seconds — and an immediate one whenever an agent crosses into
`blocked` or `dead`, because those are the two instants you go looking for and
a 20-second grid misses half of them. Drag the cursor on the timeline window
and the field redraws that instant: states, regions and lineage, at the speeds
they were running.

A snapshot is six values per agent (`state`, spend, tokens/sec, project,
parent, callsign) and nothing else. Titles, tool calls and what an agent said
are not in it — replaying them would put words in the past's mouth, and they
would multiply the cost of a day of history by twenty. Escalations, messages
and artifacts are left out for the same reason: amber that means nothing is
the one thing this console must never draw.

It lives in `~/.orca/history.jsonl`, append-only, compacted on boot and every
six hours by rewriting the file from the ring — so the file inherits the
memory ceilings and cannot outgrow them.

That is what makes **"while you were away"** cheap: the window reads the last
time this tab was watching, and the hub diffs the snapshot from then against
now. Born, finished, dead, blocked — with who is *still* blocked, what it
cost, and the warn/alert lines from the gap. Every row flies you to the agent.

```
GET /api/history?from=&to=&step=       snapshots, subsampled, 600 max
GET /api/history/summary?since=<ms>    what changed since then
```

Both are authenticated like the socket: `?token=`, `Authorization: Bearer`, or
`X-Orca-Token`, with the same loopback-without-token concession as everything
else in development.

## Journal

`remember` keeps the human's rules; the journal keeps the fleet's **results**.
Every launch (who launched it — human, CAPCOM or another agent — the project,
squad and task, the full brief, runtime and model), every end (`done` or
`dead`, cost, duration, tokens, lines changed, the last thing it said), every
escalation and who answered it (CAPCOM or the human, and what they said),
every CAPCOM rotation and every landing goes to
`~/.orca/hub/journal/journal.jsonl`, one JSON line per fact, append-only. It
survives hub restarts: a collector's snapshot after a restart never journals
an agent twice, and an agent that finished while the hub was down gets its
end written when it reappears, marked `late`.

The file rotates by size — over `ORCA_JOURNAL_MAX_BYTES` (8 MiB) it is renamed
`journal.<date>.<n>.jsonl` and a fresh one starts; the newest
`ORCA_JOURNAL_KEEP` (6) rotated files are kept, the oldest go. Whole files
leave, never single lines.

Two MCP tools read it, and `orca journal` from a shell:

| Tool | What it answers |
|---|---|
| `journal {project, squad, task_id, agent, kind, since, until, state, by, text, limit, newest_first, full}` | entries matching the filters, newest first, compact (brief and messages clipped to 200 chars unless `full`). `since`/`until` take `24h`, `3d`, an ISO date or epoch ms; `text` matches brief, last message, question and answer with accents and case ignored |
| `journal_stats {project, squad, since, until}` | launches by who launched them, done vs dead and the rate, total and average cost and duration overall and per project, escalations and who answered, rotations, landings — and the briefs that ended in an escalation, which are the ones to write better next time |

`briefing` shows a new CAPCOM what finished since the last briefing it was
given, so a session born after a rotation starts from results, not from
nothing. The rest is one `journal` call away.

## Bounds

ORCA is meant to be left running. Everything it holds is bounded, and each
bound exists because something actually broke without it:

| What | Bound | Why |
|---|---|---|
| finished agents | 1h, or 300 | the hub kept every dead session forever and OOM'd |
| open questions | 100 | a queue of 5,000 is noise, and memory you never get back |
| answered questions | 1h, or 200 | history lives in the log, not in the frame |
| agents per machine | 400 | so a collector with a bug cannot take the hub down |
| artifacts | 24h, or 300 | each one has a cached file behind it, so this frees real bytes |
| artifacts per machine | 200 | an agent rendering frames in a loop is not 5,000 things to look at |
| history snapshots | 24h, or 6,000 | a day is what you scrub; past that, the log |
| history entries | 250,000 agent×snapshot | a 300-agent fleet keeps fewer hours instead of taking the hub down |
| telemetry feed | 500 lines | |
| CAPCOM conversation | 100 turns in the frame | the rest is on disk |

Nothing that needs a person is ever dropped: a `blocked` agent survives the
per-machine cap even as the oldest one there, a `blocking` question never
expires from overflow, and a dead parent with a live child stays so the lineage
graph has something to point at.

### Budgets

A worker that is still going at $40 is either doing something big or going in
circles, and from the outside those look the same. A budget is how CAPCOM
tells them apart without watching: a ceiling in dollars, in minutes, or both,
on one agent, on a whole squad (shared by every member) or on an ORCA task
(shared by every agent assigned to it). `spawn_agent` and `launch_squad` take
`budget_usd` / `budget_min` (per agent) and `launch_squad` also
`squad_budget_usd` / `squad_budget_min` (the squad together); `set_budget`
puts one on anything already running, changes it, or removes it. With
`ORCA_DEFAULT_BUDGET_USD` / `ORCA_DEFAULT_BUDGET_MIN` set, every worker
without a budget of its own gets that one; CAPCOM itself never does.

The hub checks every two seconds and says two things, once each, on the
channel CAPCOM already reads and in the feed:

```
[BUDGET 80%] K9 · task task_ab12 · squad audit-01 · $4.10 of $5.00 (82%) · 12m of 30m (40%) · 82% used
[BUDGET 100%] K9 · task task_ab12 · $5.10 of $5.00 (102%) · still making progress (K9 40s ago); not stopped. Use stop_agent, or raise it with set_budget.
```

At 100 % an agent that has made progress — a tool call or a changed line in
the last `ORCA_BUDGET_PROGRESS_MIN` minutes — is reported, not stopped:
stopping a worker mid-edit to save forty cents is a bad trade. One that is
over budget *and* has gone quiet is stopped, with the reason where CAPCOM
reads it (`[BUDGET STOP] …`), unless `ORCA_BUDGET_ACTION=warn`. Raising the
budget re-arms the warnings, which is how CAPCOM lets an agent go on.

Spend is what the CLI reports, and Claude Code writes `costUSD` at the end of
a turn, so a live agent often shows $0 while burning tokens. While the cost is
still zero the hub estimates from the tokens it has seen at a flat
`ORCA_BUDGET_USD_PER_MTOK`, and marks the number `~$`. `inspect_agent`,
`inspect_squad` and `list_fleet` all show budget against spend; the
limits live in `budgets.json` next to the hub's other files and survive a
restart, as does the memory of what was already said.

### Archiving finished agents

Retention only postpones the pile: every transcript still on disk is an agent
to the collector, and the next snapshot brings every `done` and `dead` session
straight back. Archiving is the explicit version — "I am finished with these"
— and it exists in three places that do the same thing:

| Where | How |
|---|---|
| CAPCOM | `archive_agents {project_id, squad, older_than_hours, state, dry_run}` |
| the console | **ARCHIVE FINISHED** in any FLEET window: the first click is a dry run that arms the button with the count, the second archives |
| a shell | `orca archive [--project AX] [--squad s] [--older-than 24h] [--state done\|dead] [--dry-run]` |

Filters combine with AND; none of them means every finished agent. What it
never does: touch a live agent (`booting`, `thinking`, `working`, `blocked`,
`idle`), whatever the filter says; archive a finished parent whose children
are still alive (it is kept and reported); or delete anything on disk. A
squad whose last member is archived disappears with it — a squad is only the
label its members carry.

**Archived, not deleted.** The hub keeps no agent table; the agents are
rebuilt from the collectors' snapshots. So archiving is a tombstone: the record
leaves the world the way a retention eviction does, and its id is appended to
`~/.orca/hub/archived.jsonl`, which the hub replays on start and checks on
every snapshot, `agent:new` and patch. A tombstoned session that comes back
*finished* is refused; one that comes back *live* — someone resumed it — lifts
its own tombstone and is admitted like any other agent. The transcript, the
event log and the timeline keep everything they had.

Measured after these landed: an absurd synthetic fleet (three machines, chaos
reconnects, six times real speed) that used to crash the hub in three minutes
now settles flat at ~330 agents and 75MB. The browser tab went from 169,705 DOM
nodes after three minutes to 2,673 — tracking the real fleet size, and falling
when agents are reaped.

## Credentials

Keys are given to a project once and stay on the machine that holds them,
encrypted with AES-256-GCM under `~/.orca/`. The hub and the console only ever
see a name and the last four characters. Agents get them injected as env at
spawn time.

The command channel is a closed set — spawn, say, permit, stop, remove, logs,
answer, key. There is no `exec` and there must never be one: a stolen hub token
must not become arbitrary code execution on your laptop.

## Configuration

| Variable | Default | What |
|---|---|---|
| `ORCA_HUB_URL` | `ws://127.0.0.1:4479` | where a collector dials |
| `ORCA_TOKEN` | generated | shared secret; written to `~/.orca/token` |
| `ORCA_PORT` | `4479` | hub port |
| `ORCA_FLEET_WINDOW_MS` | `86400000` | how far back a session still counts |
| `ORCA_CAPCOM` | on when the hub is local | `1` forces CAPCOM on this collector (`--capcom`), `0` turns it off (`--no-capcom`) |
| `ORCA_CAPCOM_DIR` | `~/.orca/capcom` | where the command session lives |
| `ORCA_CAPCOM_MAX_COMPACTIONS` | `2` | recycle CAPCOM after this many context compactions; `0` disables |
| `ORCA_CAPCOM_MAX_TURNS` | `300` | recycle CAPCOM after this many turns; `0` disables |
| `ORCA_CAPCOM_ROTATE_IDLE_MS` | `30000` | how long CAPCOM must be idle before it is recycled |
| `ORCA_HOME` | `~/.orca` | moves everything: token, hub files, `fleets/`, `capcom/` |
| `ORCA_HUB_HTTP` | derived from `ORCA_HUB_URL` | the hub's http base, for the MCP url |
| `ORCA_JOURNAL_MAX_BYTES` | `8388608` | rotate the fleet journal past this size |
| `ORCA_JOURNAL_KEEP` | `6` | rotated journal files to keep |
| `ORCA_STRICT_AUTH` | unset | refuse the localhost-without-token shortcut |
| `ORCA_DEFAULT_BUDGET_USD` | unset | dollar ceiling for every worker that has no budget of its own; empty = no limit |
| `ORCA_DEFAULT_BUDGET_MIN` | unset | the same, in minutes of wall clock since launch |
| `ORCA_BUDGET_ACTION` | `stop` | what 100 % of a budget does to an agent that has stopped progressing: `stop` it, or only `warn` |
| `ORCA_BUDGET_PROGRESS_MIN` | `3` | minutes without a tool call or an edit before an agent counts as "not progressing" |
| `ORCA_BUDGET_USD_PER_MTOK` | `6` | flat $/million tokens used to estimate spend while the CLI has not written a cost yet |

CAPCOM's own brief is `~/.orca/capcom/CLAUDE.md`, rewritten from
`src/collector/briefs.ts` on every start. To give it a policy that survives that,
edit the brief, or tell CAPCOM the rule and let it `remember` it.

## Communication and usability review

See [the September 2026 review](docs/USABILITY-REVIEW.md) for the latency findings,
implemented improvements, and remaining runtime/input limitations. CAPCOM now
includes a **FLEET WORK** list with direct access to agents and terminals.
`orca-read --wait --timeout 60` waits for mail through filesystem events (timeout
in seconds), so a worker can wait without repeated tool calls. This does not
wake a session that has already stopped executing.

## Tests

```bash
npm test                # 270+ assertions: collector, hub, MCP, CAPCOM routing, derived state
npm run visual          # drives the real console, writes test/shots/
npm run shots           # every test/*.shots.ts, one after another
npm run stress          # 24 → 3,000 agents, frame rate and draw counts
npm run mock            # a synthetic fleet to develop against
```

`test/visual.ts` is the one that matters for anything visual. It brings up the
hub, a synthetic fleet and Vite — or reuses the ones `npm run dev` already has
on 4479 and 4478 — drives a real browser at 2× and photographs the boot along
its timeline plus every state the console can be in: the framed field, a
project, an agent's window, the docked windows, the tilt, an interrupt, a lasso
selection, the tray, and the red wash of a dropped link. It also shoots the
field and a window at 402×874. Take one group at a time with
`npx tsx test/visual.ts boot | console | mobile`, watch it with `--headed`,
leave the servers up with `--keep`. Looking at those frames is part of
finishing a change, not an optional extra.

`npm run shots` is the gate for the other kind: a `test/*.shots.ts` opens the
real console in Chromium, seeds a state and asserts thirty things about what it
sees — the panels, the folds, the meters, the tethers. They are not in
`npm test`, which only discovers `test/*.test.ts` and would grow by a quarter of
an hour if they were, and `npm run visual` runs its own scenes: until this
existed nobody ran them unless they typed the filename from memory, and
`hud-improve.shots.ts` sat red for weeks while the suite reported 1338/1338.
They run one at a time — each brings up its own hub, Vite, fleet and browser —
and always isolated, so the gate never writes into the operator's `~/.orca`.
Filter by name (`npm run shots -- hud`), list them with `--list`, watch one with
`--headed`.

`test/field-stress.ts` measures the claim the field makes instead of asserting
it. For 24, 120, 600 and 3,000 agents it scales the synthetic fleet
(`test/fake-collector.ts --agents=<n>`, which replicates the whole topology so
no machine goes over its ceiling), frames everything, and reports agents drawn,
pipe segments, frame rate flat and tilted, and DOM node count, with a PNG per
size. It runs Chromium on the real GPU through ANGLE: left to itself, headless
falls back to software rendering and every row reads ~20fps regardless of load.
Re-run it before arguing about layout.

## Reaching it from anywhere

This is the point of the outbound-only design, and it takes one process.

```bash
npm run build                          # the console becomes static files
ORCA_TOKEN=<a long secret> npx tsx src/orca.ts
```

With `dist/` present the hub serves the console itself, on the same port as the
websockets. Put that one process somewhere reachable and you are done:

**On a VPS.** Run it there, front it with a Cloudflare Tunnel (no inbound ports,
no certificate to manage), and put Cloudflare Access in front of the hostname so
only you can load it. Then on every machine that has agents — your laptop
included — run the collector pointed at it:

```bash
ORCA_HUB_URL=wss://orca.example.com/ws/collector \
ORCA_TOKEN=<the same secret> npx tsx src/collector/index.ts
```

Your laptop never accepts a connection. It dials out, the same as the VPS does.
That is why a machine behind NAT and one behind a firewall are equivalent here.

**On your Mac, reached from your phone.** Same thing without the VPS: run the
hub locally and expose it with `cloudflared tunnel --url http://localhost:4479`.

Set `ORCA_TOKEN` before exposing anything. Without it the hub accepts loopback
connections with no token — convenient in development, wrong on a public port —
and says so at startup in the loudest terms it has. `ORCA_STRICT_AUTH=1` removes
that shortcut entirely.

### Cloudflare Workers

`src/hub/worker.ts` sketches the same hub as a Worker + Durable Object with
WebSocket hibernation. `world.ts` and `bus.ts` port across unchanged; the
transport, storage, alarms and auth are what change. Worth doing when you want
the hub to cost nothing while the fleet is asleep; not needed to get started.

## Zero dependencies on its parent

ORCA was born inside the `axolots` repo and imported nothing from it; since
2026-09-05 it is its own repo (`~/projects/orca`). Its fonts, graphics
modules, and design system are its own copies. Move the directory somewhere
else and it runs.

See `DESIGN.md` for the visual contract.

### New CAPCOM

La ventana de mando incluye **New CAPCOM** con dos modos: **Clean context** (sin pendientes ni historial heredados; espera instrucciones nuevas) y **With continuity** (checkpoint breve del hub). Ambos conservan proveedor/modelo, archivos, historial, reglas persistidas y workers. La barra ORCA ofrece `/capcom-new clean`, `/capcom-new continuity` y `/capcom-new` para abrir la elección. El UUID cambia mediante un traspaso coordinado; `/clear` sigue deseleccionando. Alcance, pruebas, límites y activación: [New CAPCOM](docs/CAPCOM-NEW.md).
