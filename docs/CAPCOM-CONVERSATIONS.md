# CAPCOM conversations

CAPCOM keeps one coordinator and offers per-task conversations. In its window,
**NEW TASK** creates a conversation; the selector lets you go back to earlier
ones. The first message sets the title. **GENERAL · FLEET** keeps the global
view. Each task shows its messages, status and agents, with links to the agent,
its location and its terminal. Pending questions from those agents link to the
existing answer panel.

The hub persists tasks in `tasks.json` inside its data directory, using atomic
replacement. On connect it delivers the history along with the world and
publishes changes over WebSocket. The selection is kept in the browser. Up to
100 tasks, 100 messages per task and 8,000 characters per message are retained;
it is not an unlimited transcript archive.

Every send includes an explicit `taskId`. CAPCOM receives the ID and recent
context, and replies via `report_task`, indicating `active`, `completed` or
`failed`. `spawn_agent` and `launch_squad` accept `task_id` to associate the
workers. A squad label also allows associating Codex sessions whose ID arrives
after the launch acknowledgement. Descendants are taken in by parentage.
Observed results from assigned agents are stored once per text and reported to
CAPCOM, grouping nearby updates. An observed result does not automatically mark
the task as finished: CAPCOM has to confirm the close.

CAPCOM does not need to remember the tasks: it reads them from the hub.
`list_tasks` (filters `status` and `only_pending`) returns each conversation
with its status, its agents with callsign and state, the date of the last
message and whether there is an unanswered human message or unreported worker
results; `inspect_task` returns a full task with what is left to answer. The
rule is positional: everything after CAPCOM's last message in the task is
pending. `briefing` summarizes the whole fleet in one call — blocked agents,
tasks in debt, finished workers not reported, squads with no live members,
projects with activity, latest rules — and it is the first thing a new or
just-compacted session calls. When the CAPCOM session is recycled (see the
README, "It is recycled before it forgets"), the hub holds the task messages
until the new session appears and delivers them then; if it does not come back
within three minutes, the task receives a `Delivery failed` system message.

The conversations share CAPCOM's process and internal context. There is
explicit separation of history and routing, but no session isolation and no
independent simultaneous execution of the coordinator. The prompt provides the
last eight interventions (up to 2,000 characters each). Free-text replies from
the terminal stay in GENERAL; to appear in a task you have to use `report_task`.
CAPCOM's direct questions through `ask_human` still use the global interrupt
panel.

The collector's acknowledgement confirms delivery to the input mechanism, not
that the model consumed the message. A failure shows up in the receipt; the
message stays stored. Result notices have no persistent retries after a restart;
the result itself does stay in the conversation.

To use these changes you need the updated hub and a CAPCOM session that has
loaded the new MCP catalog (`report_task`). An earlier session may need to
reconnect its MCP or be restarted. Active work sessions are not restarted as
part of installing the change.

Validation: `test/tasks.test.ts` checks persistence, attribution of late
replies, descendants, deferred squads, reconnection and result notices.
The Playwright check uses a simulated connection on desktop and mobile: it
creates two conversations, verifies the separation of replies and restores the
selection.

## The window: TALK, WORK and EVENTS

CAPCOM's window has three tabs. **TALK** is the conversation; **WORK** lists the
agents CAPCOM has running (or those assigned to the task) with access to the
agent, to its position in the field and to its terminal; **EVENTS** gathers the
traffic CAPCOM sends to the fleet and the telemetry about it, which used to be
interleaved with the conversation. Below the conversation there is a status line
with what CAPCOM is doing right now: state, tool in use, speed and cost, plus
TERM and FLY. Quick requests take up a single scrollable row.

In GENERAL, TALK shows the CAPCOM session's real transcript. The collector emits
`talk` frames for each block the CLI writes into its JSONL: the full prompt, the
thinking blocks, each tool call with its detail, the result trimmed to 600
characters and the complete reply. The hub stacks them by agent
(`world.talk[agentId]`), deduplicates by id, keeps 300 blocks and does not
persist them: the transcript on disk is already the real copy and the collector
re-reads its queue on startup. They are only emitted for the session with
`role: 'capcom'`.

The console groups the blocks into exchanges: your line and, below it,
everything CAPCOM did until it stopped. The steps (thinking, tools) are
collapsed rows that open to show what they returned. An `[ORCA TASK …]` prompt
appears as a link to that task, and an `[ESCALATION …]` as a question from the
fleet with access to the interrupt if it is still open. While CAPCOM works a
live row is added with the glyphs (thinking) or the tool in progress. The local
echo of a send is shown as your message with its receipt until the prompt
appears in the transcript.

Granularity: the CLI writes each block into its JSONL as it completes, so along
that path the reply arrives paragraph by paragraph and the thinking on closing.
A thought redacted by the CLI appears as an empty step.

Live text: when CAPCOM lives in a tmux pane, the collector keeps a tmux control
client (`tmux -C attach`) on that pane. Every time the pane paints, tmux emits
`%output` and the collector reads the screen with a 100 ms debounce (never more
often than every 80 ms), only while the state is `thinking` or `working`. From
the screen it extracts the `⏺` block the CLI is painting, only if there is an
open turn spinner and the block is text (not a tool). The control client does
not affect the pane's size; if it drops or is unavailable, the collector polls
every 400 ms until it relaunches it. At rest nothing is read.

Claude Code's TUI uses the alternate screen: `capture-pane` only returns the
visible window. If the block in progress is taller than the pane, its `⏺` falls
off the top and the spinner off the bottom; the collector then returns the
visible tail with a leading `…`, and detects that the turn is still open from
the status bar's `esc to interrupt`. The input box paints `❯` with a hard space
(U+00A0) and may contain a draft from the operator; both are tolerated. Measured
over 94 frames of a long reply (2.1.263, 104x27): text in 75, and the 22 null
ones correspond to the start of the turn, before the first block, and to the
close. It is sent as `talk:live` (`world.talkLive`), the window shows it as a
"typing" row with a cursor, and as soon as the complete block arrives through
the transcript the row disappears and the final paragraph replaces it. It is
what the TUI painted (no markdown asterisks, with its own line wrapping), not
what the API said; it is not persisted. With no pane there is no live text.

Ordering: the hub and the console merge the blocks with the same rule
(`src/shared/talk.ts`): deduplicate by id and sort by time, stably. It is needed
because a replay after restarting the hub delivers old blocks after new ones.
The state moves to `thinking` as soon as the prompt appears in the transcript,
before the first reply block, with a ten-minute cap without a reply after which
it goes back to `idle`. A collector older than this change does not send `talk`;
the window says so in its empty state and it has to be restarted. Task
conversations still show the messages published with `report_task`, with the
same live row and status line.

Validation: `test/talk.test.ts` covers derivation from transcript lines,
sanitization, deduplication, ordering and the hub's limit, folding into
exchanges, classification of wrapped prompts, the local echo, the `thinking`
state after a prompt, reading the block in progress from the screen and the live
text in the hub.
