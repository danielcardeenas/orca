# CAPCOM rotation: hand off before it forgets

A CLI session compacts its context when it fills up, and it keeps doing so
indefinitely. By the third or fourth compaction the command is working off a
summary of a summary: nothing breaks, the answers just get vaguer.

The way out is not to make the conversation longer, it is to stop treating it as
the record. The record is the hub — tasks, escalations, persistent memory — and
`briefing` reads it in one call. So a session past the threshold is replaced by
another with the same brief. That is a rotation, and `src/collector/rotation.ts`
is the rule that says when.

## When

Three signals, any one of them is enough:

| Signal | Default | Variable |
| --- | --- | --- |
| Fraction of the window taken by the last prompt | 75 % | `ORCA_CAPCOM_MAX_CONTEXT_PCT` |
| Compactions observed in the transcript | 4 | `ORCA_CAPCOM_MAX_COMPACTIONS` |
| Turns | 300 | `ORCA_CAPCOM_MAX_TURNS` |

The fraction of the window is the preferred signal because it arrives **before**
the first compaction: the handoff inherits a checkpoint instead of a summary of a
summary. It does not work as a measure of accumulated loss — the number drops to a
few thousand after every compaction — so it cannot be the only one. Compactions
are the measure of what has already been lost and they only grow. Turns are the
net for a CLI that reports neither window nor compactions. A `0` turns off each
signal; all three at `0` turn off rotation.

Codex reports all three: `last_token_usage.input_tokens` over
`model_context_window` for the window, and one `compacted` line per compaction.
Claude reports compactions (`compact_boundary`) and context tokens.

And only when it is safe: the session idle, with no escalations pending on this
machine and silent for `ORCA_CAPCOM_ROTATE_IDLE_MS` (30 s by default). It can wait
indefinitely: a busy CAPCOM is a CAPCOM working, whatever context it has. While it
waits, it says so once in the log.

## How

Two paths, depending on how the current session was born:

- **Relaunch.** If ORCA chose its identifier (`claude --session-id`), the pane is
  stopped and another is started with `CAPCOM_ROTATED_PROMPT`. The hub is warned
  first, so it holds the mail, and it does not count against the relaunch cap: it
  is policy, not a crash.
- **Prepared handoff.** If the session came prepared — any Codex, or a handoff
  already activated — its identifier was not ORCA's and cannot be recreated: the
  replacement has to be prepared, checked that it starts, and only then is the
  previous one retired. It is exactly what `New CAPCOM` does by hand; automatic
  rotation asks for the same thing internally (`ProviderHandoffs.fresh`), with the
  mail retention and the archiving that path already brings. See
  [CAPCOM-NEW.md](CAPCOM-NEW.md).

Ten minutes pass between two handoff attempts. The threshold that triggered the
rotation is still exceeded for as long as the current CAPCOM is still the current
one, so without that brake a preparation failing on quota would ask for a CLI
process every ten seconds. A failure leaves the current CAPCOM exactly where it
was.

## What context the replacement starts with

`ORCA_CAPCOM_ROTATE_MODE` chooses between the two `New CAPCOM` modes:

- `continuity` (the default): it inherits the short checkpoint the hub writes —
  open tasks, unresolved questions, persistent rules, fleet references — and
  carries on. A rotation nobody asked for should not cost the operator the thread
  they were on.
- `clean`: it starts empty and waits for instructions. That is what an operator
  chooses deliberately, not what suits an unattended rotation.

In neither case are tasks, hub conversations, rules or workers touched: that is
hub state and it survives any handoff. That is precisely what makes the session
disposable.

## Verification

```sh
npm run typecheck
npm test -- rotation
npm test -- codex
npm test -- capcom capcom-new provider-handoff
```
