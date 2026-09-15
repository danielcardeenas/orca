# Codex permissions, and the agent nobody saw stopped — 2026-09-07

A Codex worker with the Playwright MCP asks for permission several times in a
row. ORCA did not flag it, the console painted it `working`, and the operator
found out on his own. This delivery attacks both halves of the problem: why it
was not visible, and why it asked so much.

## Why it was not visible

The good detection is from the screen: `readScreens()` captures every live pane
on every liveness poll and passes what it captured through `promptOn()`. It
recognized a Codex MCP dialog **only if there was an `action:` line among its
arguments**.

That requirement came from the only tool it was measured against, `browser_tabs`,
which happens to have a parameter called `action`. No other one does:
`browser_navigate` names `url`, `browser_click` names `element` and `ref`,
`browser_snapshot` takes no arguments. All three were discarded, and discarding
here is not failing safe: it is going blind in silence.

The fallback did not cover it either: `stuckTool` requires a tool open for
`PERMISSION_SUSPECT_MS` (90 s) and `gatedPending` always returns `null` on Codex.
Ninety seconds of blindness per permission, when it fired at all.

## What was done

**Detecting and answering stop being the same thing.** They were the same: if the
parse failed, there was no block. Now there are three layers, and only the first
one reads a dialog:

**1. `promptOn` — the dialog, so that it can be answered.** Knowing which key to
send requires understanding the menu; there is no way around it, and only this
layer needs it. Once recognized, the escalation brings `allow | deny`. It no
longer demands any field from an MCP dialog: it is identified by the header, the
exact option labels and the footer, and field names travel in the summary while
values never do.

**2. `titleSignal` — what the CLI declares about itself.** Codex writes its
terminal title with OSC, and one of the elements it paints —`activity`, in
`[tui].terminal_title`— is literally "spinner while working, action-required
message while blocked". Measured on 2026-09-07 against 0.153.4 in an isolated
tmux, reading `#{pane_title}`:

```
Ready | proyecto                    end of turn, nothing pending
⠸ Working | proyecto                turn open
[ ! ] Action Required | proyecto    waiting for an answer   (blinks to `[ . ]`)
```

It is not a deduction by ORCA about a screen: it is the CLI declaring its state,
and while `idle` it does not say it, so there is no false positive from the end
of a turn. Spawns force the element in the argv (`CODEX_TITLE_CONFIG`) so as not
to depend on whatever the operator's `config.toml` has; an element a future
version does not recognize is ignored by Codex with a warning, without failing
the start.

The title travels with the pane's identity in the same `permissionView` call,
after a tab and **outside** `identity`: the marker blinks, and an identity that
changes identifies nothing.

**3. `stallSignal` — the stall, when there is nothing else.** `screenSignature()`
gives a fingerprint of the screen and the block fires when it has gone 20 s
without changing with the turn open (`ORCA_STALL_MS`). It reads no text at all,
so it survives any CLI rewriting its TUI. A ten-minute `Bash` does not fall in
here: both CLIs animate a spinner, seconds and tokens while a command runs. What
does not change is a TUI waiting for a keystroke.

Layers 2 and 3 do not claim what is being asked, so their block carries no
options: it carries where to answer it. Layer 3 is `input` —it is not even known
to be a permission— and layer 2 is `permission`, because the CLI says so.

## Why it asked so much

`auto` translated to `-a on-request -s workspace-write`, and that sandbox **cuts
the network**: measured on 2026-09-07 with codex-cli 0.153.4, `codex sandbox --
curl https://example.com` returns `000`. A worker with a browser inside that
sandbox does not browse, and `-a never` does not save it — instead of asking, it
returns the failure to the model, which retries.

Between stalling the fleet on dialogs nobody answers and launching without a
sandbox, for Codex the second is chosen and said out loud: **`auto` is
`--dangerously-bypass-approvals-and-sandbox`**. `ORCA_CODEX_APPROVALS=1` brings
back the previous posture without touching code. Claude does not change: its
`auto` already resolved on its own.

Along the way, `manual` mapped to `-a untrusted`, which **0.153.4 no longer
accepts** (`-a` takes `on-request` and `never`). It was a spawn that failed at
launch, not at policy. It now maps to the `acceptEdits` posture; the lost
granularity now lives in Codex's permission profiles, which ORCA does not use
yet.

## What this does not fix

- **Claude Code is unmeasured.** It writes a title, but it has not been checked
  whether it marks anything when asking for permission. Until that is checked,
  for Claude `promptOn` rules and the stall sits behind it, which is what was
  already there. It is an afternoon's work: the same isolated tmux, a provoked
  permission and `#{pane_title}`.
- The bypass genuinely removes the sandbox. Containing it is the job of worktrees
  (`ORCA_WORKTREES=1`), which is still off by default and is the next decision.
- Layers 2 and 3 say that an agent is waiting, not what for. Without `promptOn`
  there is no `allow | deny`: you have to open the terminal.
- The title signal is good and it is still text. The one that is not text exists
  and is not used: `codex app-server` publishes
  `item/commandExecution/requestApproval`, `item/tool/requestUserInput` and
  `mcpServer/elicitation/request` as typed JSON-RPC, with a schema the CLI itself
  generates (`codex app-server generate-json-schema`). That is the definitive way
  out, and it is an architecture change: today ORCA hosts the TUI in a pane, and
  that protocol asks for hosting an app-server session.

## Verification

```
npm run typecheck
npm test -- --changed          37 suites, 492/492
```

Covering this delivery:

```
npm test -- permissions        promptOn with an MCP without `action`, screen fingerprint
npm test -- collector          titleSignal and stallSignal: threshold, states, `since`
npm test -- codex              codexArgv: auto, forced title, no untrusted
npm test -- screen commands tmux interrupt
```

The test titles are real captures, not inventions: they come from
`display-message -p '#{pane_title}'` against a codex 0.153.4 in an isolated tmux,
with an approval provoked and then cancelled.

`--changed` warned about four files with no suite covering them —`test/visual.ts`,
`test/field-stress.ts`, `test/hud-tasks.shots.ts`, `vite.config.ts`—: they are
changes unrelated to this delivery that were already in the working tree.

No real Codex worker was launched against Playwright: the argv, the posture
translation and the detection are tested; whether the browser completes a whole
session under the new default is unverified live.
