# Requests to the contract (`src/shared/`)

Things the hub needed that the contract does not say, or only half-says.
**None of this has been changed in `types.ts` or `protocol.ts`** — the hub
adapted to what is there. It is written down here so it can be decided with a
cool head.

Written by the hub agent. Format: what is missing · what I did in the meantime.

---

## 1. `rev`: mutation counter vs. frame sequence  ⟵ the important one

`WorldState.rev` "is incremented on every mutation" and at the same time the
protocol says that in `{t:'patch', rev}` **rev must be exactly the previous one
+ 1**. Those two cannot be the same number: the bus collapses a burst of 30
mutations into a single frame, so that frame would have to be `rev+30` and the
console would detect a gap and ask for resync nonstop.

**In the meantime:**
- `World.state.rev` counts mutations (exactly +1 for each one). It is what
  `/api/health` reports as `rev`.
- `PatchBus.rev` is the publication sequence: +1 per emitted frame, never a gap.
- The `{t:'world'}` a console receives is stamped with `PatchBus.rev`, so from
  the console's point of view the contract is met to the letter: world at rev
  N, then N+1, N+2…
- `/api/world` returns the same view a console sees (publication rev).

**Request:** either say in `protocol.ts` that the wire's `rev` is a frame
sequence, or add a separate field to `WorldState` (`mutations`) and leave `rev`
for the wire. The second is more honest.

## 2. WebSocket close codes

The protocol defines none. The hub uses (and the console should recognize):

| code | meaning |
|--------|-------------|
| `4001` | token missing or invalid |
| `4002` | incompatible protocol version |
| `4003` | `hello` missing or malformed |
| `4009` | another connection claimed that `machineId` (reconnection); do not retry in a loop |

**Request:** move them into `protocol.ts` as constants.

## 3. `escalation:answer` and `ceo:say` carry no correlation id

`ClientFrame` only allows an acknowledgement (`{t:'ack', cmdId}`) for
`{t:'cmd'}`. When the human answers an escalation from the console there is no
way to tell them "it arrived" or "the machine is down and I could not deliver
it".

**In the meantime:** the hub applies the answer to the world (the console sees
it through the escalation's patch) and underneath emits a `{k:'answer'}` to the
collector with a `cmdId` of its own; that command's ack is routed to the
console that asked for it, so it does arrive, but with an id the console does
not recognize.

**Request:** `{ t:'escalation:answer'; id; answer; rememberAs; cmdId?: string }`.

## 4. A `KeyDescriptor`'s key

`{o:'key', id}` needs an id and `KeyDescriptor` has no `id` field; it has
`name` + `projectId`.

**In the meantime:** the hub indexes by `` `${projectId}/${name}` ``. It is in
`world.ts`; the console has to use the same convention.

**Request:** either an `id` on `KeyDescriptor`, or write the convention down in
`types.ts`.

## 5. The feed only knows how to grow

`{o:'feed', v: FeedItem[]}` is an append. The hub trims its copy to 500 (what
falls off goes to the persistent log), but there is no op that tells the console
"trim". A console that has been open for hours accumulates everything.

**In the meantime:** the hub never sends more than 500 items in a frame and the
console has to trim on its own to `MAX_FEED = 500`.

**Request:** `{o:'feed', v, replace?: boolean}` or a `{o:'feed:trim', keep:n}`.

## 6. There is no op for `ceo.awaitingHuman`, nor for the messages

`PatchOp` has `ceo:thinking` but not `ceo:awaiting`. And messages travel via
`{t:'ceo:message'}`, which takes no part in the `rev` numbering: a console that
reconnects and asks for resync recovers the messages inside the `{t:'world'}`,
but a message emitted right between the snapshot and the first patch could be
duplicated.

**In the meantime:** `CeoMessage`s carry an `id`; the console has to
deduplicate.

**Request:** `{o:'ceo:awaiting', v:boolean}` and say in the protocol that the
CEO's messages are deduplicated by `id`.

## 7. `snapshot` does not distinguish "there are no agents" from "I did not look at them"

If a collector sends a `snapshot` with `agents: []` the hub assumes everything
that does not appear has died (it marks them `dead`, without deleting them). It
is the safe interpretation, but a collector with a disk-reading bug can kill a
whole fleet in the view.

**Request:** a `partial?: boolean` on the `snapshot` frame, or a
`{t:'snapshot:begin'|'snapshot:end'}`.

## 8. Partial metrics in `{t:'agent', patch}`

`Partial<Agent>` implies that `metrics`, if it comes, comes whole. In practice a
collector sends only the counters that changed.

**In the meantime:** the hub **merges** `metrics` instead of replacing it, so a
patch with `{metrics:{tokensPerSec:40}}` does not wipe `costUSD`. It is what you
would want, but it had better be written down.

**Request:** declare `metrics?: Partial<AgentMetrics>` on the `agent` frame.

## 9. Answers to escalations from downed machines

If the human answers an escalation whose machine is offline, the hub marks it
`answered`, persists it and remembers it, but the agent never finds out (and by
then it is `dead`). There is nothing in the contract for "answer pending
delivery".

**In the meantime:** the ack to the console comes back `ok:false` with
`"máquina no conectada"`, but the escalation already shows as answered.

**Request:** an `answered_undelivered` state, or have the collector ask, on
reconnect, for the answers it missed.

---

# Collector requests

Written by the collector agent, against Claude Code **2.1.260** on macOS. Same
rules: `types.ts` and `protocol.ts` were not touched; the collector adapted.

## 10. `Command.permit` cannot be implemented today  ⟵ the important one

`{k:'permit', agentId, allow, scope}` promises to answer a permission prompt.
Claude Code 2.1.260 **exposes no way to do that from outside the process**:
there is no subcommand (`claude --help` lists `agents`, `attach`, `logs`, `rm`,
`stop`, `respawn`, `auth`, `mcp`… and nothing else), there is no control file in
`~/.claude/jobs/<id>/`, and the prompt lives in the session's TTY.

Worse: a permission block cannot even be *detected* directly. The transcript
does not write an "I am asking for permission" line; all you see is a `tool_use`
whose `tool_result` never arrives.

**In the meantime:**
- The collector infers `block.kind = 'permission'` heuristically: a `tool_use`
  pending >90s, on a guarded tool (`Bash`, `Edit`, `Write`, `Task`…), and with
  `permissionMode` outside `{auto, acceptEdits, bypassPermissions, plan}`. It is
  a good hint, not a fact. A legitimately slow `Bash` in manual mode will be
  marked as blocked.
- `permit` answers **`ok:false`** with a detail saying what to do
  (`claude attach`, or relaunch with `--permission-mode`). Failing explicitly is
  better than pretending something was done.

**Request:** either drop `permit` from the contract until the CLI supports it,
or declare it `best-effort` so the console does not offer a button that lies.

## 11. `Agent.block` cannot carry the options the agent already offered

When an agent calls the `AskUserQuestion` tool — which is literally "I am asking
the human" — the transcript brings the whole structure:

```jsonc
{"questions":[{"question":"…","header":"Credencial","multiSelect":false,
  "options":[{"label":"Exportar CLOUDFLARE_API_TOKEN","description":"…"}]}]}
```

`Agent['block']` only has `{kind, summary, escalationId?, since}`. The options,
which are exactly what the console would want to paint as one-tap answers, do
not fit. `Escalation` does have them, but an `AskUserQuestion` is not an ORCA
escalation: nobody wrote a file in `.orca/ask/`, and the collector cannot answer
it either (see #10).

**In the meantime:** the collector puts the first question in `block.summary`
and throws the options away. The console knows *what* is being asked and not
*what it can answer*.

**Request:** `block.options?: string[]`, or allow synthesizing a read-only
`Escalation` (`status: 'pending'`, with no answer channel).

## 12. An `Agent` does not say where it lives

There is no `cwd`, no `transcriptPath` and no raw `sessionId` on `Agent`. The
`id` the collector invents for a subagent is `<session-uuid>#<agentId>`, so not
even the sessionId can be reconstructed with a reliable split from the console.

It hurts in three places: the console cannot offer "open the transcript", it
cannot show the `claude attach` command (that is what `shortId` is for, but it
only exists on background sessions), and the hub cannot deduplicate an agent
that shows up from two collectors because of a shared directory.

**In the meantime:** `id` is `<sessionId>` for a root session and
`<sessionId>#<agentId>` for a subagent. Documented here and nowhere else, which
is exactly the problem.

**Request:** `sessionId: string` and `transcriptPath: string` on `Agent`.

## 13. `AgentMetrics.turns` and `.toolCalls` cannot be session totals

On this machine there are 2.8GB of transcripts and files of up to 83MB. Counting
the historical turns requires parsing the whole file, and doing that for 539
sessions at startup is unworkable. The collector reads the **tail** (up to 4MB)
and follows live.

Consequence: `turns` and `toolCalls` are *"observed since the collector hooked
in"*, not totals. For a new session they match; for a 55-day-old one, they do
not. `costUSD`, `inputTokens`, `outputTokens`, `linesAdded/Removed`,
`apiDurationMs` and `toolDurationMs` **are** totals, because Claude Code writes
them already aggregated on a `cost-state` line.

**In the meantime:** the collector rescues the last `cost-state` with a
byte-level backwards search for the marker (no parsing), which gives exact cost
metrics. Verified: the sum over the 539 agents is $5663.80, identical to an
independent sweep of the corpus. But `turns`/`toolCalls` are still partial.

**Request:** split the type into `metrics` (total, authoritative) and
`observed: {turns, toolCalls}` — or a `metricsPartial: boolean`.

Related note: **only 120 of 539 transcripts have `cost-state`**. Claude Code
writes it at the end of the session, so a live agent legitimately reports
`costUSD: 0`. It is not a collector bug; the console had better not paint
"$0.00" as if it were data.

## 14. There is no way to tell a root session from a subagent from a workflow agent

`Agent.background` distinguishes background from interactive, and `depth > 0`
implies somebody launched it. But on disk there are three different things:

```
<slug>/<session>.jsonl                                    root session
<slug>/<session>/subagents/agent-<id>.jsonl               subagent (Task tool)
<slug>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl workflow agent
```

A workflow agent has `depth > 0` just like an ordinary subagent, but it belongs
to a workflow run that the console would want to group. The collector knows the
`workflowId` and has nowhere to put it.

**In the meantime:** the `workflowId` stays inside the collector. Workflow
agents look like any other subagent.

**Request:** `kind: 'session' | 'subagent' | 'workflow'` and
`workflowId?: string`.

## 15. `Machine.load.memPct` does not mean the same thing on macOS

`1 - freemem/totalmem` gives **99.9%** on a healthy Mac: macOS keeps almost all
RAM occupied with cache and compressed memory. Reported as is, the console's
memory bar is always red and tells you nothing.

**In the meantime:** the collector reports the honest number. `cpuPct` is
useful (it is computed as a delta between two `os.cpus()` samples, which is why
the first frame sends it as `null`).

**Request:** define `memPct` as "memory pressure" and let each platform compute
it its own way, or add `memPressure: 'normal'|'warn'|'crit'`.

## 16. `Command.spawn` does not cover what the CLI already knows how to do

`claude` accepts `--effort <low|medium|high|xhigh|max>`, `--agent <name>`,
`--add-dir`, `--allowedTools` and `--name`. `Command.spawn` only carries `model`
and `permissionMode`. `--effort` in particular is the most direct cost/quality
lever there is, and it cannot be asked for from the console.

**In the meantime:** the collector uses `mission` as `--name` (so that
`claude agents` shows something readable) and ignores the rest.

**Request:** `effort?: 'low'|'medium'|'high'|'xhigh'|'max'` and `agent?: string`
on `Command.spawn`.

## 17. The contract's `permissionMode` ≠ the CLI's

`Command.spawn.permissionMode` accepts `'auto' | 'acceptEdits' | 'plan' | 'manual'`.
The CLI accepts those four **plus** `bypassPermissions` and `dontAsk`.

**In the meantime:** the collector validates against the CLI's set (all six) and
rejects anything else before building the argv. A contract value always passes;
the two extras are unreachable from the console.

**Request:** align the union with the CLI.

## 18. `AgentMessage` does not say which machine it comes from

A message is routed between machines, but carries no `machineId` — unlike
`Escalation` and `Collision`, which do. The hub needs to know it for two things:
rejecting a collector that speaks on behalf of somebody else's agent, and
knowing which collector to push the `{k:'reply'}` down to.

**In the meantime:** the hub deduces it from the sender's `Agent`
(`agents[fromAgentId].machineId`). It works except in a narrow window: if the
message arrives **before** its sender's `agent:new`, there is nothing to compare
against and the frame is accepted without being able to verify ownership. With a
snapshot on connect that window is milliseconds, but it exists.

**Request:** `machineId: string` on `AgentMessage`, like everything else that
travels on the wire.

## 19. A collision does not record who resolved it, or on what grounds

`Collision.acknowledged` is a boolean. When the CEO decides who keeps the file
(`resolve_collision`), that decision — which agent continues, which one steps
aside, why — does not fit anywhere: all that is left is the notice sent to the
one that steps aside, which lives in `messages` and expires in an hour.

**In the meantime:** the decision stays in the hub's append-only log
(`collision:new` + the notice's `message:relay`) and the collision is only
marked `acknowledged`. The console cannot show "K9 keeps api.ts (the CEO
decided)".

**Request:** `resolvedBy?: 'human' | 'ceo'`, `keepAgentId?: string` and
`reason?: string` on `Collision`.

## 20. The console can answer a message but cannot send one

`ClientFrame` has `{t:'collision:ack'}` and can emit `{k:'reply'}` inside a
`{t:'cmd'}`, but there is no way for the operator to send a message to an agent
or to a project from the console: `{k:'deliver'}` demands an already-built
`AgentMessage`, with an id, and the console should not be inventing world ids.

**In the meantime:** only the CEO can originate traffic, via
`Hub.relayMessage`, which builds the `AgentMessage` inside the hub (sender
`'ceo'`, callsign `CEO`) and routes it. From the console the operator asks for
it by talking to the CEO.

**Request:** `{ t:'message:send'; kind; scope; toAgentId?; toProjectId?; subject;
body? }` on `ClientFrame`, and let the hub assign the id.

## 21. `{t:'collision:ack'}` and `{k:'reply'}` have no acknowledgement of their own

Same problem as point 3, in the new channel: when the console acknowledges a
collision it gets no confirmation, and when it sends a `reply` the ack that
comes back carries a `cmdId` it did not generate (the hub opens a command of its
own toward the collector of whoever asked).

**In the meantime:** the world changes and the console sees it through the
corresponding `PatchOp` (`{o:'collision'}`, `{o:'message'}`), which is enough to
paint but not enough to say "I could not deliver it, the machine is down".

**Request:** an optional `cmdId?: string` on the console frames that trigger a
machine command.

---

# Requests from the agent ↔ agent channel

Written by the agent of the messages and collisions channel. Same rules:
`types.ts` and `protocol.ts` were not touched. The full contract on the agent's
side is in `docs/MESSAGING.md`.

## 18. There is no way to WITHDRAW a message  ⟵ the important one

An escalation can be withdrawn (`{t:'escalation:withdraw', id, reason}`). A
message cannot: `CollectorFrame` only has `{t:'message'}`. But a message does
die in three ways:

- a `notice` passes its `expiresAt`;
- an unanswered `ask` whose **sender disappeared from disk** — it no longer
  blocks anyone because there is nobody left to block;
- an `ask` with a `ttlMinutes` that expires.

Without a withdraw frame, the hub keeps showing an edge on the map that the
collector has already forgotten, and `block.kind='peer'` disappears from the
agent without the message that caused it disappearing with it. The two halves of
the same fact travel by different paths.

**In the meantime:** the collector stops counting it in its `blocks()` (so the
agent leaves `blocked` through the normal patch) and simply stops resending it
in the snapshot. The hub has to expire it on its own using `expiresAt`, and for
the dead-sender case it has no signal at all.

**Request:** `{t:'message:withdraw', machineId, id, reason}`, exactly like the
escalation one. It is the same problem and deserves the same solution.

## 19. `AgentMessage` does not say which machine it comes from

`Escalation` has `machineId`. `Collision` has `machineId`. `AgentMessage` does
not. The frame `{t:'message', machineId, message}` carries it on the outside,
but as soon as the hub stores it in `WorldState.messages` that information is
lost, and `{k:'reply', messageId, …}` does not say which collector to push down
to.

**In the meantime:** the hub has to remember on its own which machine emitted
each message (or look it up by `fromProjectId`, which does carry the machineId
inside by the `<machineId>/<slug>` convention of `ProjectRegistry.idForSlug`).
That convention is not written in `types.ts`, which is the same problem as #4.

**Request:** `machineId: string` on `AgentMessage`.

## 20. The outbound mailbox payload needed a `replyTo`

The original design of the `.orca/out/` mailbox only contemplates new messages.
With that, an `ask` can only be closed from the console: two agents on the same
machine cannot finish a conversation between themselves, even though both are
looking at the same filesystem.

**In the meantime:** an outbound file with `{replyTo, answer, agentId}` is
routed as an answer instead of as a new message, and `orca-tell --reply <id>`
writes it. It is documented in `docs/MESSAGING.md` §5. It does not touch
`protocol.ts` — it is an on-disk shape, not a wire shape — but the CEO and the
agent's skill depend on it.

**Request:** none to the contract; only that `docs/MESSAGING.md` be considered
normative just like `docs/ESCALATION.md`.

## 21. `AgentMessage.readBy` cannot be filled in for a broad scope

`readBy: string[]` works for a `scope:'agent'` message: it is delivered into one
mailbox, an `<id>.read` appears, you know who. For `scope:'project'` or
`'fleet'` the message is delivered into N mailboxes and the read mark does not
say **which** of that project's agents wrote it — the file is written by the
CLI, not by ORCA, and a project can have five sessions sharing a directory.

**In the meantime:** `readBy` is only filled in for deliveries addressed to a
specific agent. For the rest it stays empty, which is honest: better not to know
than to assert something false.

**Request:** either declare `readBy` as "only meaningful with scope 'agent'", or
have the read mark carry the sessionId inside and have the contract say so.

## 22. `Collision.acknowledged` has no path back to the collector

The console sends `{t:'collision:ack', id}` to the hub, and
`Collision.acknowledged` exists on the type. But there is no `Command` telling
the collector "this one has been seen": the collector will keep re-emitting it
every time `lastSeen` moves perceptibly, and the hub will have to re-apply the
ack on every re-emission.

**In the meantime:** the collector always emits `acknowledged: false` — it is
the only value it can truthfully assert, because the acknowledgement is a fact
about the console, not about the machine. The hub has to preserve its own
`acknowledged` when merging a re-emission.

**Request:** say it in `types.ts` (`acknowledged` is owned by the hub, the
collector always sends false), or add `{k:'collision:ack', id}` to `Command`.

## 23. `block.waitingOn` has no defined shape

`Agent.block.waitingOn?: string` does not say whether it is an `agentId`, a
callsign, or something else. And an `ask` to a project or to the fleet does not
point at anybody in particular.

**In the meantime:** the collector puts the `agentId` when the scope is
`'agent'`, `project:<projectId>` when it is a project's and `fleet` when it is
the fleet's. The console has to know how to disambiguate by the prefix.

**Request:** `waitingOn?: { kind: 'agent'|'project'|'fleet'; id: string | null }`,
or write the prefix convention down in `types.ts`.

## 24. `claude --bg --resume` does not continue the session: it moves it

Measured against Claude Code **2.1.261**, and it is the request to the CLI that
weighs most on CAPCOM.

`claude --bg --resume <sessionId> "<text>"` does **not** continue that session
under its id. It drags the whole conversation — previous turns included,
verified by reading the resulting `.jsonl` — into a **new** session, with a new
`sessionId` and a new short id, and the old one is left finished. The `--help`
hints at it ("starts a copy and says so when the session is already running"),
but it also happens after `claude stop <id>`, which is exactly the case that
`stop`'s help suggests would continue in place.

For a working agent that just dirties the lineage. For CAPCOM it is fatal: the
fleet's command is identified by `Agent.role === 'capcom'`, that role lives in
`~/.orca/lineage.json` indexed by short id, and the human's first message would
leave the role stuck to an already-dead session. The hub would look for a live
CAPCOM, would not find one, and the collector would launch a second CAPCOM on
top of the one that had just answered — a new one for every sentence the person
typed.

**In the meantime:** `CommandRunner.say`/`resume` detect that the recipient is
CAPCOM (`CapcomChannel.owns`), read the short id the CLI prints and move the
role with `adopt()`. On top of that, `CapcomSession.check()` does not declare a
freshly adopted session dead during `CAPCOM_GRACE_MS` (60 s): `claude agents
--json` takes a while to list it, and without that window the watchdog would
launch the duplicate anyway.

**Resolved for working agents (2026-09-05):** they are no longer launched with
`--bg`. They live in a tmux pane as a normal interactive session, with a
`--session-id <uuid>` chosen by ORCA; `say` is a bracketed paste into their
prompt, and `resume` is an interactive `claude --resume <id>`, which does keep
the id. See `src/collector/tmux.ts` and the README, "Terminals". CAPCOM is still
on `--bg` with the `adopt()` above, because its tools go in the argv and the
role is identified by short id; moving it to a pane is the natural next step.

**Request to the CLI (still standing for `--bg`):** that `--resume <id>` under
`--bg` keep the `sessionId`, or that it explicitly print `resumed <old> as
<new>` in a stable format. Today you have to deduce it from the last hexadecimal
token of the output.

## 25. A project settings' `permissions.allow` is ignored without trust

Also 2.1.261. A directory freshly created by ORCA (`~/.orca/capcom/`) is not in
the list of trusted workspaces, and so the CLI discards the `permissions.allow`
entries from its `.claude/settings.json`, saying so in the output:

```
Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace
has not been trusted. Run Claude Code interactively here once and accept the
trust dialog, or set projects[...].hasTrustDialogAccepted: true in ~/.claude.json
```

A `--bg` session has nobody to accept that dialog, so the settings ORCA writes
would be a permission that never applies — and CAPCOM would stall at the first
permission prompt from an MCP tool, which is indistinguishable from a quiet
fleet.

`enableAllProjectMcpServers: true` from the same file **is** respected: the
`orca` server from `.mcp.json` connected without approval on the first test.
Only permissions go through the trust gate.

**In the meantime:** permissions travel in the argv, which does not go through
that gate — `--allowedTools mcp__orca --disallowedTools Bash Edit Write
NotebookEdit` — together with `--mcp-config <dir>/.mcp.json
--strict-mcp-config`, which also avoids inheriting the user's MCP servers (two
of them were asking for authentication and cost CAPCOM a round to find that
out). The `settings.json` is still written, but only so that a human who opens
`~/.orca/capcom` by hand sees the same posture.

**Careful with argv order:** `--allowedTools`, `--disallowedTools`,
`--mcp-config` and `--tools` are **variadic** — they eat everything that comes
after them up to the next `-`. With `--bg` the prompt is positional, so a
variadic in front of the prompt swallows it and the session starts with no
instruction at all. In `capcom.ts` every variadic is followed by another option
and the prompt always goes last; there is a test that checks it.

**Request to the CLI:** that `--settings <explicit path>` not inherit the
workspace's trust gate (the human already named the file), or a non-interactive
way to trust a directory.
