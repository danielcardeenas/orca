# Missions

What used to be called a *task* is now a MISSION, top to bottom: in the console,
in the protocol, in CAPCOM's tools and on disk. The half-finished vocabulary was
the problem — the operator read "TASK" in the panel, "mission" in a worker's
brief and `task_id` in a tool, for three things that were not the same. And
along with the name, CAPCOM gains what it was missing: it can open a mission
itself, instead of depending on the button in the CEO window.

## What a mission is

A thread in the hub: its conversation, its agents, its status, its row in the
panel. It survives CAPCOM's session being recycled, it is archived and it is
recovered, and it is what the operator opens days later to find out how
something ended. It lives in `src/shared/missions.ts` (the shape) and
`src/hub/missions.ts` (the on-disk store).

Not to be confused with a spawn's `mission` field, which already existed and has
not changed: that one is the brief a worker wakes up with. A mission can have
several workers, each with its own spawn `mission`.

## The rename

| Before | Now |
| --- | --- |
| `src/shared/tasks.ts` | `src/shared/missions.ts` |
| `src/hub/tasks.ts` · `TaskStore` | `src/hub/missions.ts` · `MissionStore` |
| `src/ui/hud/tasks.ts` · `hud/task-status.ts` | `hud/missions.ts` · `hud/mission-status.ts` |
| `CapcomTask` `TaskMessage` `TaskStatus` | `CapcomMission` `MissionMessage` `MissionStatus` |
| `visibleTasks` `archivableTasks` `taskPrompt` | `visibleMissions` `archivableMissions` `missionPrompt` |
| `task:create` `task:archive` `task:purge` | `mission:create` `mission:archive` `mission:purge` |
| frame `{t:'task', task}` | `{t:'mission', mission}` |
| `ceo:say` with `taskId` | with `missionId` |
| `WorldState.tasks` | `WorldState.missions` |
| `store.upsertTask` `selectTask` `activeTaskId` | `upsertMission` `selectMission` `activeMissionId` |
| `prefs.tasksFolded` `capcomTasks` | `missionsFolded` `capcomMissions` |
| CSS `.tasks__*` · `.talk__g.is-task` | `.missions__*` · `.is-mission` |
| `/tasks archive\|restore\|purge` | `/missions …` |
| `NO TASKS` `NEW TASK` `TASK IN CAPCOM` | `NO MISSIONS` `NEW MISSION` `MISSION IN CAPCOM` |
| `journal` field `taskId` | `missionId` |
| budget scope `'task'` | `'mission'` |

What has NOT been touched, because it is not the same concept: Claude Code's
`Task` tool (subagents, `derive.ts`, `lineage.ts`), Codex's `task_started` /
`task_complete` events, and "task" in its ordinary English sense ("task
difficulty" in the recovery decisions, "the task" in a squad's brief). A `sed`
over the word would have broken all three.

## What cannot be invalidated

There is on-disk state from before the rename, and refusing to accept it would
not rename it: it would erase it from view. Three compatibility rules, all of
the same shape — read the old, always write the new:

- **Ids.** `MISSION_ID = /^(?:mission|task)_[A-Za-z0-9_-]{1,100}$/`. A stored
  `task_` id stays valid forever; whatever is born today is born `mission_`
  (`MISSION_ID_PREFIX`), so the old prefix can only arrive from something that
  already existed.
- **The file.** `MissionStore` reads `missions.json`, and `tasks.json` when the
  first one does not exist yet. It always writes `missions.json`: the first
  write migrates by itself and `tasks.json` stays on disk untouched, as a
  backup.
- **The browser key.** `orca.capcom.mission`, with `orca.capcom.task` as a
  read-only fallback. The first load copies the old one into the new one and
  removes the old one, so the console does not drag the previous vocabulary
  along on every reload.

Two more, of the same kind: `[ORCA TASK <id>]` is still recognized when
classifying CAPCOM's transcripts (`ui/windows/talk.ts`), because transcripts
already written carry it; and the placeholder title `New task` counts as a
placeholder alongside `New mission`, or an old mission with no title of its own
would stay named "New task" precisely when the operator writes to it and it
should take its name.

The journal translates `taskId` → `missionId` as it reads each entry (`migrate`
in `hub/journal.ts`): that is months of accumulated jsonl, and without it a
filter by mission would find nothing older than today.

## The MCP tool aliases

`report_task`, `list_tasks` and `inspect_task` still dispatch to the same handler
as their new names, and `task_id` is still accepted where it is now called
`mission_id` (also in `spawn_agent`, `launch_squad`, `set_budget` and
`journal`). They are not announced over MCP: anyone connecting fresh only sees
today's vocabulary.

They exist for a concrete reason, with an expiry date: there is a CAPCOM session
in flight with the old schema in its context, and taking it away all at once
breaks it mid-flight. Its brief is rewritten from `collector/briefs.ts` when
CAPCOM starts or rotates (`~/.orca/capcom/CLAUDE.md`), so they **expire at the
first CAPCOM rotation after this change**: from then on no session knows the old
names and the four lines of the `switch` can be deleted.

## `open_mission`

```
open_mission(title, first_message?, project_id?, agent_ids?) → { mission_id, title, status, project, agents }
```

Opens a mission by the same path as the NEW MISSION button: same store, same id,
same broadcast. The panel sees it appear live, it opens the same way in the CEO
window, it counts the same against the cap of one hundred and it archives the
same. It returns the `mission_id` so it can be passed straight to `spawn_agent` /
`launch_squad` and published with `report_mission`.

- `first_message` goes in as the `capcom` message that starts the thread — CAPCOM
  is the one writing, and a thread that said `human` would hand the operator his
  own words back as if he had typed them there. It carries the project code in
  front when there is one, so the mission reads whole from its first line.
- `agent_ids` adopts agents that are ALREADY alive, which is the "this thing I
  already launched, put it in a thread" case.
- It refuses without a title, with a project that does not exist, or with an
  unknown agent.

The criterion for when to use it lives in the brief (`collector/briefs.ts`,
section "When to open a mission"), which is where CAPCOM reads it:

- **Open a mission** for real work in a repo, anything with more than one step or
  more than one agent, and anything whose result the operator is going to want to
  consult later.
- **Leave the spawn loose** for the trivial and disposable: a smoke test, a
  two-minute check, something that fits in one line and nobody looks at again.
- If the operator says "make this a mission" or "no mission", he is in charge.

## The operator's question does not sit waiting

There was an asymmetry that did not hold up.

When an **agent** asks, the hub wakes CAPCOM and, if it does not answer within 90
seconds, passes the question to the operator saying that CAPCOM did not respond.
There is a clock, there is escalation and there is a record.

When the **operator** asked in a mission, his message was delivered once and that
was the end of it. If CAPCOM answered in the console and forgot to call
`report_mission`, the mission stayed `pending_human` forever: visible in
`briefing` and in `list_missions`, with nobody watching it. On 2026-09-08 it
happened three times in the same afternoon — a 30-minute wait, another of 23 —
and the operator had to ask whether the "in progress" he saw in the console was
true. It was.

An agent's time was better protected than the operator's.

### The third alarm

`hub/wake.ts` had two prefixes, `[AGENT …]` and `[HEARTBEAT]`. Now it has three.
It is the same machinery — the same 30 s tick, the same CAPCOM router, the same
watermark in `wake.json` — and not a parallel one:

```
[MISSION mission_ab12] "Rediseñar el selector" · the operator has been waiting 23m for a reply
  asked: ¿Puedes empezar por el filtro de estado antes que por el orden?
  reply with: report_mission(mission_id="mission_ab12", text="<your reply>", status="active")
Answering in the console does not close a mission: only report_mission does.
```

The three things needed to act without investigating: **which mission, how long
it has been waiting and what it asked** — with the exact call underneath, so that
answering is a matter of copying one line.

### The timings, and why

| Wait | What happens |
|---|---|
| 4 min | first reminder to CAPCOM |
| 15 min | second |
| 45 min | third |
| every 2 h | from then on |
| 30 min | **the operator** sees in his feed that his question is still unanswered |

**Four minutes for the first one.** An agent escalation is urgent at 90 seconds
because the agent is *stopped*; here nobody is stalled, so the clock can be
longer. But not much longer: a CAPCOM turn lasts minutes, and warning under three
would arrive while it is writing that very answer — the anxious version of the
problem. Four falls just behind a normal turn and well ahead of the 23 and the 30
the operator actually waited.

**And then spaced out.** The first reminder carries nearly all the information;
an identical fifth one carries none and covers the screen. It is the same lesson
as the thirteen `[BUDGET 100%]` messages from that same afternoon, and that is
why **several waiting missions are one message, never several**:

```
[MISSION] 3 operator questions are waiting on you, the oldest 30m.
[MISSION mission_c] …
[MISSION mission_a] …
Answer each with report_mission. Answering in the console does not close a mission.
```

**Half an hour for the operator.** It is exactly what he waited without knowing
it. It reaches his feed at warning level, not to scold anyone: a question of his
lost in a thread is worse than a stopped agent, and he is the only one who can
decide to insist or let it go. It goes out even when there is no CAPCOM alive —
especially then.

### It turns itself off

There is nothing to remember. The reminder comes from `missionDebt`: everything
after the mission's last `capcom` message is unanswered. As soon as CAPCOM calls
`report_mission`, the debt disappears and the reminder with it. If the operator
asks again, the ladder restarts and the warning goes out right away — insisting
is a sign that it is more urgent, not less.

The calculation lives in `shared/missions.ts` and not in the tools, because there
are two readers: `list_missions` / `inspect_mission`, which show it, and the
alarm, which warns because of it. Two implementations of "what is the operator
waiting for" would end up disagreeing, and the one that disagrees is always the
one that stays quiet.

The reminder count is persisted in `wake.json`. The hub restarts with every edit
under `tsx watch`; without persisting it, every restart would send the first
reminder for every open mission again, which is the burst this module exists to
avoid producing.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `ORCA_MISSION_REPLY_STEPS` | `4,15,45,120` | Minutes of waiting at which a reminder is sent. The last one repeats. Empty keeps the default; `0` turns it off. |
| `ORCA_MISSION_REPLY_ALERT_MIN` | `30` | Minutes after which the operator is told. `0` turns it off. |

## How it is navigated

A mission is a **window**, not a tab. It used to live inside CAPCOM: clicking one
in the ribbon swapped that window for its conversation, so having two in front of
you was impossible and reading a result while writing to command forced a choice.
Since 2026-09-08 each mission opens in `kinds/mission.ts`, a canvas window like
the rest — it drags, it stacks, it folds into the tray — with a stable identity
by `mission_id`:

- **Two doors, one call.** The HUD panel row and CAPCOM's ribbon both call
  `c.openMission(id, { tab })`. There are not two ways to be inside a mission,
  which is what guarantees that both say the same thing.
- **Opening the one already open focuses it.** The window key is
  `mission:<id>`, and the manager raises the existing one instead of stacking a
  copy (`wm.open`). If it is requested from the other half, it switches tabs.
- **Closing it neither archives nor ends anything.** Archiving is a separate
  button, with its confirmation when the mission is still alive; closing only
  removes the window, as with an agent's.
- **The one in front is "the open mission".** Window focus writes
  `store.activeMissionId`, which is what marks the panel row and what the field's
  arc follows.
- **It comes back with the session.** The manager persists windows anchored to
  nothing, with their `params`, so an open mission stays open after a reload.

The window has two tabs, which are the two questions people actually ask:
CONVERSATION (what was said, with whatever the hub has not confirmed yet marked
as such) and RESULTS (how it ended). A finished mission opens on RESULTS, which
is what you come for; a live one, on its conversation.

CAPCOM keeps what was always its own — its session — and its ribbon becomes the
index that opens missions. The order of the thread and the ribbon are in
[CAPCOM-CONVERSATION.md](CAPCOM-CONVERSATION.md).

## The HUD panel: top left, and a row is one line

The panel moved from the right corner to the **left**: it is the first thing read
and the eye starts there; the right keeps the clock and the minimap, which are
consulted, not read.

A folded row is **one line**: title, zipper, phase · how long ago, and how many
agents are on it. The crew used to go on a second line that wrapped — a squad of
six turned the panel into paragraphs and knocked the phase column out of
alignment — so now it lives in the detail.

The **detail** is the part that was missing. The full title and the whole
assignment could only be reached by hovering, and a `title=` cannot be tabbed to,
cannot be touched with a finger and disappears while you read it. Every row
carries a disclosure (`▸`) that is a real `<button>` with `aria-expanded`: Tab
reaches it, Enter and Space open it, and inside are the full title, the whole
assignment, the crew with their callsigns and the two entrances to the mission.
Clicking the row opens whichever half is right: conversation while it runs,
results when it is finished.

An implementation detail that is a rule of use: the panel **moves only what is
out of place** when it repaints. Reinserting every row on every render takes
focus away from whatever is inside, and the ten-second clock was enough for the
next keystroke to go to the field.

## On a phone

The panel does not float below 900px: there the two HUD sections — this one and
SELF-IMPROVEMENT — open as a **sheet** from a bar in the dock, one at a time, and
close with the same button, with the ×, with `Escape` or by touching the field.
The sheet is the same panel in a different box — not one node moves — so a
half-written draft and an expanded row survive rotating the phone and coming back
to the desktop. A mission's window takes the full width and leaves the dock band
free, with the composer anchored to the bottom and the virtual keyboard measured.
It lives in `src/ui/hud/sections.ts`. Rotated it is still a phone: what counts as one is
decided by `src/ui/phone.ts` — width and height, not width alone — and sideways
the window takes over the mast's space.

## CREW: who is doing it, and under whom

The window had two tabs and answered two questions — what was said, how it ended.
The third is the one you ask while looking at the field: **who is on this mission
and under whom**. All there was of that was WHAT CHANGED's flat list, one row per
agent, with no project, no squad and no word on who is in charge, and behind the
tab you use to look at a finished mission at that.

CREW is the roster, at three levels:

```
LEDGER                                   ← the island in the field, opens the project
  LEDGER-CLOSE · 6 · LED BY Z1           ← the squad, opens the squad
    Z1  WORKING   CLAUDE  —  —  Own the March close…      ← the lead, on top
    Z2  WORKING   CODEX   —  —  Reconcile the March…
    …
    Z6  DONE      CODEX   —  —  Reconcile the March…      ← finished, and still there
AXOLOTS
  K1  BLOCKED  CLAUDE  —  —  Draft the incident postmortem…
```

**The axis is project → squad → members, and not lineage.** Both are true, but
only one survives: the hub's record keeps the `projectId`, `squad` and `lead` of
every agent that flew, while `parentId` only exists while the agent is in the
world. With lineage, a closed mission — which is when this window gets opened —
would look flat.

**Two sources, one rule** (`ui/windows/mission-crew.ts`, pure and tested): the
live world rules on what changes — status, whether it can be talked to, which
squad it is in now — and the journal rules on what is no longer there. An agent
that flew and no longer shows up in the fleet **does not disappear from the
roster**: it comes out with what the journal knows, with its callsign in grey and
with no way to fly to it, because "who worked on this" is also the answer. The
measurements come only from the journal, with the usual rule: what nobody
measured is `—`, never `0`.

**Each row's glyph is the one from its tile.** Same seed as the field (the squad
if there is one, otherwise the id) and the lead wears it inverted, just like its
tile: the roster and the field read as the same fleet. That glyph in DOM
(`gfx/sigilHTML`) had gone months without drawing a single pixel — the cells went
out as outer shadows, and an outer shadow is clipped against the element's own
box — and it also affected the squad labels in the field; now they are painted as
background layers. `test/sigil.test.ts` pins it down.

### MUSTER: take the mission to the field, don't draw the field inside

The roster carries no map, and that is deliberate: the field is already the map,
and a thumbnail of it inside a window would be two truths about where each agent
is, with the small one always worse. What there is instead is a bridge, in the
window's header:

- **MUSTER** selects the crew, frames their tiles and turns on the spotlight, so
  that everything the mission does not touch drops to 12 % and the relationships
  stay. It stacks the view before moving the camera: `Backspace` goes back to
  where you were. With nobody from the mission in the field, the button is
  disabled.
- **A callsign** flies to its tile; **its brief** opens the agent's window; **a
  squad** opens its own; **an island** opens its project.
- The header counts `6 LIVE · 7 FLEW` and that counter goes into the tab.

The third door is in the HUD panel too: every expanded row offers CONVERSATION ·
CREW · RESULTS.

## The results: what the fleet did, not what was said

A mission's conversation is the word. RESULTS is the other side, and each section
says where it comes from:

| Section | Where from |
| --- | --- |
| RESULT | CAPCOM's last `report_mission`. Publishing the text and marking the mission complete are the same call, so that message IS the result |
| WHAT CHANGED | the hub's journal, by `missionId`: lines touched, cost, duration, final status and branch landings, per agent |
| FILES REPORTED | the paths written in the conversation, resolved against the project of whoever wrote them, opened in ORCA's viewer |
| MEDIA | the artifacts its agents published (`orca-show`) |
| REPORTS ALONG THE WAY | CAPCOM's earlier reports and what the workers reported |

**From the journal and not from the in-memory world**, because a finished agent
gets archived and its metrics go with it — and a mission is opened days later,
which is literally what it exists for. The hub answers the `mission:debrief`
frame (`shared/protocol.ts`) with a `MissionDebrief` assembled by
`shared/debrief.ts` from that mission's `launch` / `end` / `landing` entries. It
is requested, not emitted: sweeping the journal on every change in the world, for
every connected console, for a panel that is almost never looked at, would be
paying always to serve almost never.

**Nothing is invented.** A number nobody measured comes out `null` and is painted
`—`, never `0`, and `measured` says how many agents there is a record for: the
console has to be able to tell "nothing changed" from "nobody wrote it down",
because the second one needs saying out loud. As long as someone is still
running, the total carries "SO FAR". Every empty section says what is missing and
who should have put it there — a mission closed without `report_mission` says so
in those words.

## Talking to whoever ran it

> **2026-09-09.** There is no selector any more. The window has ONE outgoing
> line, you write only from CONVERSATION, and the recipient is decided by the hub
> with the rule the window shows above the box. What follows describes what there
> is.

The tab every mission opens on, live or finished, is **MISSION**: the whole
assignment (BRIEF), the result (RESULT) and what the fleet changed. The
conversation is the second tab, and it is the only one with a text box; from the
other two the footer says who the line would go to and offers `WRITE`, which
takes you to the conversation. That way you do not write where you cannot read
what you are answering.

The line goes to **one of two places, and it says which** before sending:

- **`TO K1 · LEAD OF THIS MISSION`.** The mission has a standing lead: an
  assigned agent that leads its squad, or — if no assigned agent leads — the lead
  of the squad the mission declares in `mission.squads`. Between two, the live one
  wins, and among finished ones the one that moved last. CAPCOM is never the lead
  of a mission. The message goes to its session with the header `[ORCA MISSION
  <id>] <title>` and a line telling it how to answer: its last message is what
  ORCA dumps into the mission. In the conversation the line stays as `YOU → K1`,
  marked with `to` (`MissionMessage.to`), and it is **not CAPCOM's debt**: the
  alarm does not remind it about it, and `list_missions` does not count it as
  `pending_human`.
- **`TO CAPCOM · NO LEAD ON THIS MISSION`** (or `· THE LEAD IS GONE`, with `READ
  K1` next to it to read its transcript). The line goes into the mission's
  conversation and CAPCOM receives it with the thread behind it, as always.

The rule is `missionLeadOf` in `shared/missions.ts`, and it is ONE because it has
two readers: the window, which promises, and the hub (`mission:say`), which
sends. If the lead died between the paint and the click, the hub picks CAPCOM and
the console says so.

**Writing in a finished mission reopens it.** Until 2026-09-09, talking to the
lead of a COMPLETED mission went through a direct `say` to the agent: the mission
never found out, it stayed COMPLETED while the lead did the new thing, and its
answer never reached the thread. Now both routes go through the hub, and both put
the mission into `active`.

### Members talk to the lead, not to CAPCOM

A squad with a standing lead is a funnel, and until today it had holes: every
member that finished or stopped to breathe woke CAPCOM with an `[AGENT …]`
(`hub/wake.ts`) and also put its `lastSay` into the mission's conversation
(`MissionStore.observe`), which triggered ANOTHER CAPCOM turn to "publish it".
Six members, twelve command turns to read what the lead was already
consolidating.

Since 2026-09-09:

- A member with a live lead **does not wake CAPCOM** and does not write in the
  mission. Its ending — `done`, `dead`, or a settled `idle` — goes to the lead as
  a notice (`tellLead`), and only if the member did not say so itself via
  `orca-tell`.
- **The lead** is the one that wakes CAPCOM when it finishes, and its word is what
  goes into the mission. The prompt CAPCOM receives says the lead has already
  consolidated and verified: `report_mission` and nothing else, no redoing and no
  relaunching.
- With the lead dead, the member goes back to talking to the mission and to
  CAPCOM: it is all that is left.

The lead's footer (`collector/briefs.ts`) tells it that it is also the way in —
the operator can write to it with `[ORCA MISSION <id>]` — and that its last
message is the report: it does not have to send anything to CAPCOM.

## Validation

```
npm test -- missions mission-status mission-crew sigil debrief briefing command wake journal budgets talk drafts capcom-new-hub worker-recovery improve
npx tsx test/hud-missions.shots.ts     the panel and the window against the live console
npx tsx test/mission-crew.shots.ts     the roster, its glyphs and MUSTER
npx tsx test/hud-mobile.shots.ts       the two sections and the window with a finger
```

`test/mission-crew.test.ts` covers the roster: the hierarchy with the lead on top
and the loose ones behind the squads, that the world rules on status and the
journal on the measurements, that an agent no longer in the fleet stays in the
list without a tile, that CAPCOM is not crew, the sigil's seed, and that anything
unmeasured is `null`. `test/sigil.test.ts` pins down that the DOM glyph paints
inside its box — the outer-shadow regression — and that the lead's is the
complement. `test/mission-crew.shots.ts` photographs it against the live console:
the two islands, the squad header with who is in charge, the finished one still
on the roster, that every glyph actually paints and that MUSTER moves the camera.

`test/missions.test.ts` covers the store, the archive and purge cycle, the
WebSocket wiring with the `mission:*` verbs, and that a mission saved before the
rename keeps its id, conversation, title and place.
`test/briefing.test.ts` covers `open_mission` — that what it creates is
indistinguishable from what the operator creates, that it adopts live agents and
that it rejects bad input —, the MCP announcement of the new tools and the
absence of the old ones from that announcement. `test/mission-status.test.ts` and
`test/hud-missions.shots.ts`, the panel.
`test/debrief.test.ts` covers the record: that an archived agent is still in it
with what the journal kept, that anything unmeasured is `null` and not `0`, that
the journal's `end` beats the live fleet when it exists and the live fleet fills
in while it runs, that the totals count how many agents are actually measured,
the landings, that an entry from another mission does not slip in, who the lead
is (assigned before by-squad, live before finished, CAPCOM never) and which paths
from what was reported can be opened. `test/hud-missions.shots.ts` photographs
the panel on the left and checks that a folded row takes one line, that the
disclosure opens and closes with the keyboard and shows the full title and
assignment, that the row opens the mission's window without duplicating it, that
a finished one opens on RESULTS with its empty states stated and not invented,
that CAPCOM's ribbon opens the same window, that closing it does not archive and
that below 900px the panel gets out of the way.
`test/wake.test.ts` covers the third alarm: that a mission with `pending_human`
warns at 4 minutes and not before, that answering it turns it off, that the
ladder spaces out without repeating on every tick, that several missions come out
in one message, that the operator finds out at the half hour just once and even
when there is no CAPCOM, that a hub restart does not repeat the reminder, and
that an archived or finished mission warns about nothing.
