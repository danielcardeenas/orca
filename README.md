<div align="center">

<br>

<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/readme/wordmark-dark.svg">
<img src="docs/readme/wordmark-light.svg" alt="ORCA" width="216">
</picture>

<br><br>

**A console for running many coding agents at once, across machines and providers.**

<br>

<img src="docs/readme/field.png" alt="The ORCA field: a project region with three squads wired to their leads, CAPCOM standing off to the left, the HUD counting 17 idle agents and 3.7M tokens" width="100%">

<br>

<sub>Nineteen agents on the field. Two FORGE squads and a mission wired to their leads. CAPCOM in cyan.</sub>

<br><br>

<table>
<tr>
<td align="center" width="140">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/readme/icons/claude-dark.svg">
<img src="docs/readme/icons/claude-light.svg" alt="Claude" height="36">
</picture><br>
<sub><b>Claude Code</b></sub>
</td>
<td align="center" width="140">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/readme/icons/codex-dark.svg">
<img src="docs/readme/icons/codex-light.svg" alt="OpenAI" height="36">
</picture><br>
<sub><b>Codex</b></sub>
</td>
<td align="center" width="140">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/readme/icons/grok-dark.svg">
<img src="docs/readme/icons/grok-light.svg" alt="Grok" height="36">
</picture><br>
<sub><b>Grok</b></sub>
</td>
</tr>
</table>

<br>

</div>

---

## What it is

ORCA is a web console for a fleet of coding agents. It shows every Claude Code, Codex and Grok session running on your machines in one navigable field, lets you talk to any of them, and gives you a command agent, CAPCOM, that runs the fleet for you.

It reads what the agent CLIs already write to disk. It does not wrap them, patch them or call a model itself. Sessions you start by hand appear on the field the same as sessions ORCA launches.

The repository ORCA runs from is itself a project on the field. A reviewer agent proposes changes to the console; approved proposals are implemented by a squad in a worktree and landed by CAPCOM.

## How it runs

```
collector ──(ws, outbound)──▶  hub  ◀──(ws)──  console
per machine                    │               browser · phone
   └── CAPCOM ──(MCP/http)─────┘
```

- **hub**: one process. Holds the world (agents, missions, budgets, history, journal), serves the console and exposes the tools CAPCOM uses over MCP.
- **collector**: one per machine. Reads transcripts, launches agents in tmux panes, forwards messages and artifacts. Dials out to the hub, so nothing needs an open port but the hub.
- **console**: a browser tab, or an installed app on a phone.
- **CAPCOM**: a CLI session (Claude Code or Codex today) started by the hub's collector, with the hub as its only tool set. Runs on your existing subscription. Provider and model can be switched from the console; the new session inherits missions, rules, workers and conversation.

One machine is enough. Additional machines are additional collectors.

## What it does

**Field**
- Each agent is a tile. State on the left edge, throughput as a moving band, amber when a human is needed, red when dead.
- Pipes show lineage, unanswered questions, notices and file collisions between agents.
- Projects are regions; squads are blocks inside them with a lead and a roster.
- Windows (transcript, terminal, CAPCOM, queue, artifacts) open over the field and can be pinned to tiles or folded into a tray.
- Right-click menus everywhere; every action has a key. Tested at 3,000 synthetic agents.

**Agents**
- Spawn one agent, a squad (lead plus members) or a saved fleet preset. Agents can spawn agents; the lineage is drawn.
- Runtimes: Claude Code, Codex, Grok. A squad can mix them.
- Each worker gets a worktree and a branch. `orca land` rebases, runs the suite and commits; `orca discard` drops it.
- Hosted agents run in tmux panes that survive ORCA restarts. The console attaches to the real CLI, permission prompts included.
- Budgets in tokens or minutes, per agent, squad or mission. At the limit, an agent still making progress is reported; one that has gone quiet is stopped.

**Communication**
- One composer line reaches an agent (`@K9`), a project (`@LZ`), a squad (`@audit-01`) or CAPCOM.
- Agents that need a human are queued; `Tab` moves to the next one. Answers go from the window, the queue, the shell or the phone.
- Agents write to a file mailbox in the project to ask a human, message a peer, hand off to a squad or raise a warning. CAPCOM routes these.
- Push to talk to CAPCOM with `⌥V`.

**Missions and memory**
- A mission is a persistent thread: its agents, messages and state survive CAPCOM rotations and hub restarts.
- History: the hub snapshots the fleet every 20 seconds. The timeline scrubs it; "while you were away" diffs it.
- Journal: every launch, end, escalation, answer and landing as one JSON line, queryable by CAPCOM and from the shell.
- Rules given to CAPCOM are kept and passed to every CAPCOM after it.

**Self-improvement**
- A reviewer agent, without editing tools, reads how the console is used and files proposals with measured evidence or a stated hypothesis.
- The operator replies, snoozes, dismisses or implements. Implementing opens a mission led by FORGE, which forms a squad in a worktree of this repository and hands the result to CAPCOM to land.

**Security**
- CAPCOM's 46 tools have no `exec`. A stolen hub token cannot run code.
- Project credentials are encrypted at rest on the machine that holds them and injected at spawn. The hub sees a name and four characters.
- Everything held in memory is bounded: finished agents, questions, artifacts, snapshots, feed.

## Run it

Requires Node 22, `tmux`, and at least one of the Claude Code, Codex or Grok CLIs.

```bash
git clone https://github.com/danielcardeenas/orca && cd orca
npm install
npm run dev              # hub, collector and console at http://127.0.0.1:4478
```

The hub prints a token on first start. Open the console once with `?k=<token>`; it is remembered.

Run `orca-install` in a project to give the agents working there the `orca-ask` skill and the agent-side commands.

## Shell

```bash
orca ls --blocked                       # who needs a human
orca spawn AX "fix the flaky auth test"
orca squad audit --project AX --lead "..." --member "..."
orca say K9 "run the tests again"
orca stop squad:audit --reason "wrong branch"
orca journal --stats --since 7d
```

`orca --help` lists the rest.

## Remote access

<table>
<tr>
<td align="center" width="80">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/readme/icons/tailscale-dark.svg">
<img src="docs/readme/icons/tailscale-light.svg" alt="Tailscale" height="32">
</picture>
</td>
<td>If Tailscale is installed, the hub publishes itself over https on your tailnet at startup. The console is then reachable from any of your devices, and installable as an app on a phone with push notifications when an agent blocks.</td>
</tr>
<tr>
<td></td>
<td>Without it, the hub is a URL on the LAN or behind any tunnel. Set <code>ORCA_TOKEN</code> before exposing it.</td>
</tr>
</table>

## Layout

```
src/hub          world, missions, budgets, history, journal, auth, MCP
src/collector    transcripts, tmux panes, CAPCOM, mailbox
src/ui           WebGL field, windows, HUD, voice, PWA
src/agents       CAPCOM's tools
bin/             the orca CLI and the agent-side commands
skill/           what orca-install puts into a project
test/            unit suites, visual harness, browser shots
docs/            contracts and design records
```

- [Manual](docs/MANUAL.md): every part of the above in depth.
- [DESIGN.md](DESIGN.md): the visual contract.
- Contracts: [escalation](docs/ESCALATION.md), [messaging](docs/MESSAGING.md), [missions](docs/MISSIONS.md), [budgets](docs/BUDGETS.md), [FORGE](docs/FORGE.md), [self-improvement](docs/AUTOMEJORA.md).
- Operation: [remote access](docs/REMOTE-ACCESS.md), [phone](docs/PWA.md), [several machines](docs/FLEET-MULTI-MAC.md), [production](docs/PRODUCCION.md).

## Tests

```bash
npm run typecheck
npm test                 # unit suites
npm test -- --changed    # only the suites that reach what you touched
npm run shots            # the real console in Chromium
npm run visual           # screenshots of every console state
npm run stress           # 24 to 3,000 agents
```
