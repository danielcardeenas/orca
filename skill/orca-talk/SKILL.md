---
name: orca-talk
description: Reach another agent working on the same fleet — to warn them about something they are about to walk into, hand work over with its context, tell them what you found out, or ask them something only they know. Use when the thing you need is in another agent's head or another repo, not in the human's. Also use before touching a file, to check whether someone else is already in it.
---

# Talking to the other agents

You are one of several agents running under ORCA, across several repos. The
others cannot see your terminal and you cannot see theirs, but you can reach
them — and reaching them is almost always better than reaching the human.

Everything routes through ORCA's CEO, which sees the whole fleet. It may answer
on the recipient's behalf if it already knows, hold the message until they are
between turns, or pass it straight through. You do not need to know which.

## Read your mail first

```bash
orca-read
```

Do this **at the start of a task, and again before you touch a file someone
else might be in**. Another agent may have warned you off a file, handed you
half a job, or told you something that changes what you are about to do. Acting
on stale information you could have avoided is the cheapest mistake there is.

## The four things you can send

```bash
orca-tell "<one line>" [--to <who>] --kind <kind> [--file <path>] [--wait]
```

**`--kind warning`** — they are about to walk into something.
> `orca-tell "No toques wrangler.jsonc, lo estoy reescribiendo" --to T1 --kind warning --file wrangler.jsonc`

The most valuable one, and the most underused. If you are about to spend twenty
minutes rewriting a shared file, say so *before* you start, not after somebody
else's work is gone.

**`--kind notice`** — you found something out that outlives you.
> `orca-tell "El endpoint /v1/charges devuelve 402 en sandbox desde hoy" --kind notice --file src/api/charges.ts`

Facts about the world, not about you. "The sandbox rejects test cards over
$500" is a notice. "I finished the refactor" is not — nobody needs it.

**`--kind handoff`** — this is now somebody else's, and here is what they need.
> `orca-tell "Terminé el cliente HTTP; falta cachear y reintentos" --to project:dijosi --kind handoff --file src/lib/http.ts`

A handoff without context is an abandonment. Say what is done, what is left,
and what you would have done next.

**`--kind ask`** — you need something only they know.
> `orca-tell "¿El worker de correo espera el payload plano o anidado?" --to K9 --kind ask --wait`

With `--wait` you block until it lands. **An unanswered ask makes you a link in
a chain** — if someone is waiting on you while you wait on them, the human sees
that chain and it counts against your project. So ask only when you truly cannot
proceed, and never with `--wait` on something you could work around.

## Who to address

- `--to K9` — one agent, by the callsign the console shows
- `--to project:dijosi` — everyone working in that repo
- omit `--to` — the whole fleet. Use this sparingly; it is a broadcast, and a
  broadcast that did not need to be one trains everyone to ignore the next.

## Another agent, or the human?

This is the judgement that matters.

**Another agent** when the answer lives in the work: how a module they wrote
behaves, whether a migration ran, what shape an API they own returns, what they
are in the middle of.

**The human** (`orca-ask`) when the answer lives in a person: a preference, a
priority, a business decision, a credential, permission to do something
irreversible.

When in doubt, ask the agent. The human's attention is the scarcest thing in
this system; another agent's is not.

## What not to send

Status updates. Acknowledgements. "Working on it." "Thanks." Anything the
console already shows — your state, your current tool, your spend, what you
spawned. Every message costs somebody a read; a message that carries no
decision is a message that taught them to skim the next one.
