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
npx tsx src/collector/index.ts --capcom  # on ONE of them: the fleet's command
npx vite                               # console → http://127.0.0.1:4478
```

Or the first three at once: `npm run dev`.

`--capcom` starts **CAPCOM**, the one voice that speaks to the fleet on your
behalf. It is a Claude Code session like any other, so it runs on your
subscription and commanding a fleet costs no API spend at all. Run it on
exactly one machine. See [CAPCOM](#capcom).

Without CAPCOM and without an Anthropic key ORCA still runs: a scripted
fallback takes over, which recalls past answers and routes everything else to
you.

```bash
npx tsx src/orca.ts --api-command      # force the API CEO even if CAPCOM is up
npx tsx src/orca.ts --no-ceo           # fleet monitor only, no model calls
npx tsx src/orca.ts --fake-ceo         # scripted fallback, spends nothing
```

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
npx tsx src/collector/index.ts --capcom     # or: node bin/orca-capcom.mjs
```

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

`list_fleet` · `inspect_agent` · `spawn_agent` · `launch_squad` · `list_fleets` ·
`inspect_squad` · `stop_squad` · `send_to_agent` · `stop_agent` ·
`recall` · `remember` · `answer_agent` · `ask_human` · `read_traffic` · `relay` ·
`answer_peer` · `resolve_collision`

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
| `.claude/settings.json` | approves that server, denies `Bash`/`Edit`/`Write` |

The denials are the CEO doctrine made enforceable: CAPCOM commands a fleet, it
does not edit repos. If it wants something changed it spawns an agent with a
real brief. The brief lives in `src/collector/briefs.ts` and is meant to be
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

### Fallbacks

No path leaves the fleet without a command.

| Situation | Who commands |
|---|---|
| a live CAPCOM session | CAPCOM — no API spend |
| no CAPCOM, an Anthropic key present | the API CEO in the hub |
| no CAPCOM, no key | the scripted fallback: recalls, and routes the rest to you |
| `--api-command` | the API CEO, even with CAPCOM up |

The hub says which one is active on startup, and again in the feed the first
time CAPCOM takes something.

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
orca traffic --waiting  ·  orca recall "<q>"  ·  orca remember "<q>" "<rule>"
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
escalations, the artifacts — is files and frames, and any CLI that can write a
file can use it. What is runtime-specific is the collector's reading of a
CLI's transcripts and its `spawn` / `say` / `stop` / `logs`, and that lives
behind `src/collector/runtime.ts`.

| Runtime | Status |
|---|---|
| `claude` | ready — `~/.claude/projects` transcripts, `claude --bg` spawn |
| `codex` | adapter pending — needs `~/.codex/sessions/*.jsonl` reader and `codex exec` spawn |
| `grok` | adapter pending — needs its session format and a headless entry point |

Every agent carries `runtime`; the tile shows it when it is not Claude, and a
`spawn` naming a runtime this collector cannot drive is refused with the reason.

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
| CEO conversation | 100 turns in the frame | the rest is on disk |

Nothing that needs a person is ever dropped: a `blocked` agent survives the
per-machine cap even as the oldest one there, a `blocking` question never
expires from overflow, and a dead parent with a live child stays so the lineage
graph has something to point at.

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
| `ORCA_CAPCOM` | unset | `1` makes this collector carry CAPCOM (same as `--capcom`) |
| `ORCA_CAPCOM_DIR` | `~/.orca/capcom` | where the command session lives |
| `ORCA_HOME` | `~/.orca` | moves everything: token, hub files, `fleets/`, `capcom/` |
| `ORCA_HUB_HTTP` | derived from `ORCA_HUB_URL` | the hub's http base, for the MCP url |
| `ORCA_MODEL` | `claude-opus-5` | the API fallback's model |
| `ORCA_ORDERS` | `~/.orca/ORDERS.md` | standing orders for the API fallback |
| `ORCA_STRICT_AUTH` | unset | refuse the localhost-without-token shortcut |

CAPCOM's own brief is `~/.orca/capcom/CLAUDE.md`, rewritten from
`src/collector/briefs.ts` on every start. To give it a policy that survives that,
edit the brief. `~/.orca/ORDERS.md` does the same job for the API fallback.

## Tests

```bash
npm test                # 270+ assertions: collector, hub, MCP, CAPCOM routing, derived state
npm run visual          # drives the real console, writes test/shots/
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
