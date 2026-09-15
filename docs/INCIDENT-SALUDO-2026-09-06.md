# Greeting test: September 6, 2026

Taipei hours (UTC+8). Reviewed hub events, Claude transcripts, current tmux
panes, and the files produced. No messages were sent, no keys were pressed,
and no agents were stopped during this review.

## What happened

- 09:19:28: the user asks for "launch two agents that greet each other."
- 09:19:46: CAPCOM announces the squad `saludo-01` and promises to notify.
  On its own initiative it also adds log writing inside its `capcom` project.
- 09:20:03: A (`QM`, `ebc67eca-db0f-4ea2-8bcf-38d444a94627`) sends the greeting.
- 09:20:14: B (`B1`, `9b35c8d3-90d6-43cb-a340-87ecbef148ef`) replies.
- 09:20:36: A confirms. The requested greeting is now complete.
- 09:21:00: B reports it cannot write files; neither can its subagent.
- Until 09:27:27: A tries to delegate the writing to more agents, several in
  the same restricted folder. The events log subdelegation down to depth 3.
  Eventually a worker from the ORCA project writes the logs to the requested
  path.
- 09:27:41: A gives its final answer and goes idle. CAPCOM keeps its 09:19:46
  reply; it never received a completion turn.

Message times were cross-checked against `mcp__orca__relay` calls in the
transcripts, not just against the logs the worker reconstructed.

## Causes

1. The workers were launched inside `~/.orca/capcom`. They inherited the
   coordinator's instructions and `.claude/settings.json`, which denies Bash,
   Edit, Write and NotebookEdit. The restriction is not limited to the CAPCOM
   process.
2. A greeting test turned into an unrequested writing task. Delegating again
   inside the same folder reproduced the block.
3. There was no automatic handback of the result to CAPCOM. A worker ending
   its turn does not end its hosted process or start a turn for the lead.
4. On screen inspection, "have the greeting agents finished yet?" was still
   sitting in CAPCOM's editor, with no corresponding turn in its transcript.
   So paste/Enter and the collector's acknowledgment do not prove acceptance
   by the CLI. Enter was not pressed, to avoid interfering with input the
   user might have been editing. A contract for runtime acceptance is needed.
5. `inspect_agent("B1")` initially returned an unrelated agent from the
   axolots project. Callsigns repeat across projects; A fixed the query by
   using the full ID. That is another ambiguity still pending resolution.

## Fix applied

The collector rejects worker launches inside CAPCOM's folder and its
descendants, resolving real paths too. No permissions are relaxed.
`list_fleet` flags the control project, and the briefs forbid using it for
workers, adding artifacts to minimal tests, or promising notifications
without a real return path. The squads suite passes 22/22 and typecheck
passes.

This fix prevents the restriction inheritance from repeating. It does not
yet implement verifiable CLI acceptance, automatic handback to the lead, or
unambiguous callsign resolution.

## Local evidence

- `~/.orca/hub/ceo.jsonl`
- `~/.orca/hub/events/2026-09-06.jsonl`
- `~/.claude/projects/-Users-danielcardenas--orca-capcom/57ec8a2f-771f-49de-ab56-60a30bce72f0.jsonl` (CAPCOM)
- Same directory: transcripts for A and B with the IDs above.
- `~/.orca/capcom/saludo/saludo.log`
- `~/.orca/capcom/saludo/saludoB.log`
