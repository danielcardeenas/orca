# New CAPCOM: clean context or continuity

Implemented for `task_mtpbw5elzf26ioz1` / squad `task-03`. This delivery does not trigger a real reset, does not restart services and does not include a commit, push or deploy.

## The real button and commands

In the command window, next to **CHANGE MODEL**, **New CAPCOM** appears. It opens a choice with explicit scope and two actions:

| Action | Initial context | Activity on startup |
| --- | --- | --- |
| **Clean context** | CAPCOM's basic instructions and the technical startup check. No summary of pending items, no conversation, no history and no hub rules text. | Waits for instructions or new messages. It does not run `briefing`/`recall`, does not replay backlog and does not receive the heartbeat that orders it to recover pending items. |
| **With continuity** | A short checkpoint from the hub: open tasks, pending questions, agent references and persistent rules. Full history archived on disk, without putting it into the context. | Recovers the situation with `briefing` and looks up specific details when needed. |

Commands from the ORCA bar:

```text
/capcom-new
/capcom-new clean
/capcom-new continuity
```

With no argument it opens the choice; `clean` and `continuity` request the given mode directly. An unknown argument is rejected. `/clear` keeps its deselect behavior. No `/new` or `/clear` commands are sent to the CLI. There was no other `/capcom-new` entry in the command registry.

The internal protocol is `{ k: 'capcom:new', agentId, mode: 'clean' | 'continuity' }`. The hub generates the continuity checkpoint; it does not trust a checkpoint supplied by the console. State uses `handoff:status` and a `planId`, including after reloading the window.

## Three paths, and which one is taken

Since 2026-09-07, New CAPCOM picks based on what actually changes:

| What changes | How |
| --- | --- |
| Context only | the CLI's own `/clear` |
| Context and model, same runtime | native model selector, then `/clear` |
| Runtime | a session prepared separately, verified before retiring the previous one |

Mode and destination are separate axes: **"clean" means the same thing when
crossing providers** — a new session, with no conversation and no checkpoint,
only the brief — and the only thing that changes is the mechanism. It did not
use to be like that: asking for a new context with another provider fell into
`Fresh CAPCOM must retain its runtime and model`, and the only cross-provider
path left carried the entire conversation, which is the opposite of what the
button you pressed said.

The console offers both paths in the same list and says which is which —
`clears in place` versus `prepares and verifies · slower` — a CLI that is not
installed appears disabled, and choosing a model from another provider turns
the buttons into `Clean context · prepare` with a line explaining that a second
CLI is started, that it takes up to two minutes and that it can fail on quota
or authentication while keeping the current session. It is the same action with
two very different risk profiles, and hiding that behind the same button would
be misleading.

`/clear` was not a new idea but a pending check: in Codex 0.153.4 it is
advertised as "clear the terminal and start a new chat" and, when run, it
writes down "To continue this session, run codex resume … \<uuid\>" and opens a
thread with its own uuid and file. Verified with two messages in a real Codex:
the previous rollout keeps the first one and does not receive the second. The
session prepared by `codex exec` achieved exactly that same thing the long way
round.

What that detour bought, and is not needed here, was knowing the identifier in
advance. With `/clear` the id is chosen by the CLI and it tells nobody, so it
is discovered: you wait for the new transcript from the same directory, created
after the cutoff, and when it appears the pane is renamed to `orca-<uuid>`. It
is the same path a Codex worker already walked, since it cannot take its id in
advance either.

A thread with no turns is not written to disk, so the rotation opens with a
message: in continuity the hub's checkpoint, and in clean mode a line that only
asks for a receipt and explicitly forbids tools, `briefing`, `recall` and
history. That exchange is everything a "clean" context inherits — just as it
used to inherit the preparation receipt.

`/clear` cannot be rehearsed: when it returns, the previous context is already
gone. There is no "keep the original" because there are no two sessions to
choose between, only a process that has already been emptied. What is kept is
everything else — the process is still alive, the previous transcript is still
in the CLI's directory with its uuid, and the hub's registry is untouched — and
that is why a runtime change keeps the prepared path: there you really do start
another binary, and verifying before retiring is worth what it costs.
`ORCA_CAPCOM_PREPARED_RESET=1` brings the long path back for the same runtime
too, without the model choice.

Adopting the new thread is not just moving the role in memory: `ensure` reads
`codex-recovery.json` first — a prepared recovery outweighs a memory — and its
`sessionId` wins over `session.json`. Without writing it down there, the
watchdog handed the role back to the already-emptied thread on its next pass,
and the hub said "0 UNDER COMMAND" with the process running right in front of
it. `sessionId`, `contextMode`, `cutoffAt` and `previousSessionId` are updated;
runtime, model and `cwd` do not change, because it is the same process.

The model is changed **before** emptying, with the native selector: the
replacement must be born with the one that was asked for, and while the old
context is still standing a model with no quota fails without anything having
been touched.

## A model from the same provider, without waiting for the idle moment

Since 2026-09-10. A session's native catalog (`choices`) only fills up by
typing `/model` into an idle CLI with a clean prompt, and a CAPCOM in command
is almost never at that moment when the operator opens the selector. With an
empty catalog, **CHANGE MODEL** showed the Claude models disabled with "session
catalog not ready · retry" and **New CAPCOM** did not show them at all, while
crossing to Codex did work because that path reads the provider catalog
(`handoff:models`), which needs no session. Going from Opus to Sonnet was, in
practice, impossible.

Now both selectors offer the same provider's models from that same catalog, as
a real option:

| Where | Confirmed by the menu | Only in the provider catalog |
| --- | --- | --- |
| CHANGE MODEL | `same session` | `same session · CLI verifies when idle` |
| New CAPCOM | `clears in place` | `clears in place · CLI verifies` |

What does not change is the real protection. `model:set` queues — as always —
until the session is idle, and on applying it opens the CLI's real menu: if the
model is not there, it closes the menu without pressing anything and ends up
`failed` with "This CLI does not offer X in its model menu. No model was
changed.". The collector accepts in `request` whatever the installed provider's
catalog offers for that runtime (`ModelController` receives `catalog`), and
still rejects up front what nobody knows. In New CAPCOM the order is the same
as before: `list`, `request`, menu confirmed, and only then `/clear`; a model
the menu does not offer leaves the context untouched. The hub does not check
the model against any catalog: it passes it to the collector as is.

The messages for the two paths are still separate: staying with the provider is
"clears in place" (seconds, same session) and crossing is "prepares and
verifies · slower" (new process, up to two minutes). The only new thing is the
caveat that the CLI verifies the model the session had not yet confirmed.

Coverage: `npm test -- model-control capcom-new capcom-new-hub`, `npx tsx
test/capcom-new.visual.ts` (busy session with empty `choices`: the same
runtime's model comes from the catalog and travels in `capcom:new`), `npx tsx
test/model-catalog.visual.ts` (empty native catalog: the own model is requested
with `model:set` instead of being disabled). This last harness now brings up
its own Vite, like New CAPCOM's.

## What it keeps and what it changes

The **effective runtime and model** are kept, Codex included. There is no fallback to Claude or to another model. The action requires a CAPCOM that is hosted, alive, with a known transcript and model, and with no turn or model change in progress. It also accepts an error/quota block; preparation can fail on the same model's quota and keeps the original.

The session UUID is changed through a new prepared startup and a `resume` of **that new UUID** to open its interactive terminal. The old conversation is not resumed. The preparation receipt is part of the minimal technical context; "clean" does not mean a session with no role instructions or no MCP configuration.

Project files, workers, tasks, persisted rules, original transcripts and hub conversations are not deleted. Retiring tasks is a separate decision and is requested separately, with ARCHIVE or `/tasks` ([TASK-RETENTION.md](TASK-RETENTION.md)): the hub's registry is what makes the session disposable, and deleting it as a side effect of a context reset would be exactly the opposite. Clean mode does not load those rules automatically: the operator can ask to recover historical information afterwards. The clean policy carries on across a resume or a compaction and until another mode change; an explicit instruction can ask for specific historical information.

Each action creates `<capcom-dir>/handoffs/<planId>/`:

- `source.jsonl`: the previous transcript, hard-linked when the filesystem allows it and copied when not. The same bytes under another name: it survives the CLI pruning its sessions directory, without duplicating tens of megabytes on every attempt.
- `conversation.md`: accumulated history, readable from TALK.
- `manifest.json`: hashes of the transcript, history and notes.
- `HANDOFF.md`: the continuity checkpoint or the record of the clean reset, with no pending items in the second case.
- Copies of the previous configuration/control, when they exist.
- `runtime/`: the prepared session's own directory, with a `CLAUDE.md` and `AGENTS.md` specific to the mode.
- `preparation.jsonl`, `preparation.stderr`, `destination-checkpoint.md` and `plan.json`: evidence and result.

When a handoff is prepared, the previous archives are pruned: from each one that
is neither the active one — the one `codex-recovery.json` names — nor the one
being prepared, `source.jsonl` and `conversation.md` are removed, leaving a
`PRUNED.md` that says so. The plan, the checkpoint, the manifest hashes, the
preparation receipt and the stuck destination's screen are kept: they are what
you open to understand a failure. The conversation they contained is still in
the session that has it and in the CLI's own transcript. The pruning is
best-effort and never makes a handoff fail.

MCP credentials are added to the execution directory only when the destination terminal is opened, after preparing and verifying the receipt. Preparation strips `ORCA_*` variables; Claude has no tools/MCP and Codex uses the existing `exec --ignore-user-config ... -s read-only` path. A `runtime/` directory referenced by the active recovery must not be deleted.

That `runtime/` directory did not exist a second earlier, so the destination CLI
would ask to confirm trusting it and would sit waiting in a pane nobody is
looking at: verification burns the full two minutes and the original CAPCOM is
kept. Before opening the terminal, the folder's trust is registered where each
CLI stores it — `~/.claude.json` for Claude, `[projects."<dir>"] trust_level =
"trusted"` in `~/.codex/config.toml` for Codex — without touching a decision
already made for that folder or an unreadable file; if it cannot be written, a
warning is left in the feed. Each handoff therefore adds a project entry to
Codex's config. When verification fails anyway, the destination's last screen is
saved in `resume-screen.txt` inside the archive.

Before retiring the previous one, it is checked that the plan still describes
it: same runtime and same effective model as when it was prepared
(`fromRuntime`/`fromModel`). The check is made against the **origin**, not
against the destination, and it applies to every handoff. Comparing with the
destination only worked because a new context forced the model to be kept —
origin and destination coincided — and it would have rejected exactly the
rotation that does change it; and leaving it out of provider handoffs meant that
an original that changed model halfway through preparation went unnoticed. A
plan from before these fields is accepted: there is nothing to compare against,
and the transcript, the hashes and the state are still required just the same.

The continuity checkpoint lists up to 16 items per section, trims descriptive lines to 240 characters and preserves identifiers and lookup paths. The prepared prompt has a 48 KiB limit. The archived history does not share that context limit. If the transcript changes during preparation or is left incomplete mid-write, the handoff is rejected and the original is kept.

## Coordination and messages

The context cutoff is identified by `cutoffAt` in the plan/event. ORCA announces the hold before preparing the destination. While it lasts:

1. The watchdog and automatic rotation do not intervene. Incompatible commands and input to the original terminal are blocked; TALK keeps accepting messages.
2. The preparation is not given permission to dispatch work. It must return a different UUID and the requested receipt; clean mode requires only that receipt.
3. The destination is opened without a new activation turn. ORCA verifies that its terminal has reached an idle prompt; it has up to two minutes for that.
4. Only after verifying the destination is the previous pane stopped and the recovery configuration published by rename with the new UUID. That UUID is adopted into the lineage and the snapshot is published.
5. The queue is released to the confirmed destination. If its transcript is not visible yet, it stays held. A slow preparation does not drop the mail on a timeout.

If preparation, authentication/quota, the receipt, startup, capture or readiness fails, the previous one is not stopped. If stopping the previous one fails, the destination is cancelled and the previous authority remains. Duplicate requests for the same mode during preparation reuse the plan; another mode or a second commit are rejected.

New TALK messages, tasks and deliveries sent directly to CAPCOM are held. In clean mode, a new instruction inside a task carries its identifier and new text, without attaching the previous conversation. The same applies to new worker results. Old questions, warnings from workers before the cutoff and historical quota incidents are still stored, but they are not injected again automatically; new questions/incidents still arrive. The handoff event is shown and persisted in the UI without being sent as a prompt to the clean CAPCOM.

Activation keeps a single CAPCOM with authority. During verification there can be two live CLI processes: the original and the prepared destination, with no active turn and no CAPCOM role yet. Do not write directly into the destination's tmux or use CLI commands to switch sessions outside ORCA.

## Who is in command, in a single file

Since 2026-09-07, `<capcom-dir>/capcom.json`. Before, that fact lived split up:
`session.json` stored the adopted session and `codex-recovery.json` the session
with its runtime, its model and its cwd — and it **won** over the first, with no
written rule saying which one to update. A `/clear` updated the one that was not
in charge and the watchdog handed command back to the already-emptied thread: "0
UNDER COMMAND" with the process running right in front of it. Five writers
touched that fact — adoption, handoff, reset, model change, startup — and it was
enough for one of them to leave the authoritative file behind.

Now it is one file, one atomic write, and `recovery()` and the adopted session
are two views of the same read, so they cannot disagree. The pane's name is
derived; the role in `lineage.json` and the hub's `role:'capcom'` are
publications of that fact, not copies with a vote.

Migration happens automatically on read: if there is no `capcom.json` but the
previous ones are there, they are merged giving priority to the recovery — which
is the one that had it — and written once. It deletes nothing: the old files are
still the evidence of a handoff, and an older collector that starts up again
finds its own. The bill for that is that **going back to an earlier version
after a session change requires fixing things by hand**: the old files are no
longer updated.

An identity with no session, with an unknown runtime, or that declares a
prepared model alongside an id that is not a hosted session is rejected instead
of guessed — resuming that would launch a CLI over a conversation that does not
exist. An undeclared model is accepted as `default`, which is what a `--bg`
always was, and `recovery()` reads it as "nothing to resume".

## The notices, collapsed

A handoff leaves its record — "SESSION CHANGED", with links to the previous
conversation and to the notes — and the handoff itself leaves its own, with the
plan's state. They are useful once and reference afterwards, but expanded the
two of them took up two thirds of the window's height, and the live conversation
was left in a four-line strip; the handoff one, on top of that, could not be
closed by any means, so that clipping was permanent.

Now a notice's normal state is one line: title, summary and time. It opens with
a click and is dismissed with the ×, and both things are remembered in this
browser by the notice's id — dismissing one handoff's record does not hide the
next one's, which is when you need to read it. The notice is still in the hub:
another console will see it.

The plan's record opens on its own while there is something to decide or
something under way — a review pending confirmation, a preparation, a failure
that explains what was kept — and collapses as soon as it is the receipt for
something that went well. The action that follows a completed handoff, going to
the agent that continues, stays outside the collapse: the text is hidden, not
what you need to be able to press.

## Operational activation still pending

1. Integrate these changes and put them into service through the usual procedure, in an authorized window. This task did not carry out that step.
2. Open the command window, check provider/model and wait for CAPCOM to finish its turn. The button explains when it is unavailable.
3. Choose **New CAPCOM → Clean context / With continuity**, or use the equivalent command.
4. Wait for the plan's result. On failure, review the detail and the archive's evidence before retrying; do not type `/new` into a terminal.
5. Verify the new UUID, provider/model and a single CAPCOM role. In clean mode it should be left waiting, except for new messages received during the change. In continuity it should recover pending items. Check delivery of the held messages.

Local authority changes are persistent; they do not constitute a distributed transaction with exactly-once delivery guarantees against a simultaneous failure of the hub, collector and filesystem. The router's callback queue is still hub memory, as before: a hub restart during the transition requires reconciling the messages kept in tasks/conversation with the handoff state; do not do blind resends. The interrupted state consults the recovery configuration to recognize an already-persisted activation, without launching another runtime. No power loss was rehearsed here and no real operator session was activated.

## Verification

```sh
npm run typecheck
npm test
npm test -- capcom
npm test -- capcom-identity
npm test -- capcom-reset
npm test -- wake
npm test -- provider-handoff
npm test -- worker-recovery
node --import tsx test/capcom-new.visual.ts
node --import tsx test/capcom-handoff.visual.ts
node --import tsx test/model-catalog.visual.ts
```

The visual test creates its own Vite server without the project's config/proxy and without connecting to the real hub. It saves screenshots to `test/shots/capcom-new-{desktop,mobile}.png` and checks the button, both modes/commands, scope, model, draft, failure/retry and overflow.

The new runtime tests use simulated CLI processes with temporary HOME/config/cwd, and injected terminals for readiness/failure/timeout. The hub tests use real WebSockets against a temporary hub. They are integration checks of the controller and the process boundaries, not a certification of quota/authentication nor a run against production Claude/Codex. The general suite also exercises tmux in its test environment. There was no rotation, reset or prompt sent to the real CAPCOM.
