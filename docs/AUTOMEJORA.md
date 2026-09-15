# SELF-IMPROVEMENT — ORCA looking at itself

> The model and the budgets of the reviewer are in
> [`AUTOMEJORA-MODELO.md`](AUTOMEJORA-MODELO.md).

A separate section of the console, with its own shape, color and alert, where
ORCA reviews **the instrument** instead of the fleet: how the console and CAPCOM
are being used, what gets in the way, what costs more than it should, and what
could be done better. The review **proposes**; what turns a proposal into work is
a decision by the operator.

## Why it is a section and not one more window

Everything else in the field talks about agents. A proposal about the console
read in the clothes of the mission panel passes for an agent's work, and that is
exactly the misunderstanding that makes nobody read it. So the section has:

- **Its own color.** `--auto` (`#b47cff`), a violet that exists nowhere else in
  ORCA. In this console color is meaning, and every color there is talks about
  agents: lime alive, amber *needs you now*, red breach, cyan CAPCOM, blue
  waiting on someone else. None could be borrowed without lying — least of all
  amber, which means an agent STOPPED waiting on a person, and a proposal stops
  nobody.
- **Its own shape.** Cards with the tile's bite on the opposite corner (top
  left) and a bar on the left edge. The bar is **solid** if the proposal rests on
  measurements and **dashed** if it is a hypothesis: the texture says what the
  idea is made of before the label does, the same way a tile's pattern says which
  runtime runs inside.
- **Its own alert, exactly once.** A count in the header, a dot in the corner of
  the card, a sideways step of the section and a sound. None of that happens
  again for the same proposal. It goes quiet when the card is OPENED, which is
  when it has really been seen. Nothing opens by itself: in ORCA the only thing
  that can demand a human's attention on its own is a stopped agent.

It lives top right under the mast (`hud/improve.ts`), leaves the radar corner and
the mission panel free, folds into its header and the fold is remembered. `⌥I`
and `/improve` unfold it and bring it into view.

## What a proposal is

In the order in which an operator decides:

| | |
|---|---|
| summary | One or two sentences. The only thing you read without opening anything. |
| motivation | `evidence`: **measured** figures, quoted as they came. Required in `kind: observed`. |
| hypothesis | What is being assumed. Required in `kind: hypothesis`. |
| detail | The long part, folded. Reachable, not in front of you. |
| question | What only the operator can decide, when it would change the proposal. |
| impact / effort | Two three-cell meters, **only if there is a basis for them**. |

**Creativity is not limited to the measurable.** A console that only improves
what it already knows how to count never reaches what it does not do yet, so
ideas the data does not support are asked for explicitly — new capabilities,
another shape, a hunch about what confuses people. They go marked `hypothesis`
and with the assumption written down. What is never accepted is an invented
measurement: `normalizeDraft` rejects an `observed` proposal with no figures and
a `hypothesis` with no hypothesis, with the reason, so CAPCOM can fix it in the
same turn. **`impact` and `effort` are optional on purpose**: the operator sorts
by them, and an invented estimate makes them sort wrong.

## States and actions

`open` · `snoozed` (comes back on its own when it expires) · `dismissed` ·
`sent` · `completed` · `archived`. The last two are not set by the operator from
the board: they are set by the **mission** (see
[What the mission gives back](#what-the-mission-gives-back)).

- **REPLY** — answers in the proposal's thread *and* hands CAPCOM the turn with
  the answer, which it acknowledges with `note_improvement`. The whole
  conversation is kept and travels with the proposal if it ends up as a mission.
- **LATER · 3D** — postpones. A week buries it; a day is no rest.
- **DISMISS** — discards it. It is **kept**: that is what stops the next review
  from proposing it again.
- **REOPEN** — brings it back. Not one that is already a mission (sent, finished
  or archived): a mission is reopened from its own window, not from here.
- **IMPLEMENT** (until 2026-09-09, `SEND TO CAPCOM`) — the only thing in the
  section that produces work. It opens a normal mission titled `AUTOMEJORA · …`
  with the whole proposal inside (summary, evidence, hypothesis, detail and the
  conversation), leaves the proposal tied to it (`missionId`, with `OPEN MISSION`
  in its place), and **launches an ORCA agent of its own as the lead of that
  mission** on the ORCA repository (`ImproveApi.implement`, with the
  `implementerBrief` brief: what to implement, how it is verified here —
  `npm run typecheck`, `npm test -- --changed` — and that its last message is the
  report). The lead is **FORGE**, a specialized coordinator per approved
  proposal: it assigns, follows up, resolves operational blockers, verifies and
  consolidates. **CAPCOM keeps final control, security decisions, closing and
  publication**. FORGE uses the existing mission and squad contracts, with no
  states of its own. Its approval is recorded as a system event, not as a
  question left pending for CAPCOM. The squad is linked before the spawn. Repeat
  sends, invalid or already-taken ids, and discarded or still-postponed proposals
  are rejected. Lead and children use `auto` permissions for routine work and
  escalate elevated or ambiguous actions to CAPCOM; finishing a `forge-…` squad
  does not trigger the automatic publisher. The detail of the flow and its limits
  is in [FORGE](FORGE.md).
  If the agent cannot be launched — the ORCA repo is not a project on the fleet,
  or there is no machine — the mission is written with a line from ORCA saying
  why, and the console reports it; writing to that mission goes to CAPCOM,
  because it has no lead.

## What the mission gives back

Until 2026-09-10 the `missionId` link was one-way: IMPLEMENT wrote it and nobody
looked at it again. A mission CAPCOM closed with `report_mission` left the
proposal in `sent` forever, and one the operator archived from its window left a
live row on the board for work the mission panel no longer showed: two panels
saying different things about the same fact, and finished work that looked
pending.

Now the proposal copies what its mission says, with a single rule
(`linkedStatus` in `shared/improve.ts`):

| The mission is | The proposal goes to |
| --- | --- |
| `active` or `failed`, not archived | `sent` |
| `completed`, not archived | `completed` |
| archived, however it ended | `archived` |

And in both directions: reopening the mission (writing to it) returns it to
`sent`, unarchiving it returns it to whatever its state says. Every change leaves
a `system` line in the proposal's conversation (`Mission completed.`, `Mission
archived: …`, `Mission restored from the archive.`, `Mission reopened.`), which
is where the operator reads what happened.

Where it happens: `ImproveStore.syncMission`, called from the `MissionStore`'s
`changed` in the hub — the same point that publishes the mission to the consoles
— and `syncMissions` once at startup, for whatever happened to missions while the
hub was down (or before it knew how to count it: that is how the two orphan
proposals that motivated this caught up). It only touches proposals linked to
that mission and already in a mission state: a discarded one does not come back
to life because someone writes in the mission, and a `failed` one stays in `sent`,
because it is still an open mission in the other panel.

On the board, a `completed` one still carries the mission mark (the lime bar and
OPEN MISSION) and says `DONE` in the row; an `archived` one is not shown, not
even by unfolding the closed ones, which is what avoids two versions of the same
work. `list_improvements` returns them if asked for
`status: completed | archived`.

## Deduplication

Every proposal has an idea **key**. Whoever reports picks it — they are asked to
reuse the one from an open proposal — and failing that it comes from the
normalized title. `findDuplicate` looks first by key and then by normalized
title, and it looks at **all** proposals, discarded ones included: discarding
something and having it come back the next morning is the fastest way to make
nobody look at the section. A repeat raises `raised`, refreshes evidence and
impact/effort, **does not change the state** and **does not alert again**.

## The reviewer agent

**Every review is a temporary agent, not a CAPCOM turn.** ORCA launches it
through the normal spawn path: it shows up in the field, it has a callsign, a
state, a cost and a window, it does its work, it files and it ends.

The difference is not one of implementation, it is one of what the operator can
see and do. A CAPCOM turn is invisible while it runs — you cannot tell whether it
is thinking, how long it has been going, how much it has spent or how to stop it
— and it competes for the command session's context with everything else the
fleet is asking of it. An agent can be watched, flown to, opened in its own
window, given a budget and stopped. And when it fails, it fails the way an agent
fails: visibly.

**How it is launched.** `spawn` with `parentId: null` (it belongs to nobody;
hanging it off CAPCOM would put it in the waker and cost a turn per review, which
is what this architecture came to remove), `worktree: false` (it is not going to
write), and `review: true`, which changes two things **on the machine**:

- it puts `orca-improve` on its PATH, its only channel for filing;
- it **takes away** the editing tools (`--disallowedTools Edit Write
  NotebookEdit MultiEdit`). That is a withdrawn capability, not an instruction: a
  stuck model uses whatever way out it can see.

**Where it runs.** In the ORCA repository, which is what it is going to read. It
finds it on its own (`ORCA_ROOT`, the root of ORCA's own code) among the fleet's
projects; `ORCA_IMPROVE_PROJECT` names it by id, code, name or path. Without
either of the two, nothing is launched and the panel says why.

**Its identity in the field.** Runtime 8 in the shader: **permanent violet line**
and **violet wake**, the same way CAPCOM carries its cyan one. It is an IDENTITY,
not a state: the body color and the left-edge band still say what is actually
happening to it, so a blocked reviewer looks amber inside a violet frame and a
dead one looks red. The console knows who is a reviewer by reading the BOARD
(`reviewerIds`), which already travels whole and keeps the last 40 reviews: no
new `role` had to go through the collector, the hub and the protocol to say what
this already says.

**States of a review**, and none of them is "unknown":

| | |
|---|---|
| `launching` | the spawn was requested; there is no agent to name yet |
| `running` | the agent exists and is on it |
| `reported` | it filed proposals — **the only ending that counts as a review done** |
| `ended` | the agent finished **without** filing anything |
| `failed` | the spawn failed, or the agent died |
| `cancelled` | the operator stopped it |
| `expired` | 45 minutes without closing in any other way |
| `overbudget` | it crossed its token ceiling and ORCA stopped it |

`ended` and `reported` are different on purpose: an agent that finishes does not
prove it proposed anything, and saying "review completed" when not a single line
arrived would be the kind of false result that makes a self-running panel
useless. What closes a review is `endedAt`; filing does **not** close it, because
the brief tells the reviewer to fix what was rejected and send it again, and
meanwhile it keeps spending.

**One and only one.** The slot is reserved BEFORE asking for the spawn
(`beginReview` leaves the review in `launching`), so two ticks cannot launch two
reviewers even if the spawn is slow. And **no loop is possible**: what triggers a
review are the console and CAPCOM counters, which a reviewer does not touch.

**Nothing hangs, and nothing stays alive.** A sweep every 20 s and at startup
closes whatever can no longer end well: the wall clock ran out (and then the
agent is also STOPPED), the hub restarted and the agent is no longer in the
world, or it ended and the event was lost.

And it also closes what **ended without saying so**. Measured in the first real
review: a Claude Code agent **does not end by itself** — it finishes its turn,
goes `idle` and waits for another prompt nobody is going to send it. A reviewer
that is `idle` for `REVIEWER_IDLE_MS` (one minute, the same settling time
`wake.ts` uses, because a CLI passes through `idle` between two tools) is treated
as finished: the review is closed — `reported` if it filed, `ended` if not — **and
the agent is stopped**. Without this, a reviewer that had already delivered
stayed a live session until the wall clock: the "permanent agent" this section
promises not to leave behind.

**Deciding how it ended ≠ releasing the slot.** `outcomeAt` comes first — it went
over the ceiling, its clock ran out, the operator stopped it, it filed and went
quiet; `endedAt` comes second, and is **only set by confirmation that the agent
is gone**: terminal, or out of the world. **There is no deadline that releases
the slot.** If the `stop` fails it is retried with a bound (`STOP_ATTEMPTS` = 5,
with waits of 20 s · 40 s · 80 s · 160 s · 320 s) and exhausting them does not
release it either: the section stays blocked **and says so**, with the attempts
and since when. A visible block is a problem someone can look at; two reviewers at
once is not. Retrying a `stop` gives nobody turns: there is no spending loop.

**Budget.** See §"What it costs".

**The board arrives and is asked for again.** The section asks for it at mount
**and on every reconnect** — a restarted hub pushes nothing — with a bounded
retry (700 ms · 1.5 s · 3 s · 6 s · 12 s) and only while there is a link. With no
link it burns no attempts: it waits for the event. What could not be fetched is
SAID (`COULD NOT READ THE BOARD`, with `TRY AGAIN`; `NO LINK · SHOWING THE LAST
BOARD`), and what was already known is not erased. Reading the board is
`improve:get` and never launches a review.

**In the console.** While a review is in flight, the section shows a row with the
dot for its real state, the callsign (clickable: flies the camera and opens its
window), the word for its state, how long it has been going, how much it has
spent out of how much, and `STOP`. An open proposal says `PROPOSED BY <callsign>`
with the same way back. On a phone the row goes into the section-bar sheet and is
**the only** way to the reviewer: there is no `⌥I` and no window to open by hand.

## What it costs

Two axes, and **neither follows from the other**:

- `perDay` (4 out of the box) limits how many **automatic** reviews happen in
  24 h. It does not bind manual runs, and it should not: the operator presses
  REVIEW NOW whenever they want.
- `budgetTokens` (400,000 out of the box) is the ceiling for **each** review.

A daily ceiling split across reviews would be a budget that shrinks with the time
of day, and a review launched late in the day cannot be worth less than the one
in the morning.

### The ceiling is a BRAKE, not a wall

**Multiplying the two does not give a daily spending ceiling, and saying it does
would be a lie.** Measured in the first real review (`rev_mtschaq0u83g1or2`,
2026-09-08): the reviewer crossed 400k in under a minute and got as far as 1.1M
before anyone stopped it. Three reasons, and none of them is fixed by raising the
number:

1. **The measurement arrives late and jumps around.** Consumption is derived from
   the transcript the collector re-reads; in that same session the figure went
   through 201k, 1,116,804 and 622,319 before settling at the close. Nobody
   brakes at a point they have not seen yet.
2. **Braking means sending a command.** The `stop` travels to the collector and
   can be slow or fail.
3. **A model call cannot be cut in half.** A single turn with a lot of context
   already spends more than the rest of the pass.

What ORCA **does** guarantee: it looks at the reviewer's consumption on every
tick (20 s) **and on every state change of its own**, which is when its spend has
just moved; as soon as it sees it over the ceiling, **it stops it and closes the
review as `overbudget`**, with the figures in the note. The panel shows `STOPPED
OVER BUDGET`.

The ceiling is also enforced through the **hub's budget ledger**
(`budgets.set({kind:'agent', ref})`, or `setPendingByShortId` while the session
has not appeared yet), so the reviewer is seen and braked like any other agent.
That ledger is also a sampling brake, not a wall: which is why the section keeps
its own on top and does not delegate the count.

In **tokens** and not in dollars because the money axis is off unless
`ORCA_BUDGET_MONEY=1`, and a budget that is almost never evaluated is not a
budget. `SETUP` changes it in five steps (100k · 200k · 400k · 800k · 2M) and
`ORCA_IMPROVE_BUDGET_TOKENS` sets the initial value.

## When it reviews

A tick every minute that only reads memory and exits at the first condition that
fails. A CAPCOM turn is requested only when all five pass, and the panel shows
which one is missing (`dueForReview`):

| Condition | What the panel says |
|---|---|
| not paused | `PAUSED BY THE OPERATOR` |
| no review in flight | `A REVIEW IS IN FLIGHT · 12m AGO` |
| there is a CAPCOM session | `NO CAPCOM SESSION TO ASK` |
| `everyMin` (6h) has passed | `NEXT IN 3h` |
| under the daily cap (4) | `4 REVIEWS IN 24H · AT THE DAILY CEILING` |
| there are `minSignal` (40) new gestures | `WAITING FOR SIGNAL · 12/40` |
| CAPCOM is not mid-turn | `CAPCOM IS MID-TURN` |

`REVIEW NOW` skips the clock, the signal and the cap — the operator already
decided — but not a live CAPCOM, which is not a preference. `SETUP` changes the
three limits and `PAUSE` stops the whole section; everything is saved.
`ORCA_IMPROVE=0` is the hard switch (no clock and no manual run);
`ORCA_IMPROVE_EVERY_MIN`, `ORCA_IMPROVE_PER_DAY`, `ORCA_IMPROVE_MIN_SIGNAL` and
`ORCA_IMPROVE_PAUSED` are only the initial values.

A requested review stays `pending` and **expires after 45 minutes**: without
that, the first one that gets lost — CAPCOM rotates, dies, or does not call the
tool — would turn the section off forever.

**Why CAPCOM and not a worker.** CAPCOM already has in front of it what needs
reviewing: the fleet, the journal, the missions and the tools. A worker would
cost a whole session, a worktree and a cold start just to end up reading the same
thing.

## Telemetry

Minimal, existing and without content. Two sources, neither of them new:

- **The journal** (`hub/journal.ts`, 24h `stats()`): launches by origin,
  done/dead, total and average cost, average duration, escalations — who answered
  them and how long they waited — CAPCOM rotations, landings, and the same per
  project using its **code** (`AX`).
- **Usage counters** (`UsageMeter`): `mcp:<tool>` every time CAPCOM calls a tool,
  `ui:<frame>` every time the console asks the hub for something, and
  `gesture:<family>:<detail>` every time the operator **does** something in the
  interface that asks the hub for nothing: opens a window (`win:agent`,
  `win:terminal`, `win:gallery`…), unfolds a section (`hud:sheet-improve`,
  `hud:missions-unfold`), uses a shortcut (`key:alt-c`, `key:f`) or flies the
  camera (`fly:agent`, `fly:point`). A **name and a count**, never the arguments:
  not which agent, not which file. It is what shows what actually gets used and
  what nobody can find.

  Gestures accumulate in the console and go out in batches every 15 s (or sooner,
  with 50 accumulated) in a `gestures` frame with no ack (`src/ui/gestures.ts`).
  The families are a **closed list** (`win`, `hud`, `key`, `fly`) and each one has
  a ceiling of 24 distinct names; anything over the ceiling is merged into
  `<family>:other`, so a buggy client cannot fill the board's 200 counters and
  crowd out CAPCOM's tools (`src/shared/gestures.ts`). The reviewer's report shows
  them in three lines: the most touched, the total per family (with the zeros) and
  **which window classes were not opened even once** in the 24 h window.

What does **not** go into a report: paths, briefs, transcripts, anyone's
questions or answers, and no secrets. On top of that, everything CAPCOM writes
goes through `redact` before touching disk, which is a belt over the braces: it
should never fire, but a token pasted into a proposal would stay on disk and go
out over the protocol to any connected console.

Two accumulators of the same fact, because they answer different questions:
`usage` is the window shown to the review, `signal` is what has happened **since**
the last one and is what decides whether it is worth asking for another. `signal`
is zeroed when the review is REQUESTED, not when it comes back.

## The reviewer's channel

An agent has no socket and no hub token: it has a filesystem. So filing means
leaving a file, same as `orca-tell` and as an escalation.

```
orca-improve report --review <review_id> --file proposals.json
```

1. `bin/orca-improve.mjs` writes `<project>/.orca/improve/<id>.json` with
   write-and-rename, and waits.
2. `ImproveDropWatcher` (`collector/improve-drop.ts`) picks it up, validates shape
   and size, **deletes the file** and uploads it as `improve:report` with a
   `reportId`. The PATH does not travel: it stays indexed in the collector, so a
   compromised hub cannot choose where a file gets written.
3. The hub checks **who** is reporting — only the agent of the in-flight review,
   or one whose short id matches — files, and answers `improve:ack` with the same
   `reportId`.
4. The collector writes `<id>.ack.json` and `orca-improve` prints it: how many
   came in, how many were merged, and **the exact reason for each rejection**. A
   reason is something the reviewer can fix and send again in the same turn.

The receipt always comes back, including when the whole thing is rejected: a
report that gets lost in silence takes the review down with it without anyone
finding out.

## CAPCOM's tools

The one who reviews is the agent, not CAPCOM. What is left for CAPCOM is the
board:

- `list_improvements(status, limit)` — keys, states, which ones are already
  missions and what the operator answered.
- `note_improvement(proposal_id, text)` — answer the operator in a thread, when
  they responded to a question on a proposal.
- `report_improvements(review_id, proposals[])` — still published and does the
  same thing as `orca-improve`, with the same validation. It is used by a CAPCOM
  that wants to file something on its own; the normal path is the reviewer.

The three live in `agents/tools-improve.ts`, go out over the same MCP server as
the rest (`/mcp`) and are named in CAPCOM's brief (`collector/briefs.ts`), which
is what the `capcom` test requires.

## Where it lives

| | |
|---|---|
| `src/shared/improve.ts` | types, validation, deduplication, `dueForReview`, the prompt and the handover to a mission |
| `src/hub/improve.ts` | `UsageMeter`, `ImproveStore` (disk), `buildDigest`, the clock and the reviewer's lifecycle |
| `src/shared/gestures.ts` | the gesture vocabulary: families, ceilings, batch validation, aggregation by family |
| `src/ui/gestures.ts` | the console's counter: accumulates gestures and sends them in batches |
| `bin/orca-improve.mjs` | the CLI the reviewer files with |
| `src/collector/improve-drop.ts` | the `<project>/.orca/improve/` mailbox |
| `src/collector/shims.ts` | the third set of commands: the reviewer's |
| `src/agents/tools-improve.ts` | the three MCP tools |
| `src/hub/autonomy.ts` | piece F, mounted next to wake/verify/journal |
| `src/hub/server.ts` | `improve:get/run/act/seen/send/config`, the `t:'improve'` push, the counters |
| `src/ui/hud/improve.ts` | the section |
| `src/ui/styles/improve.css` | its color and its shape |

State in `~/.orca/hub/improve/improve.json`, written with temp-and-rename like
`missions.json`. If the directory cannot be written, the section keeps going in
memory and **says so** in its status line (`NOT SAVING · DECISIONS WILL BE LOST
ON RESTART`): a section that accepts decisions and loses them in silence is worse
than one that does not exist.

## Verification

```
npm test -- improve gestures        the section's suites and the gestures one
npx tsx test/hud-improve.shots.ts   the section, photographed against the console
```

`improve` covers four suites: `AUTOMEJORA` (the pieces, with a fake clock),
`AUTOMEJORA · hub` (a real hub over the console socket), `AUTOMEJORA · agente
revisor` (the whole path against a real machine on the other side of the wire:
launch, be seen, report, finish, fail, cancel) and `AUTOMEJORA · orca-improve`
(the real CLI as a subprocess against the real watcher).

`hud-improve.shots.ts` writes `test/shots/hud-improve*.png` and checks in the
browser the section's own color, the painted wake, the solid bar against the
dashed one, the open-before-closed order, the meters only when there is a basis
for them, the count of new items, evidence against hypothesis on opening, the
actions, that a sent one shows its mission and not a SEND, that a finished one
says DONE and keeps the mission mark while the archived one is not there even
behind the fold, the geometry against the mast, the clock, the mission panel and
the radar, and the fold. It runs on its own: `npx tsx test/hud-improve.shots.ts`.

FORGE coverage filters: `forge`, `improve`, `missions`, `mission-stall`, `wake`, `spawns`, `publisher`.
