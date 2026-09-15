# FORGE — coordinating self-improvements

FORGE is a specialized lead, one per approved proposal. It absorbs the
operational management that used to fall on the generic implementer or on
CAPCOM. CAPCOM keeps final review, security decisions, mission closure and
publication; approving the scope is still a human gesture in SELF-IMPROVEMENT.

## Architecture inspected, and the decision

- `shared/improve.ts`, `hub/improve.ts`: proposals, reviews, deduplication,
  clock, the reviewer's budget and project/runtime/model selection.
- `hub/server.ts`: `improve:send` comes from the authenticated console; the
  clock and the agent tools have no approval operation.
- `shared/missions.ts`, `hub/missions.ts`, `hub/wake.ts`: assignment, lineage,
  report reception, CAPCOM's debt, silence detection and notifying the lead.
- `collector/briefs.ts`, `collector/spawns.ts`: subordinate members, mailbox,
  growth limits and incident recovery.
- `ui/hud/improve.ts`, the mission and crew windows, and `DESIGN.md`: approval,
  link to the mission, conversation with the lead, status and navigation to the
  field.
- `hub/publisher.ts`: automatic publication when workers finish; FORGE and its
  members are excluded from that trigger.

No permanent daemon is introduced, no second queue, no new agent role and no
state machine. Every proposal has a `missionId`; every mission keeps
`active | completed | failed`, `squads`, `agentIds`, messages and dispatches.
The reserved `forge-` prefix identifies a squad's policy, its members included,
without migrating existing sessions or proposals. The old `auto-…` squads keep
their behavior.

## Flow and who owns what

| Step | Owner | Existing record or contract |
| --- | --- | --- |
| Proposal | Reviewer with no editing tools | Proposal with evidence or a hypothesis |
| Approval | Operator, IMPLEMENT button | `improve:send`, proposal `sent`, `missionId`, event in the conversation |
| Assignment | Hub and FORGE lead | Mission and squad linked before the spawn; lead with no CAPCOM parent |
| Tracking | FORGE | The squad's mailbox, agents, crew and dispatches |
| Blocks | FORGE; CAPCOM when its authority is not enough | Members' notices, recovery incidents, permissions and `missionStall` |
| Verification | FORGE over the consolidated work | Report with commands, results, files, coverage and limits |
| Report and closure | FORGE reports; CAPCOM reviews and decides | The lead's last message comes in as `agent`; CAPCOM uses `report_mission` |
| Reflection on the board | Hub, when the mission changes | `ImproveStore.syncMission`: the proposal moves to `completed` when the mission closes and to `archived` when it is archived, and comes back if the mission comes back |

FORGE decomposes by files and dependencies, delegates only bounded tasks, reads
the results before deciding, and inspects the work of members that finish
without writing anything. The existing footer provides `orca-tell`, `orca-read`
and quota recovery. Reports from members whose lead is alive are not published
individually into the mission. If the lead dies, the existing infrastructure
gives visibility back to CAPCOM; FORGE adds no autonomous retries.

The initial approval is recorded as a system event: it is a button press, not an
unanswered question addressed to CAPCOM. That avoids `missionDebt`'s operational
reminders. A result from the lead does create report debt. Later messages from
the human follow the existing routing to the live lead or, in its absence, to
CAPCOM.

## Safety boundaries

`dispatchForge` only integrates the existing console gate. It rejects an
already-sent proposal, a state that is not open, an invalid id or an
already-existing mission before creating any work. It reserves the link and the
squad without yielding execution before launching: two concurrent clicks do not
create two leads. An expired postponed proposal can be approved; a discarded one
requires REOPEN.

The lead and the descendants created by `orca-spawn` use
`permissionMode: auto` for routine execution within the approved scope. The
collector enforces the child's membership in the parent's squad. The publisher
ignores the termination of any `forge-…` agent; finishing does not publish, does
not merge and does not change the mission's final state. CAPCOM decides review
and publication through its usual channels. The general publication policy for
other squads remains.

The common policy in `shared/forge.ts` reaches the lead's initial brief and the
footer the collector adds to leads and members, even when the delegated task
omits the restrictions. It authorizes reads, local searches, typecheck, tests
and changes inside the assigned worktree/project without asking again.

Before a deletion, stopping processes or reloading services, a deploy, a
publication/push/merge, accessing or exposing secrets, external network, leaving
the worktree/project (including through symlinks), permission changes or an
ambiguous action, that action is paused and escalated. A script called test is
not routine if its effects cross these boundaries. The member uses `orca-tell`
toward its lead; the lead uses `orca-ask`, which reaches CAPCOM's existing
circuit (the human queue if CAPCOM is not available). The lead does not grant
itself that authority: it reports the action, the target, the effects and the
approval needed, and carries on with independent routine work while it waits.
Native escalations are neither auto-answered nor suppressed on account of
belonging to FORGE.

Authorization to execute is not authorization to publish. The
`publisher.finishedOwnWork` exclusion depends on the squad, not on
`permissionMode`; CAPCOM keeps review, closure and publication. The brief forbids
publishing, deploying, merging, reloading services, approving scope extensions,
skipping permissions and running destructive actions on its own initiative. It
requires isolation before editing, synthetic data and temporary stores, and
propagating these restrictions to members. They are operating instructions,
**not a new sandbox that proves any command harmless**. There is no command
classifier and no new execution barrier.
In the current implementation, Claude gets `--permission-mode auto`; Codex
translates `auto` into `--dangerously-bypass-approvals-and-sandbox`, except with
`ORCA_CODEX_APPROVALS=1`, which keeps `on-request` and `workspace-write`.
Because of that, the elevated boundaries depend on the agent following the
brief; there is no guarantee that the runtime will intercept a violation. That
global translation and the handling of pending native prompts are preserved. No
CAPCOM credentials or capabilities are added to FORGE.

## Failures and limits

- A launch that is rejected, or whose receipt is uncertain, leaves an active
  mission, a linked proposal and a readable cause. It is not resent
  automatically: CAPCOM has to inspect the squad and any late agents before
  recovering. Restarting the hub keeps the link; it does not relaunch FORGE.
- The proposal and mission stores save separately. There is no transaction
  across files: a disk failure between writes requires manual reconciliation. No
  atomicity is promised against a crash in that interval.
- The automatic worktree still depends on `ORCA_WORKTREES`. If it is off, FORGE
  has to create/verify isolation before editing. Project, runtime and model
  selection is still self-improvement's; no global FORGE budget is added. The
  agent/squad limits and controls remain in force.
- Verification is evidence reviewed by the lead and finally by CAPCOM, not a
  boolean inferred from `done`. The tests cover the contracts, not the quality
  of a model's future decisions, nor the real execution of every provider.
- There is no new UI: IMPLEMENT, OPEN MISSION, the crew, the conversation, the
  feed and the current states show the path. Real agents are not relabeled.

## Implementation files

- `src/hub/forge.ts`: approval received, validation, reservation, launch and a
  record of failures; `src/hub/server.ts` wires up the console gate and the feed.
- `src/shared/forge.ts`: squad identity; `src/shared/improve.ts`: stable name
  and specialized brief with the flow and its limits.
- `src/hub/improve.ts`: FORGE launch with auto permissions;
  `src/collector/spawns.ts`: the same posture for the children.
- `src/hub/publisher.ts`: exclusion from automatic publication on termination.
- `test/forge.test.ts`, `test/improve-agent.test.ts`: boundaries and
  integration.
- `DESIGN.md`, `docs/AUTOMEJORA.md` and this document: contract and walkthrough.

## Verification of the initial delivery (before the auto policy)

The new tests use temporary directories and a synthetic machine against an
ephemeral hub. They cover concurrent double sending, reservation before the ack,
mission collision, rejection of a discarded proposal, persistence of the
failure, a transport exception, CAPCOM's debt, member permissions and exclusion
from publication. The integration test walks console → spawn → lead → report
with no automatic closure. No real sessions were launched or modified in order
to test.

Results from 2026-09-10:

- `npm run typecheck`: clean, no diagnostics.
- `npm test -- forge`: 8/8; the first run turned up a fixture with no valid
  hypothesis, fixed before the final verification.
- `npm test -- --changed`: **846/846**, 66 suites. It includes FORGE
  integration, self-improvement, missions, wake, permissions, spawns and
  publisher, plus suites reached by pre-existing modifications in the shared
  tree.
- `git diff --check`: clean.
- The visual harness was not run: this delivery reuses the existing UI without
  modifying its implementation. The tests do not evaluate the texts visually.

The selector warned about missing suites for `DESIGN.md`, `docs/AUTOMEJORA.md`
and the pre-existing files unrelated to FORGE: `README.md`, `bin/orca.mjs`,
`docs/ENTREGA-VENTANAS-CANVAS-2026-09-09.md`, `src/ui/styles/hud.css`,
`src/ui/windows/kinds/misc.ts`, `docs/ENTREGA-APARCAR-OCIOSOS-2026-09-10.md` and
`docs/ENTREGA-VENTANAS-CONTROL-2026-09-10.md`. This document has no content
suite either. No code file added or modified by FORGE was left unreached by the
selected suites. Other people's changes were preserved; nothing was published,
deployed or run against a real session in order to test.

Coverage filters: `forge`, `improve`, `missions`, `mission-stall`, `wake`, `spawns`, `publisher`.
