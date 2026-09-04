# ORCA

A containment console for a fleet of Claude Code agents.

You run agents across several machines — a laptop, a VPS, a container. ORCA
shows you all of them at once, tells you which ones need a human, and gives you
one thing to talk to instead of twenty terminal tabs.

It reads what Claude Code already writes to disk. It does not replace Claude
Code, does not wrap it, and does not need it patched.

```
collector  ──(ws, outbound)──▶  hub  ◀──(ws)──  console
 per machine                  + CEO              browser
```

Every connection is **outbound from the machine**. A VPS behind a firewall and a
laptop behind NAT are equivalent citizens; nothing needs an open port but the
hub.

## Run it

```bash
npm install

npx tsx src/orca.ts                    # hub + CEO         (prints your token)
npx tsx src/collector/index.ts         # on each machine with agents
npx vite                               # console → http://127.0.0.1:4478
```

Or all three at once: `npm run dev`.

Without an Anthropic key ORCA still runs: a scripted CEO takes over, which
recalls past answers and routes everything else to you. Set `ANTHROPIC_API_KEY`
(or log in with `ant auth login`) and restart to get the real one.

```bash
npx tsx src/orca.ts --no-ceo           # fleet monitor only, no model calls
npx tsx src/orca.ts --fake-ceo         # scripted CEO, spends nothing
```

## What it shows

**Deck** — every agent as an instrument tile, sorted so the ones that need you
are always at the top. State on the left edge, current tool, spend, tokens/sec,
and whether it spawned children.

**Fleet** — the same data as a 3D scene. Projects are platforms, agents are
ribbons standing on them. A working agent travels wide; a thinking one pulses in
place; a blocked one **stops dead and goes amber**. You can read a fleet of
thirty from across the room without looking at a word.

**CEO** — one agent you talk to. It surveys, spawns agents with real briefs,
unblocks them, and stops the ones burning money. It has no filesystem and no
shell; it commands agents that do.

**Interrupts** — the queue of things that need a person. Two kinds: questions an
agent raised, and agents blocked on a permission. Answer with one tap. Tick
**REMEMBER** and the CEO answers that question itself next time.

## The loop that matters

```
agent asks  →  CEO checks memory  →  answers it, and you never see it
                                  →  or cannot, and it lands in your queue
                                     with what it tried and why it punted
you answer  →  goes back to the agent, and into memory
```

The queue gets quieter the more you use it. That is the whole design.

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
  background agents fragment one repo into six phantom projects on the deck.
  The worktree is still visible as the agent's real working directory.

Only sessions touched inside the fleet window count — 24h by default,
`ORCA_FLEET_WINDOW_MS` to change it. Without that filter the console loads every
session the machine has ever had and stops being a console.

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
| `ORCA_MODEL` | `claude-opus-5` | the CEO's model |
| `ORCA_ORDERS` | `~/.orca/ORDERS.md` | standing orders for the CEO |
| `ORCA_STRICT_AUTH` | unset | refuse the localhost-without-token shortcut |

Write `~/.orca/ORDERS.md` to tell the CEO how you want the fleet run. It is
loaded at startup and survives restarts.

## Tests

```bash
npm test                # 70+ assertions: collector, hub, CEO loop, views
npm run visual          # drives the real console, writes test/shots/
npm run mock            # a synthetic fleet to develop against
```

`test/visual.ts` is the one that matters for anything visual: it brings up the
hub, a synthetic fleet and Vite, drives a real browser, and photographs the boot
sequence along its timeline plus every console state. Looking at those frames is
part of finishing a change, not an optional extra.

## Deploying

The hub is a Node process today. `src/hub/worker.ts` sketches the same thing as
a Cloudflare Worker + Durable Object with WebSocket hibernation — `world.ts` and
`bus.ts` port across unchanged; the transport, storage, alarms and auth are what
change. Put Cloudflare Access in front of it and the console works from anywhere
without opening a port on any of your machines.

## Zero dependencies on its parent

ORCA lives inside the `axolots` repo but imports nothing from it. Its fonts,
graphics modules, and design system are its own copies. Move the directory
somewhere else and it runs.

See `DESIGN.md` for the visual contract.
