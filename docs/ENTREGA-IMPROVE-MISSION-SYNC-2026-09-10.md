# SELF-IMPROVEMENT · the mission returns its status to the proposal

Mission: `mission-07`.

## The bug, with evidence

Two proposals on the board were still stuck at `sent` when their mission was
already `completed` and archived as of 09:30Z on 2026-09-10:

| Proposal | Mission | Mission said | Proposal said |
| --- | --- | --- | --- |
| `imp_mtsckduj0xbfxnkh` (`console-usage-instrumentation`) | `mission_mtv3t4fi4vnpin1p` | `completed` + `archivedAt` | `sent`, no notes |
| `imp_mttxv0wedohmhlen` (`active-mission-without-working-agent`) | `mission_mttxzjrueupaaqnu` | `completed` + `archivedAt` | `sent`, no notes |

Cause: the `missionId` link was one-way. `dispatchForge` wrote `act: 'sent'`
and nothing afterward listened for the `MissionStore`'s `changed` event.
Closing (CAPCOM, `update_mission`/`report_mission`) and archiving (console,
`mission:archive`) changed the mission and nothing else.

## What changes

- `src/shared/improve.ts`: `ImproveStatus` gains `completed` and `archived`;
  `MISSION_STATUSES`; `linkedStatus(mission)` is the single rule (archived
  beats completed; `failed` stays `sent`); `sortProposals` sinks completed
  ones and puts archived ones at the very end.
- `src/hub/improve.ts`: `ImproveStore.syncMission` (per mission, in both
  directions, with a `system` note in the thread) and `syncMissions` (a
  startup sweep, a single write). `reopen` is now refused for any proposal
  with a mission, not just `sent` ones. Pruning and `improveCounts` know
  about the new statuses.
- `src/hub/server.ts`: the `MissionStore`'s `changed` event calls
  `syncMission` (except on purge); on startup, `syncMissions(missions.all())`
  runs with a log line if it moved anything.
- `src/agents/tools-improve.ts`: `list_improvements` documents the new
  statuses in `status`.
- `src/ui/hud/improve.ts` and `src/ui/styles/improve.css`: a completed row
  reads `DONE · <when>` and dims like closed ones; the mission mark (lime
  bar) moves to the `is-mission` class, which now covers any proposal with a
  `missionId` — sent or completed — so the "turned into a mission" highlight
  does not change. Archived ones are not shown, not even behind the fold.

`report_improvements`, `dispatchForge`, and the criterion for which proposals
carry the mission mark are untouched.

## Verification

- `npm run typecheck`: clean.
- `npm test -- --changed`: 956/956. The `no suite covers this` warning lists
  files from other missions in the tree and, from this one,
  `src/ui/hud/improve.ts` and `improve.css`, which the visual harness below
  covers.
- `npm test -- improve`: 96/96 (`AUTOMEJORA`) and 14/14 (`AUTOMEJORA · hub`),
  with new tests: sent → completed → archived → completed → sent with its
  four notes, persisted; a startup sweep that only moves the linked one and
  respects a purged mission; the rule and its ordering; over the socket,
  closing and archiving the mission reach the proposal and get pushed to the
  console; and a hub that starts up with a mission already closed and
  archived on disk archives its proposal.
- `npx tsx test/hud-improve.shots.ts`: passes, with new fixtures (completed
  and archived) and assertions for `DONE`, `is-mission`, OPEN MISSION with
  neither IMPLEMENT nor REOPEN, and the archived one absent when expanded.
- The two real cases: on a copy of `~/.orca/hub`, `syncMissions` leaves them
  at `archived` with the note `Mission archived: it leaves the board with
  it.` and a second sweep moves nothing. The operator's hub restarted at
  17:52:33 (not because of this mission) already running this code, and its
  startup sweep left the two real proposals at `archived` at 17:52:34 with
  that same note; this matches the missions panel, where neither one is
  visible.

Out of scope: a `failed` mission does not change the proposal (it stays
`sent`), because the assignment was to complete and archive; it's a
one-line change in `linkedStatus` if wanted.

Coverage filters: `improve`, `forge`, `missions`.
