# Budgets, descendants and liveness

What ORCA measures when it says an agent is going over, what it brakes when an
agent multiplies, and how the hub decides an agent still exists.

The three go together because the three failed at the same time, in the same
three-hour operation with twenty agents, and because they share a mechanism:
counting consumption and acting on it.

---

## 1 · The unit: usage, not money

**Decision: a ceiling is set in TOKENS — input + output + cache writes; cache
reads do not count — or in MINUTES SEEN WORKING. There is no ceiling in
dollars** (since 2026-09-12; before that there was one, turned off). The token
rule lives in a single function, `ceilingTokens` (`src/shared/tokens.ts`), used
by every ceiling.

### Why

This fleet is paid for on a **flat plan**, Claude included, and no API calls are
used. The dollars a CLI writes into its transcript do not correspond to any
charge: they are an estimate of something nobody pays. An alert in money asked
you to react to a number that meant nothing, and on top of that it asked wrong —
see §2.

Until 2026-09-11 the dollar axis stayed in the data model, turned off behind
`ORCA_BUDGET_MONEY`, in case it was ever needed for a project consuming paid API.
On 2026-09-12 it was removed entirely: an axis that is never evaluated is a
second set of books waiting to disagree with the first, and keeping it forced
`set_budget`, the alerts, `inspect_agent` and the console to keep talking about
money just to say it did not count. If it is ever needed, the commit that removed
it says exactly what was there.

### Why those tokens and not others

- **Not just output tokens.** An agent that launches twenty subagents writes
  little and reads a huge amount. A ceiling in output tokens would have made the
  agent in the incident look cheap: that is exactly the shape of what needs
  braking.
- **Not cache reads** (reverted on 2026-09-11). The first version counted them
  with this argument: they are most of the volume of an agent with a large
  context, and resending an enormous context on every turn is how a long session
  burns quota. In practice they measured something else: a CLI with a large
  system prompt re-reads its whole cached prefix on every call, and that adds up
  to hundreds of thousands of tokens that are not new work. The SELF-IMPROVEMENT
  reviewer crossed its 400k ceiling in the first minute without having filed
  anything (AJ: 227,946 read from cache against 12 of input and 2,657 of output).
  A growing context is still noticed: what newly enters the context is a cache
  write, and that one does count.
- **Yes to cache writes.** In Claude they are almost all of the input:
  `input_tokens` comes out in single digits because the rest comes in through
  `cache_creation_input_tokens`. Without them a Claude agent's ceiling would
  measure almost nothing. In Codex the write already comes inside the input.
- **Input is whatever did not come from cache, in both CLIs.** Claude already
  reports it that way; Codex includes cached tokens in `input_tokens` and its
  adapter subtracts them.
- **Not reasoning tokens.** They already come inside the output ones
  (`output_tokens_details.thinking_tokens`); adding them would count them twice.

### And they are measured, not estimated

Both units are. The tokens come from the transcript; the minutes, from having
seen the agent working. There is no rate, there is no guess and therefore there
is no way for the figure to come up short, which was the second defect — that is
also why the `≥` the estimated figures carried is gone.

### The ceilings of the dead clear themselves

A ceiling outlived the agent it braked. On 2026-09-12 there were **23 in the
ledger and none of them reached a live agent**: fourteen from archived agents,
nine from agents of which not even that was left.

`pruneOrphans` picks them up on every sweep: a ceiling whose subject — agent,
squad or mission — is not in the fleet gets marked, and is deleted if it is
**still** missing ten minutes later. Two observations separated in time are
needed, and neither counts with an empty fleet: a freshly rotated hub sees it
empty until the collector speaks, and pruning there would disarm the entire fleet
in one pass. If the subject reappears — an unarchived session, a squad that has
members again — the mark is cleared and the ceiling stays.

What it deletes is said in the hub log, not to CAPCOM: it is a fact, not an
alert, and CAPCOM can do nothing with it.

### Time

`budget_min` measures **minutes working**, not minutes since launch. The ledger
accumulates time only while it sees the agent in `booting`, `thinking` or
`working`, in its own pass; it works the same with Claude, with Codex or with any
other CLI because it does not depend on the runtime writing a duration.

An idle agent accumulates zero. That was the clock alert.

---

## 2 · The estimator that lied, and why it is gone

The hub reported ~$10 where the journal recorded $105.54, and $3.67 where the
real figure was ~$23: between 6 and 20 times too low. Three causes:

1. **It did not include descendants.** The consumption of a worker's `Task`
   subagents was charged to nobody until close. See §3, which still stands.
2. **It ignored cache reads.** The estimate added input and output and left out
   the bulk of the volume.
3. **It was presented as a total.** A `~$10` invites you to read it as the
   figure.

All three were fixed, and even fixed the figure was still an estimate on a flat
plan: an exact number for something nobody charges. On 2026-09-12 the whole
estimator was removed, with its `ORCA_BUDGET_USD_PER_MTOK` and its cache
weighting of 0.1. The figure that governs an alert is no longer an estimate of
anything.

---

## 3 · Descendants

### It is charged to the ancestor, in the same pass

A `Task` subagent has no budget of its own: it exists inside its parent's turn
and what it spends is charged to its ancestor **on every sweep**, not at close.
That was the reason a lead reached 618 % of its ceiling before the first alert.

An agent ORCA launched as a full session **is** a budget subject of its own and
is **not** charged to whoever launched it: that is what the squad ceiling is for.
The boundary is `Agent.subagent`, which already told the two apart.

The alerts say so: `… · includes 24 live Task subagents`.

### The brake

| Variable | Default | What it is |
|---|---|---|
| `ORCA_MAX_DESCENDANTS` | `8` | Live `Task` subagents under an agent, whole subtree. |
| `ORCA_MAX_AGENT_DEPTH` | `2` | Generations allowed: children and grandchildren yes, great-grandchildren no. |
| `ORCA_SWARM_ACTION` | `warn` | `stop` also stops the ancestor's session. |

In the incident: 4 children + 24 grandchildren = 28 live against a cap of 8. The
alert comes out on the first sweep where it is crossed.

**Why `warn` by default.** The hub cannot kill a native `Task` subagent: it has
no session of its own, it has no pane, there is nothing to stop. The only
stoppable thing is the ancestor, and stopping it is a decision with a cost. So by
default it says so, clearly and with the actions that actually reach that agent;
`ORCA_SWARM_ACTION=stop` stops the ancestor for whoever wants the guillotine.

> The root fix — taking the `Task` tool away from a worker instead of asking it
> not to use it — lives in the collector's `spawn` and is outside this delivery.

### CAPCOM sees the tree

`inspect_agent` showed `children: []` while 24 grandchildren were running,
because `Agent.childIds` is written by the collector and arrived empty. Now the
tree is derived from `parentId` over the whole fleet — the same source the ledger
uses to charge, so what is seen and what is charged cannot disagree:

```json
"lineage": {
  "parent": null, "depth": 0,
  "children": [ … ],
  "descendants": [ { "callsign": "S1", "generation": 1, "subagent": true, "tokens": 412000 } ],
  "live_descendants": 24, "live_subagents": 24, "max_generation": 2, "truncated": 0
}
```

---

## 4 · Liveness: death demands evidence, life does not

This is the most important fix in the delivery and the one that cost the most to
learn.

### The problem

The collector only retires an agent when its **transcript disappears from disk**,
and a transcript does not disappear because the pane is closed: it stays there
with the last derived state frozen. A squad stopped with `stop_squad` still
showed up as `working`, with its brood intact, and from there:

- it fired `[BUDGET 100%]` in bursts — thirteen at once, all of them on the
  clock;
- it fired `[SWARM CAP]` over and over, with 25 subagents that did not exist;
- and **no tool reached it**: `archive_agents` only touches finished ones,
  `stop_agent` only background ones, `interrupt_agent` only ones with a pane. An
  agent could stay in that limbo forever.

### The expensive mistake, and why the rule is what it is

The first correction inferred death from silence: anyone who claimed to be
`working` and had gone twenty minutes without writing to its transcript was
declared gone. **It marked seven live agents dead in the middle of their turn.**
They were reasoning, or writing a five-hundred-line file — things that leave no
trace for a good while. The operator came close to relaunching five evaluators
and duplicating hours of work and of consumption.

The two errors do not cost the same:

| Error | Cost |
|---|---|
| Treating a dead agent as alive | An annoying alert. Fixed by retiring it by hand. |
| Treating a live agent as dead | Work in progress thrown away and consumption duplicated. |

**The asymmetry is in the code, not in the judgement of whoever reads it.** The
hub does not conclude a death from an absence of signal. Only three things end an
agent, and all three are someone **asserting** something:

1. the collector says it finished (`done` / `dead`);
2. someone stopped it — `stop_agent`, `stop_squad`, `retire_agent`, or the budget
   ledger itself when it dispatches a stop;
3. its machine is not connected, which is a fact about the hub and not a guess
   about the agent.

And all of them are **reversible**: if the agent makes tool calls or changes lines
again, the tombstone is lifted on the next pass with nobody intervening.

### A single guardian

`src/hub/liveness.ts` — `isLiveAgent()` — goes in front of **every** periodic
check. The budget ledger and the swarm brake ask the same question, so they
cannot disagree again. An agent that is not alive does not count as a member,
does not consume, does not fire alerts, and its `Task` brood goes with it.

### The advice the alerts give is executable

`reachability()` answers, with the same predicates the real tools apply, what can
be done with a specific agent. The alerts only recommend what works:

- with a pane → `interrupt_agent` and `stop_agent`;
- addressable background, no pane → `stop_agent`;
- neither one nor the other → `retire_agent`, and it says why it is the only one.

### Why archiving was not enough: the ghost came back

B9 went through four different states in one afternoon, being the same
nonexistent agent: alive and untouchable → `done` through reconciliation →
archived with its whole squad (nine agents) → **back in `idle`, with its
twenty-five ghost subagents and a fresh `[SWARM CAP]`**.

The cause: the collector rediscovers sessions by re-reading the transcripts in
`~/.claude/projects`, and a finished transcript is derived again as `idle` —
which is literally the CLI's "end of turn" state. The world had this rule:

> If an archived agent comes back in a live state, someone must have resumed the
> session: lift the tombstone.

Which is false. Coming back in `idle` proves nothing; it is what *any* transcript
does when re-read. So archiving cleaned the picture and not the world, and the
liveness guardian filtered nothing either — the world said `idle`, that is, alive.

**The new rule: a tombstone is only lifted by activity LATER than the
archiving.** The collector's `updatedAt` is the transcript's last real activity,
not the time of the pass, so the comparison is exact. It closes both doors: the
`agent:new` one and the one for the patch that asked for a resync.

It is the same asymmetry as §4: being wrong by rejecting someone who really did
come back is cheap and reversible — the operator unarchives it from the console —
and being wrong by readmitting them is an immortal ghost.

### The manual way out

**`retire_agent(agent_id, reason)`** — and **`orca retire <K9> --reason "<why>"`**
in the CLI, because a CAPCOM session negotiates its list of MCP tools at startup
and a tool born afterwards does not exist for the acting command until it
reconnects. A terminal is always there.

It declares gone an agent whose session no longer exists, in a single gesture and
durably:

1. it marks it `dead` with the reason, which stays in the feed;
2. **it takes its `Task` brood with it** — a subagent has no session of its own,
   and besides, a parent with "live" children cannot be archived, because
   `archiveCandidates` keeps it around so as not to break the lineage;
3. **it archives all of them**, which is what persists to disk and what stops
   rediscovery from signing them up again.

Marking it dead and leaving it in the fleet was not a way out: the discoverer's
next pass overwrote it. The tombstone does hold, and it survives a hub restart.

It kills nothing on the machine (there is nothing left to kill) and it does not
delete the transcript. If the session turns out to be alive and writes again, the
hub lifts the tombstone on its own.

### The general rule: advice has to be invocable

> **Every action the hub recommends in an alert has to be executable by whoever
> receives that alert.**

A message saying "use `retire_agent`" aimed at someone who does not have
`retire_agent` is not advice: it is an instruction impossible to follow, and it
costs more time than saying nothing. In a single day ORCA gave three:

| The instruction | Why it could not be followed |
|---|---|
| `interrupt_agent` / `stop_agent` on a ghost | Neither a pane nor a background session: neither one reached it. |
| `tmux ls` | Without `-L orca` it looks at another server and lists nothing from the fleet. |
| `orca-tell …` | It was not on the PATH of whoever received the message. |
| `retire_agent` | An MCP tool born after the CAPCOM session negotiated its list: it does not exist for it until it reconnects. |

From that, two consequences in the code, and not only in the judgement of whoever
writes the messages:

1. **`reachability()`** decides what can be done to an agent with the same
   predicates the real tools apply, and the alerts only name what works for *that*
   agent.
2. **Every way out also exists in the CLI.** An MCP session negotiates its tools
   at startup; a terminal is always there. `retire_agent` has its
   `orca retire <K9> --reason "<why>"`, and a rejection prints the reason —
   "it is already done: archive it with `archive_agents`" is the next
   instruction, and swallowing it leaves the operator with an exit code and
   nothing else.

---

## 5 · Alerts in bursts are an event

Thirteen `[BUDGET 100%]` in a row, for the same reason and at the same instant,
buried a report the operator was reading. The feed still carries one entry per
alert — it is history, and each one hangs off its agent — but **CAPCOM gets a
single message per pass**:

```
[BUDGET] 13 budget notices in one sweep — 2 stopped, 8 at 100%, 3 at 80%. Worst: 1C at 988%.
· [BUDGET STOP] 1C · 24.1M of 2.5M tokens (988%) · no tool calls or edits in the last 3 min · stopped by the hub. …
· [BUDGET 100%] CG · 18.9M of 8.0M tokens (236%) · includes 4 live Task subagents · still making progress (CG 12s ago); not stopped. …
· …and 7 more, all of them in the console feed.
```

It is sorted by severity — stops, swarm, 100 %, 80 % — and the first six are
shown in full.

---

## 6 · What CAPCOM will see exactly

```
[BUDGET 80%]  K9 · 8.5M of 10.0M tokens (85%)
[BUDGET 80%]  K9 · squad audit-01 · 8.5M of 10.0M tokens (85%) · 24m of 30m active (80%) · 85% used
[BUDGET 100%] squad rubric-01 (CG, 1C, 3L) · 41.0M of 20.0M tokens (205%) · includes 24 live Task
              subagents · still making progress (CG 12s ago); not stopped. Use stop_agent, or raise
              it with set_budget.
[BUDGET STOP] 1C · mission mission_ab12 · 24.1M of 2.5M tokens (988%) · no tool calls or edits in
              the last 3 min · stopped by the hub. Raise it with set_budget and resume if the work
              must go on.
[SWARM CAP]   B9 · squad ideas-01 · 25 live Task subagents (cap 8) · nested 3 deep (cap 2) · their
              tokens already count against B9. The hub cannot stop a native Task subagent. Use
              stop_agent to end the session, or retire_agent if it turns out the session no longer
              exists. Raise the caps with ORCA_MAX_DESCENDANTS / ORCA_MAX_AGENT_DEPTH.
```

And what it will **no longer** see: not one line about an agent that is idle,
finished, stopped or on a machine that is not connected.

---

## 7 · The environment, in full

| Variable | Default | What it does |
|---|---|---|
| `ORCA_DEFAULT_BUDGET_TOKENS` | 23,000,000 | Token ceiling for every worker without its own; CAPCOM is excluded. Absent, empty or invalid falls back to the default. |
| `ORCA_DEFAULT_BUDGET_MIN` | none | The same, in **active** minutes. |
| `ORCA_BUDGET_ACTION` | `stop` | What 100 % with no progress does. `warn` only reports. |
| `ORCA_BUDGET_PROGRESS_MIN` | `3` | Minutes of silence before counting as stalled. |
| `ORCA_MAX_DESCENDANTS` | `8` | Live `Task` subagents under an agent. |
| `ORCA_MAX_AGENT_DEPTH` | `2` | Generations of `Task` subagents. |
| `ORCA_SWARM_ACTION` | `warn` | `stop` also stops the ancestor's session. |

The default ceilings are still empty: changing the unit is not the same as
turning on a limit across the whole fleet, and turning it on is the operator's
decision. A reasonable starting point for a Claude worker with a large context is
between 15 and 30 million tokens.

The descendant brake **does** come with values set: there was nothing there, and
the absence of a brake was the most expensive part of the incident.

---

## Filters that cover this

```
npm test -- budgets        21 tests: unit, thresholds, active time, idle, retirement,
                           descendants, brake, the money that is gone, pruning
                           orphan ceilings, grouping, hub
npm test -- briefing       that CAPCOM's brief names retire_agent and the new unit
npm test -- worker-recovery that a handoff does not reset an agent's consumption
npm test -- hub            the world, reconciliation and eviction
npm test -- archive        that a re-read ghost does not come back and that retire_agent
                           takes its brood with it and archives it too
npm test -- --changed      whatever reaches what you touched
```

The CLI is checked by hand, which is how it is used:

```
node bin/orca.mjs --help | grep retire
node bin/orca.mjs retire <K9> --reason "<why>"
```
