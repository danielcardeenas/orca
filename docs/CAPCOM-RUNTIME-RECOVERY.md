# CAPCOM: runtime handoff and quota block

## Incident observed on 6 September 2026

Claude Code 2.1.263 left CAPCOM alive after an error at 05:59:55 UTC.
The JSONL contains `isApiErrorMessage: true`, `error: "rate_limit"` and
`apiErrorStatus: 429`. The hygiene request (disk, CPU, RAM and MCP access) was
not attended to. Watching only for process death does not detect this case.
Other workers shared the limit; some had finished. Relaunching them all, or
inferring that partial work was lost, is not warranted.

Before modifying any code, every available transcript from CAPCOM's Claude
project was copied, subagents included, along with the state of ~/.orca. The
manifest records 118 files, 42,591,925 bytes and their SHA-256 hashes, verified.
The private copy is in `.orca/backups/capcom-20260906T061705Z`; it is ignored by
git and contains sensitive state. `.orca/recovery/conversation.md` gathers 336
text messages. It is an auxiliary view: the full calls and results remain in the
original JSONL files. There is no promise to recover content the CLI never wrote,
nor to transfer Claude's internal context literally to Codex.

## Recovery as implemented

The Codex session is prepared first with the requested model (`gpt-6-astra`), the
whole available history, the handoff of obligations and read-only MCP queries.
Only after model and MCP are checked is the previous coordinator withdrawn. The
workers keep their processes and their changes.

`~/.orca/capcom/codex-recovery.json` explicitly selects an ALREADY prepared Codex
session, by `sessionId` (UUID) and `model`. CAPCOM adopts it if it is alive, or
runs `codex resume <sessionId>` inside tmux. It keeps the same identity,
authenticated MCP, the current instructions in AGENTS.md, workspace-write
sandbox, automatic review of shell approvals and pre-approved orca MCP tools,
just like the previous coordinator's authority.

An invalid configuration fails closed: a Claude id is never interpreted as a
Codex one, and there is never a silent fall back to Claude. The limit of five
restarts per hour is kept. This path is a prepared session recovery, not a
general selector nor an implementation of rotation between providers. Automatic
rotation to an empty session is disabled for this mode; it requires preparing
another handoff. There is no automatic fallback and no worker migration.

The Claude parser now classifies synthetic API error messages as `blocked` /
`block.kind: error`. It keeps the real model and metrics, shows the cause and only
clears the failure when a valid model response arrives. It does not infer a
recovery time from a 429: that can mean quota, a time window or some other limit.
Preventing sends to an exhausted provider and a durable retry queue are still
pending.

## Recommended design for the product

One logical CAPCOM per fleet, with selectable runtime/model and a single session
holding write authority. Providers are interchangeable executors; the
conversations, operator instructions, obligations and results belong to Orca. One
CAPCOM per model would fragment that authority and could repeat dispatches or
give contradictory instructions.

The dropdown should choose runtime + model and show its availability, the reason
for a block and the reset when it is known. A change within the same runtime can
be a model change; changing CLI requires an explicit handoff. For that handoff:
save a snapshot and the log positions, prepare the candidate, validate MCP and
the rebuilding of pending items, transfer an exclusive lease with a generation
number, and only then release the held messages. Reject writes from older
generations. If the preparation fails, keep the previous session and its backup;
do not activate a coordinator that did not pass the check.

The canonical log must be append-only and durable, GENERAL included, not only
tasks created with NEW TASK. The current limits (100 messages per task, 300 talk
blocks in memory) are presentation limits and must not define the archive's
retention. Keep the operational summary and the references to full evidence
separate. Record delivery and result ids, the states
`queued/delivered/acknowledged/completed`, and reconcile before retrying so as
not to repeat effects when the CLI blocks after running a tool.

Health needs two dimensions: process alive, and capacity to make progress.
Normalize the signals per provider/account/model: temporary limit, quota
exhausted, authentication, network, permissions and crash. A pause with no
progress does not on its own prove a lack of credits. A circuit breaker per
account/quota, bounded retries with backoff for temporary failures, a reset when
one exists and a grouped alert with the affected workers. Do not consume extra
credits or switch automatically to a provider with different billing without a
prior policy from the operator.

Official signals available:

- Claude Code: the `StopFailure` hook, with `error` as `rate_limit`,
  `billing_error`, `authentication_failed`, etc. On top of that, the incident
  already delivers a structured error in the installed version's transcript.
  [Hooks](https://code.claude.com/docs/en/hooks).
- Codex App Server: `account/rateLimits/read`, `account/rateLimits/updated`,
  `usedPercent`, `resetsAt` and credit details when available; turn errors with
  `UsageLimitExceeded`. The current TUI/JSONL integration does not by itself
  receive every App Server notification.
  [App Server](https://developers.openai.com/codex/app-server).

Validation: `test/capcom-recovery.test.ts` covers adoption, resuming in tmux,
invalid configuration, identity retention, the restart limit, the rotation guard
and the quota error observed. The real preparation verified access to
`gpt-6-astra`, reading of the 336 messages, the manifest and the MCP queries.

Activation result: session `01a07569-fdc3-75a1-88ed-8180be4b44b5`, Codex CLI
0.153.4, `gpt-6-astra`. The first interactive answer and a `briefing` query were
checked at 06:45 UTC. The initial directory trust dialog was accepted during
activation. `--approve-for-me` implies workspace-write and does not accept an
additional `--sandbox`; the argv test preserves this restriction.

Test results: four new recovery tests pass; the previous CAPCOM suites pass too
and TypeScript reports no errors. Overall suite: 577/580, with failures in
`orca archive --dry-run` and two watermark tests in `wake.test.ts`. The full log
stays in `.orca/recovery/tests.log`. Those fronts are still pending review within
earlier deliveries; the overall suite is not presented as green, nor the handoff
as a migration of the workers.

## The handoff indicator, and knowing it happened

GENERAL · TALK now shows a persistent `SESSION CHANGED` notice above the active
transcript: previous and new models, time, cause and buttons to open the previous
conversation and the checkpoint of pending items. It explains that the previous
archive is kept separately and has not been folded into the visible transcript.
EVENTS keeps the handoffs in chronological order, even with no live coordinator.
The handoff's informational messages are labelled ORCA, not YOU.

The collector publishes the handoff in `capcom:handoff` during resynchronization,
reading the recovery configuration. The extra metadata is `reason`
(`usage_limit`, `manual`, `context_rotation` or `unknown`), `previousRuntime`,
`previousModel`, `historyPath` and `checkpointPath`. Old configurations without a
`reason` must be annotated explicitly; the cause is not guessed.

The hub validates the owning machine and the destination CAPCOM session. It saves
the event before publishing it, in `~/.orca/hub/capcom-handoffs.jsonl`, with a
stable identity per session pair. Resends and reconnections do not create
duplicate events or notifications. This log is independent of the in-memory
transcript limits and of ceo.jsonl; the console's initial state recovers it at
startup.

When a new handoff is recorded, an informational explanation with the recovery
paths is delivered to CAPCOM on a best-effort basis. `briefing` always includes
the last three handoffs, even ones already consulted, so compacting or restarting
does not erase that accessible knowledge. Immediate delivery is best-effort; the
log and the MCP query are persistent. The notice does not mark tasks complete and
does not start worker retries.

Checked with tests for persistence, replay, metadata validation, the chat/feed/MCP
paths, and with a browser on desktop and mobile: buttons, keyboard, draft, EVENTS
and reload. The real Fable → gpt-6-astra event was published and CAPCOM confirmed
it had received the references.

## Changing model while keeping the session

The `CHANGE MODEL` control, above CAPCOM's message, queries the CLI's native menu
and offers its models with search. The active model is shown separately from the
requested one. The first query needs the CLI to be waiting for input; once the
catalogue is loaded a model can be chosen while it works. The change stays pending
in the collector until the turn ends, and it can be cancelled.

The session identifier is kept: there is no resume, no fork and no handoff prompt.
Codex 0.153.4 requires opening `/model`, selecting the row and confirming the
reasoning level its menu presents. `/model name` in this version is interpreted as
an ordinary message: the controller never uses it. Claude Code 2.1.263 uses `s` to
apply only to this session, without changing the global default. Codex follows the
preference-persistence semantics of its native selector.

Since Claude Code 2.1.268, if the current model has already answered in the
conversation (its cache is warm), `s` also opens `Switch model?` with `❯ 1. Yes,
switch to <model>` / `2. No, go back`. It happens with any destination, not only
with 1M; it does not happen if the current model has not answered yet. The
controller presses Enter exactly once, and only if the highlighted option names
the requested model; after that it waits for the usual confirmation. The real
screenshots are in `test/fixtures/model-control/`.

The controller validates the menu and its selected row, and waits for a fresh
confirmation from the CLI. It refuses to write over a terminal draft or an unknown
dialog. It does not interrupt pending permissions. If it does not recognize the
confirmation, it shows `Change unconfirmed` and offers to open the terminal; if a
dialog is open, the detail quotes its first line. It does not announce success and
does not retry the change automatically. The menu being available does not
guarantee the model has quota. Changing provider still requires the explicit
handoff.

`model-control-<sessionId>.json`, inside the CAPCOM directory, stores the
catalogue, the pending change and the last 50 events by atomic replacement.
`model-changes.jsonl` keeps the full log. A restart keeps the queue; a change
interrupted during the apply phase is left unconfirmed. The Codex recovery
configuration receives the confirmed model for future resumes of the same thread;
`handoffModel` keeps the original model of the historical handoff.

The state travels through the hub's agent sanitizer. GENERAL · TALK interleaves
the events as ORCA, EVENTS shows them chronologically and `briefing` includes
CAPCOM's three most recent changes in every query. No LLM response is needed to
change model, so the control works in the face of a quota error.

Verification: controller tests (queue, cancellation, restart, missing
confirmation, permissions, a Claude change scoped to the session only, and
2.1.268's `Switch model?` dialog against real screenshots:
`npm test -- model-control`); visual tests on desktop and mobile (selector,
errors, draft,
TALK/EVENTS); real changes in two isolated CLI sessions; querying the catalogue
through the live CAPCOM's hub. The real CAPCOM stays at
`01a07569-fdc3-75a1-88ed-8180be4b44b5`, `gpt-6-astra`.

## Per-provider selector and reviewable handoff

`CHANGE MODEL` groups models by runtime. The current group keeps the native
session change; the other offers `handoff · review first`. Claude shows the Opus,
Fable, Sonnet and Haiku aliases; Codex uses its local catalogue. Having the CLI
installed does not guarantee access to the model or quota: the preparation checks
the real response before the handoff.

Choosing another provider creates a backup, without yet invoking the destination
model: `~/.orca/capcom-handoffs/<uuid>/source.jsonl`, `conversation.md`,
`HANDOFF.md`, the previous recovery configuration and `manifest.json` with
SHA-256. The conversation includes the previously archived history and the current
transcript; the checkpoint includes tasks, escalations, messages and worker state.
The paths to the original files of earlier handoffs stay in the backed-up
configuration. REVIEW CONTEXT and REVIEW HISTORY allow reviewing the files before
CONFIRM HANDOFF. Cancelling keeps the backup and does not change CAPCOM.

Confirmation rejects a changed transcript or an altered backup. It sends the whole
conversation and checkpoint over stdin to a new session: Claude in print mode with
no tools and no MCP; Codex exec with user configuration ignored and a read-only
sandbox. No ORCA_* variables are passed to the preparation process. A successful
exit, a session id and a context confirmation with a nonce are all required. An
exhausted quota, failed authentication, excessive context or a missing
confirmation keeps the previous coordinator. The package limit is 4 MiB; it is not
truncated to force the handoff through. The model's own limits may be smaller.

The confirmed destination is resumed with the CAPCOM tools and its terminal is
checked before the previous pane is stopped. The persistent configuration includes
the runtime and the destination id; the name `codex-recovery.json` is kept for
compatibility, including for Claude destinations. During the preparation the
watchdog is suspended and the hub holds the messages addressed to the coordinator;
when it finishes, it releases them to the active CAPCOM. An interrupted process
does not retry the preparation automatically; the review is recovered from
`plan.json`. The selector keeps the plan id in the browser so the result can be
consulted after a reload.

TALK offers LOAD PREVIOUS CONVERSATION and LOAD EARLIER MESSAGES. It reads pages
of the archive through the collector, even when the hub is on another machine, and
presents them before the active stretch. The originals remain available in their
files. The transport envelopes of earlier handoffs are rendered only once, to
avoid duplicating the history recursively; they stay complete in the original
JSONL. The review files in the standard CAPCOM directory can also be opened with
the local hub's viewer.

Verified with a minimal real preparation on Claude Haiku and Codex GPT-6 Astra,
tests for integrity/failures/cutover/pagination and a desktop/mobile browser. The
real hub returns both catalogues and pages of the history. This implementation
does not perform a handoff of the real CAPCOM: the operator chooses and confirms
the destination.
