# The agent → agent channel

Sibling of `docs/ESCALATION.md`, and with the same shape for the same reason: a
Claude Code agent has no socket to its peers. It has a filesystem. So talking to
another agent means leaving a file and waiting for the collector to pick it up.

```
<project>/.orca/out/<id>.json          the agent sends something
<project>/.orca/in/<id>.json           what reaches it (written by ORCA)
<project>/.orca/in/<id>.read           read mark (written by the agent)
<project>/.orca/in/<id>.answer.json    the answer to an `ask` of its own
```

The collector watches `.orca/out/` in every project it knows (`fs.watch` + a 1s
poll), turns each file into a contract `AgentMessage` and emits it to the hub as
`{t:'message'}`. **The hub decides who it reaches**: the delivery comes down as
`{k:'deliver', agentId, message}` and the collector writes it into the
`.orca/in/` of that agent's project. An answer comes down as `{k:'reply',
messageId, answer, fromAgentId}`.

The CEO is the router on purpose. Twenty agents with a direct line between them
are twenty agents interrupting each other; routed, a message can be held until
its recipient is between turns, merged with others, or answered without waking
anybody.

This document **is** the contract on the agent's side. The shape that travels on
the wire lives in `src/shared/types.ts` (`AgentMessage`) and is not touched from
here.

---

## 1. Sending

The agent writes a JSON at `<project>/.orca/out/<id>.json`. It chooses the
`<id>` itself: any valid filename that does not start with `.` and does not end
in `.answer`. In practice you use `orca-tell`, which gets it right on its own.

```jsonc
{
  // REQUIRED. What class of message this is. See §2: the difference matters.
  "kind": "notice" | "ask" | "handoff" | "warning",

  // Optional. Four forms and nothing else:
  //   "K9"              one specific callsign       → scope 'agent'
  //   "project:dijosi"  everyone in that project    → scope 'project'
  //   "squad:audit-01"  everyone in that squad      → scope 'squad'
  //   "fleet" | null    everybody                   → scope 'fleet'
  "to": "K9",

  // REQUIRED. One line. It is what gets painted on an edge of the map, so it
  // has to be understandable without opening anything. Max 300 chars; clipped.
  "subject": "El endpoint /v1/charges devuelve 402 en sandbox",

  // Optional, multiline. The detail. Max 8000 characters; clipped.
  "body": "Desde el deploy de las 14:40.\nLa key de sandbox caducó.",

  // Optional. Files this is about, so the console can point at something
  // concrete. Max 20; clipped.
  "files": ["src/api/charges.ts"],

  // Optional but STRONGLY recommended: your sessionId. Without it the collector
  // attributes the message to the project's most recently active agent, which
  // with several agents in the same repo can get it wrong.
  "agentId": "78b357fe-4480-419f-bd99-7b5d7980e7fd",

  // Optional. Minutes after which the message withdraws itself.
  // A `notice` without this expires in 6h. An `ask` without this NEVER expires.
  "ttlMinutes": 120
}
```

Rules the agent has to respect:

- **`kind` and `subject` are required.** A file without them, or with an
  invented `kind`, is discarded with a warning in the log and **deleted**:
  something that is never going to be valid is not retried forever.
- **Write atomically.** `<id>.json.tmp` and rename. The collector retries on the
  next tick if it reads a half-written JSON, but a rename is free.
- **`mkdir -p` the folder.** The collector does NOT create `.orca/out/`. We do
  not want an observation daemon writing inside the user's repos without anybody
  asking it to. The agent creates it with its first message.
- **One message per file.**
- **Add `.orca/` to `.gitignore`.**

The collector **deletes** the outbound file once it has emitted it. The hub
already has the record; leaving it there would only produce duplicates on the
next start.

## 2. The four `kind`s, and why the difference matters

| kind | means | blocks? |
|------|-----------|-----------|
| `notice` | "I found this out." It may be useful to somebody; nobody has to act. | no |
| `ask` | "I need this from you." | **yes, WHOEVER SENDS IT** |
| `handoff` | "This is yours now." Work changing hands, with context. | no |
| `warning` | "Careful." Something the recipient is about to collide with. | no |

An unanswered `ask` puts its sender into
`block = {kind:'peer', messageId, waitingOn, since}`, and that is what draws the
console's wait chains: A waits on B, which waits on C. It is the only reason
this channel deserves to exist instead of a shared file.

A `notice` **blocks nobody**, and that is deliberate too: if it blocked, nobody
would send notices, and the channel would die of silence.

Use `ask` only when you really cannot go on. For everything you simply want on
the record, `notice`.

## 3. Routing, and the downgrade

`to` resolves like this:

- A **callsign** (`"K9"`) against the agents ORCA is looking at right now. It
  prefers an unfinished one: labels get recycled when an agent dies.
- `project:<name>` against the project's name, code or slug, and on a second
  pass by partial match (`dijosi` finds `dijosi-workers-…`).
- `squad:<name>` against the `squad` label the agents are wearing. See §3b.
- `fleet`, `*`, `null` or absent: the whole fleet.

**If the recipient does not exist, the message is NOT thrown away.** It goes out
anyway, downgraded to `scope: 'project'` over the sender's project, and the
subject says so:

```
[no encontré a QQ] ¿Ya migraste la tabla de sesiones?
```

A misdirected notice is ignored in two seconds. One that was never emitted costs
an afternoon of debugging, because it does not leave a single log line anywhere.

## 3b. Squads

A **squad** is a group of agents with a lead: the `squad` label an `Agent`
wears, plus `lead: true` on one of them. There is no squad table and nothing to
create or delete — a squad is, literally, whoever is wearing the label right
now, and `squadsOf()` (in `src/shared/squads.ts`) derives it from the agents.
Whoever dies drops out by themselves.

The label is set by the `spawn` that created the agent (`Command.spawn` accepts
`squad` and `lead`) and the collector persists it next to `mission` in
`~/.orca/lineage.json`, so it survives a restart. **It is not inherited**: a
member's `Task` subagent works *for its parent*, not for the squad.

Valid names: letters, digits, `-` and `_`, starting with a letter or digit, up
to 32 characters (`audit-01`, `payments_migration`). Anything else is not a
squad and is discarded.

```bash
orca-tell "Informe a las 18:00, una línea cada uno" --to squad:audit-01 --kind handoff
```

It goes out as `scope: 'squad'` with `toSquad: "audit-01"`, and the **hub** —
the only one that sees the whole fleet — delivers it to every agent with that
label, whatever machine they are on. The sender never gets its own back.

One deliberate difference from the rest of the routing: an empty squad **does
not downgrade to a broadcast**. A `project:` that does not exist turns into a
notice to the sender's project, because there are people there it will probably
be useful to; a `squad:` that does not exist is sent to nobody, because waking
twenty unrelated agents over a typo is worse than not delivering it. The hub
says so in the feed:

```
K9: "Informe a las 18:00" sin entregar — nadie en el escuadrón audit-01
```

### What the lead and the members know

The collector sticks a short footer onto the prompt at spawn time — the text
lives in `src/collector/briefs.ts`:

- **lead**: its members arrive as children and report to it; it hands out work
  with `orca-tell --to <callsign>` or `--to squad:<name>`; it consolidates; and
  it only uses `orca-ask` when nobody in the squad can go on.
- **member**: which squad it belongs to, who its lead is, that it reports with
  `orca-tell --to <lead>`, and that it does **not** use `orca-ask` — the human
  belongs to the lead.

Without that footer a stuck member escalates to the person, which is exactly
what a squad exists to avoid.

## 3c. Asking for another agent

The same channel, a different payload: an agent that needs another pair of hands
writes `<project>/.orca/spawn/<id>.json` with
`{ mission, squad?, model?, agentId }` (`orca-spawn "<brief>"`) and the
collector answers in `<id>.ack.json` with
`{ ok, agentId, callsign, shortId, squad, parentId }` or `{ ok:false, reason }`.

What the collector decides, never the file: the child is the child of whoever
asked, joins the squad of whoever asked (a `squad` in the file only counts if
the asker is not in one), and is never a lead. Caps: 8 live children per agent,
13 agents per squad. A brief shorter than 20 characters is rejected before
anything is launched. The code lives in `src/collector/spawns.ts`.

## 4. Receiving

The collector writes at `<project>/.orca/in/<id>.json`, where `<id>` is the id
the message has in the protocol (`msg_…`):

```jsonc
{
  "id": "msg_c27a8e9c5dd2b6a1",
  "kind": "ask",
  "scope": "agent",                   // agent | project | squad | fleet
  "from": "Z1",                       // callsign of whoever sends it
  "fromAgentId": "78b357fe-…",
  "fromProjectId": "…",
  "subject": "¿Ya migraste la tabla de sesiones?",
  "body": null,
  "files": [],
  "at": 1788563552553,
  "expiresAt": null,
  "replyTo": "msg_c27a8e9c5dd2b6a1"   // present only on an `ask`: answer it
}
```

You read it with `orca-read`, which also writes `<id>.read` next to every
message it prints. That mark is what the collector watches in order to fill
`readBy` in the console, so do not delete it by hand.

## 5. Answering an `ask`

Two paths, and both close the same block:

**From the console / the CEO.** The hub sends down `{k:'reply', messageId,
answer, fromAgentId}`.

**From another agent**, without going through anybody: write a file with
`replyTo` into the *same* outbound mailbox.

```jsonc
{ "replyTo": "msg_c27a8e9c5dd2b6a1", "answer": "Sí, la migré anoche",
  "agentId": "<your sessionId>" }
```

or, which is the same thing:

```bash
orca-tell --reply msg_c27a8e9c5dd2b6a1 "Sí, la migré anoche"
```

In both cases the collector writes **two** things into the mailbox of whoever
asked:

- `<its local name>.answer.json` — the name it knows, which is what
  `orca-tell --wait` is waiting for;
- `<msgId>.json` with `kind: "notice"` and `subject: "re: …"` — so that the
  answer also shows up in an `orca-read` for someone who has already moved on to
  something else. If that file had a `.read` mark, it is deleted: the content
  changed, so the message is new again.

The `.answer.json` has this shape:

```jsonc
{
  "id": "msg_c27a8e9c5dd2b6a1",
  "replyTo": "msg_c27a8e9c5dd2b6a1",
  "subject": "¿Ya migraste la tabla de sesiones?",
  "answer": "Sí, la migré anoche",
  "at": 1788563590478,
  "answeredBy": "<sessionId of whoever answered>",
  "answeredByCallsign": "K9"
}
```

## 6. Waiting

```bash
orca-tell "¿Ya migraste la tabla de sesiones?" --to T1 --kind ask --wait
```

It blocks until the `.answer.json` shows up, prints the answer on stdout and
exits with 0. With `--timeout <min>` (60 by default) it exits with 3 if nobody
answered. Same as `orca-ask --wait`, and for the same reason: an agent that
waits has to be able to say "I give up, I will go on with an assumption"
instead of hanging.

While the `ask` is open, its sender shows up in the console as `blocked` with
`block.kind = "peer"`.

## 7. Ids

The protocol's id is **not** the file's name:

```
msg_<sha1(absolute path + " " + creation time)[0..16]>
```

It carries the time inside, unlike an escalation's, because the outbound file is
deleted once it is picked up: an agent that reuses `out/1.json` for its second
message has to produce a different id, or the hub would think the first one had
changed its mind.

## 8. File collisions

It is not part of this mailbox and requires nothing of the agent — it is here
because it is the other half of "two agents working close together".

The collector already reads the transcripts, and Claude Code writes a
`file-history-delta` line **before every write** (never before a read). Two live
agents writing the same file within 15 minutes
(`ORCA_COLLISION_WINDOW_MS`) produce a `Collision`, which goes out as
`{t:'collision'}` and is withdrawn with `{t:'collision:clear'}` when it stops
being true.

What does **not** count:

- Finished sessions (`done`, `dead`).
- Reads. Two agents reading the same file is normal and healthy.
- Lockfiles, `node_modules/`, `dist/`, `.git/`, `*.log` and everything hanging
  off `.orca/`.
- An agent and **its own lineage**. A subagent edits *on behalf of* its parent
  and shares a worktree by design; warning about that would be warning that the
  product works. Two siblings of the same parent **do** count: they are two
  independent writers, which is the classic case this exists to catch.

A measured detail, not an assumed one: the `backupTime` of a
`file-history-snapshot` is the snapshot's time, not that of each write — Claude
Code re-stamps the whole set when a new file comes in (18 files, 3 timestamps,
in a real transcript). That is why only a `file-history-delta` can open a
collision; the snapshot is good for knowing which files are in the agent's edit
set and nothing more.

## 9. What this channel is NOT

- **It is not a chat.** One message, and at most one answer. For conversation
  there is the CEO.
- **It does not carry secrets.** If you need a credential, ask the human for it
  through `orca-ask`; it will arrive as an environment variable, without going
  through a file in the repo.
- **It does not guarantee attention.** A `notice` may never be read by anybody.
  If you need somebody to act, it is an `ask`, and then you pay the price of
  waiting for it.

## 10. Minimal example, end to end

```bash
# A warns K9 about something it is about to collide with.
orca-tell "El endpoint /v1/charges devuelve 402 en sandbox" \
  --to K9 --kind warning --file src/api/charges.ts

# A asks something that blocks it, and waits.
ANSWER=$(orca-tell "¿Ya migraste la tabla de sesiones?" --to T1 --kind ask --wait)
echo "T1 dijo: $ANSWER"

# K9, between turns, checks its mailbox and answers what is its to answer.
orca-read
orca-tell --reply msg_c27a8e9c5dd2b6a1 "Sí, anoche. La vieja ya no se usa."
```
