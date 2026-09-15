# FORGE · routine and elevated permissions

Mission: `forge-permissions-01`.

FORGE launches its lead and descendants with `permissionMode: auto`. The
common policy authorizes reads, local searches, typecheck, tests, and
editing within the assigned worktree/project and scope. Before elevated or
ambiguous actions, it pauses the action and asks CAPCOM for review:
deletion, stopping processes, reloading services, deploy/publish/push/merge,
secrets, external network access, leaving the project (symlinks included),
or changing permissions.

Spawn, runtime argv, briefs, dispatchForge, publisher, and the escalation
channel were all inspected before editing. An independent read-only review
confirmed the contracts and the limits of the auto stance.

## Consolidated changes

- `src/shared/forge.ts`: the common execution policy, independent of the
  squad identification publisher uses.
- `src/shared/improve.ts`: the lead's initial brief carries the routine
  policy and elevated escalation; it replaces the previous instruction to
  use manual mode.
- `src/hub/improve.ts`: the FORGE lead runs in auto; it keeps this tree's
  previous stance for implementers outside FORGE.
- `src/collector/spawns.ts`: children run in auto; squad, parent, limit, and
  member-status inheritance is preserved.
- `src/collector/briefs.ts`: the collector adds the policy to FORGE leads and
  members even when the task brief does not include it.
- `test/forge.test.ts`, `test/improve-agent.test.ts`: permission boundaries,
  inheritance across children/grandchildren, brief propagation, publishing,
  and final control.
- `docs/FORGE.md`, `docs/AUTOMEJORA.md`: contract and limits updated.

A member escalates to the lead through `orca-tell`; the lead uses
`orca-ask` for CAPCOM. If CAPCOM is unavailable, the existing fallback to
the human queue applies. The lead cannot grant itself elevated authority. It
can keep doing independent work while it waits. No other channel is added,
and native prompts are not answered automatically.

The existing exclusion in `publisher.finishedOwnWork` still keys off
`forge-…`, independent of permissions: neither a finished lead nor a
finished member triggers publication. The report does not automatically
close the mission. CAPCOM keeps final review, closing, and publication.

## Verification

- `npm test -- forge improve-agent spawns permissions publisher`: **50/50**.
  Covers squad inheritance against an attempt to pick another one, auto
  grandchildren, the policy being injected without depending on the task,
  every elevated category, ordinary agents without that policy, publisher
  excluding FORGE, and the mission staying active after the lead's report.
- `npm run typecheck`: the first run was blocked by TS2322 in
  `test/capcom-feedback.fixture.ts:58`, an unrelated concurrent change: a
  `pane` string where a boolean was expected. Flagged to that project
  without editing its fixture. After their concurrent fix, the second run
  passed with no diagnostics.
- `npm test -- --changed`: **873/873**, 69 suites selected across 57 files
  from the shared tree, including changes unrelated to this mission.
- `git diff --check`: clean at consolidation time; the concurrent whitespace
  in `src/ui/windows/kinds/ceo.ts` flagged at first had already been fixed.

## Risks and limits

This is an operating policy, not a shell classifier or a sandbox. A
command's name does not vouch for its effects: a test that deletes data,
stops processes, or uses external network access must also escalate. The
text tests check that the instruction is delivered; they do not prove a
model's obedience.

In the current launcher, Codex auto disables approvals and sandbox by
default; `ORCA_CODEX_APPROVALS=1` restores `on-request`/`workspace-write`.
Claude gets its native auto mode. That translation does not change in this
mission. The publisher exclusion is an actual control in code, but it does
not stop an agent that breaks the brief from invoking publication through
the shell.

Preexisting, concurrent changes in the shared tree were preserved. No
publications, deploys, destructive actions, or tests against real sessions
were run. The fixtures use synthetic agents and temporary stores. There are
no visual changes; `npm run visual` was not run. The selector warned of
missing suites for 17 files in the shared tree: `DESIGN.md`, `README.md`,
`bin/orca.mjs`, `docs/AUTOMEJORA.md`,
`docs/ENTREGA-VENTANAS-CANVAS-2026-09-09.md`, `src/ui/hud/command.ts`,
`src/ui/main.ts`, `src/ui/styles/hud.css`, `src/ui/styles/window.css`,
`src/ui/windows/kinds/agent.ts`, `src/ui/windows/kinds/misc.ts`,
`docs/ENTREGA-AGENT-CONTEXT-STOP-2026-09-10.md`,
`docs/ENTREGA-APARCAR-OCIOSOS-2026-09-10.md`,
`docs/ENTREGA-FORGE-CANVAS-2026-09-10.md`,
`docs/ENTREGA-VENTANAS-CONTROL-2026-09-10.md`, `docs/FORGE.md`, and
`test/capcom-feedback.fixture.ts`. This document, created during the run,
also has no content suite. All the code this mission modified is covered by
the selected suites.

Coverage filters: `forge`, `improve-agent`, `spawns`, `permissions`, `publisher`, `squads`, `commands`, `codex`.
