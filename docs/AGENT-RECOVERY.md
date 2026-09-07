# Agent recovery after usage limits

Hosted Claude Code and Codex workers can change model in their existing session or transfer to the other provider. Native subagents and sessions without an ORCA terminal cannot be independently migrated through this control; recover them through their parent or restore a hosted root first.

In an agent window, **CHANGE MODEL** lists the native provider’s models and installed alternatives. Same-provider changes use the CLI’s native model selector and wait for confirmation. A provider change creates an exact transcript backup plus a readable conversation and pending-work checkpoint before presenting **CONFIRM HANDOFF**. The operator can instead choose **WAIT**, a reason and a review time.

For a quota-blocked worker, confirming a model change or handoff also records a recovery decision and sends one continuation after success. Ordinary model changes apply to subsequent turns. No task is marked complete by recovery itself.

## Context and work ownership

Worker backups live under `~/.orca/worker-recovery/handoffs/<id>/`; model selection state lives under `~/.orca/worker-recovery/models/`. CAPCOM keeps its own control directory. Exact source bytes, readable history, checkpoint and checksums are preserved. The checkpoint includes the worker’s mission, project, directory/worktree, supervisor, squad, lead role, assigned task records and relevant traffic. Earlier transferred history is included on subsequent handoffs.

The destination prepares that context without executing the pending task. After it acknowledges the context, ORCA resumes the exact prepared native session in the worker’s directory and verifies its prompt. Only then is the original terminal stopped. A preparation, authentication, quota, integrity or setup failure retains the source. A staged activation record allows restart reconciliation: if the source survived, discard the idle candidate; if the source stopped, finish adopting the surviving destination.

The continuation retains mission, worktree, squad and lead role. ORCA-spawned children are reparented, task bindings include both transcript segments, and commands delivering messages to the old session follow its continuation. Native subagents remain associated with their original native parent; their transcripts are historical evidence, not independent resumable workers. Agent budgets count both conversation segments and keep the original ceilings. The earlier segment is shown as finished with an **OPEN CONTINUED AGENT** link. The destination can **LOAD PREVIOUS CONVERSATION** in chat; raw archives remain available separately.

Preparation refuses incomplete transcripts, changed source bytes and context packages over 4 MiB. A provider may reject a smaller package because of its own context limit. No automatic truncation occurs. Local archive-file review uses the hub’s permitted recovery directory; remote collectors relay chat history, but opening their raw files still requires access to that filesystem.

## Supervisory decisions

MCP tools:

- `inspect_recovery {agent_id, models?}` returns the observed quota incident, prior decision, mission, supervisor, squad, budget and related provider failures. `models: true` also inspects native and installed-provider catalogs.
- `recover_agent {agent_id, incident, action, reason, supervisor_id?, review_at?, runtime?, model?}` chooses `wait`, `model`, `handoff` or `retry`. `incident` must match the latest inspection. `review_at` is UTC epoch milliseconds within the next seven days.

An explicitly named supervisor must be an ancestor, the worker’s squad lead in the same project, or CAPCOM. Omitting it from the MCP tool selects the current CAPCOM. MCP remains the existing trusted fleet-command surface; this scope check is not a separate authentication mechanism.

Workers without MCP can use the installed `orca-recover` helper, or `node /path/to/orca/bin/orca-recover.mjs`:

```sh
orca-recover inspect 24 --models
orca-recover decide 24 decision.json
```

Existing CLI sessions may cache their MCP tool catalog; reconnect the ORCA MCP server or use the CLI helper to access the new tools. `orca-install` includes the helper for future installations.

The decision file contains the same fields as `recover_agent`, including `supervisor_id` (or the helper obtains it from the CLI’s session environment). The helper reads the hub credential locally without printing it. `ORCA_HUB_HTTP` selects the hub URL and `ORCA_TOKEN` can supply its credential; defaults are localhost:4479 and the token under `ORCA_HOME`/`~/.orca`.

The supervisor chooses based on the task’s difficulty, urgency, dependencies, remaining work budget and observed failures. Prefer a suitable same-provider model to preserve the native session; choose another provider when appropriate; wait when credit may recover before the work is needed or no suitable alternative is available. Installed models do not prove remaining subscription credit. A review time is not an inferred quota-reset time. Recovery cannot bypass an exhausted ORCA work budget.

Decisions and phase changes are persisted in the hub’s `recovery-state.json` and append-only `recovery-decisions.jsonl`, and appear in the feed. A model change must be confirmed before continuing. A handoff must be activated. `retry` sends one continuation. Ambiguous sends after restart are not repeated automatically. Repeating an identical completed/failed attempt for the same incident is rejected; a new observed incident or a different decision is required.

## Automatic review

Use **Settings → Recovery → Automatic review** to enable automatic discovery and notification for the whole fleet. Changes apply immediately and persist in the hub’s `recovery-settings.json`. A saved setting takes precedence over `ORCA_RECOVERY_AUTO`; without a saved setting, `ORCA_RECOVERY_AUTO=1` enables it and the default is off. Turning it off stops new automatic discovery, while recorded decisions and scheduled reviews continue. This flag asks a supervisor to decide; it does not impose a model fallback order.

The coordinator groups current hosted quota blockers into one notification per available supervisor, including workers already blocked when the hub starts. It prefers their available parent/lead, then CAPCOM. If the lead is also blocked, CAPCOM gets the group. An unanswered notice can escalate to CAPCOM after five minutes. If no supervisor is available, the block remains visible and the next sweep reevaluates availability. Deduplication survives hub restarts.

Explicitly chosen waits receive their scheduled review even with automatic discovery off. Review does not retry the exhausted model; the supervisor must make a fresh decision. If the quota block has already cleared, no review notification is needed.

## Validation

Automated recovery tests cover quota classification, supervisory scope, stale/duplicate decisions, native confirmation, failed preparation, wait persistence and deduplication, lead-to-CAPCOM escalation, work/task/budget continuity, stop failure and interrupted activation reconciliation. Desktop/mobile fixtures verify the wait inputs, review before commit, continuation link and draft preservation.

A real isolated Claude Haiku → Codex GPT-6 Astra handoff on 2026-09-06 verified exact recall of a synthetic pending code after activation. Its artifacts are under `.orca/recovery/worker-native/1d9d2595-527f-47e8-950e-7065f51e556e/`. This exposed and fixed a stale `model: loading` banner in tmux scrollback. The production workers were not switched during this test. A real reverse worker handoff and recovery of an entire live squad have not yet been exercised.
