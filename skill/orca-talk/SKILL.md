---
name: orca-talk
description: Reach another agent working on the same fleet — to warn them about something they are about to walk into, hand work over with its context, tell them what you found out, or ask them something only they know. Use when the thing you need is in another agent's head or another repo, not in the human's. Also use before touching a file, to check whether someone else is already in it. Also covers squads: reporting to your lead, a lead handing work to its members, and asking ORCA to launch another agent that works for you.
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

## Showing something instead of describing it

```bash
orca-show <path> [title] [--open]
```

When what you produced is a picture — a chart, a screenshot, a generated page —
`orca-show report.html "Bundle size, before and after"` puts it in front of the
operator instead of a path they have to go open. ORCA already picks up most
images, svg, html and markdown you write; use this when it matters *which* file
is the one to look at, or when its name does not say what it is.

`--open` asks for it to be opened rather than just filed. It is a request, not a
guarantee — the console decides. Spend it on the one thing they have to see, not
on every screenshot: an `--open` that did not need to be one teaches them to
close the next without looking.

## Who to address

- `--to K9` — one agent, by the callsign the console shows
- `--to project:dijosi` — everyone working in that repo
- `--to squad:audit-01` — everyone in that squad, wherever they are running
- omit `--to` — the whole fleet. Use this sparingly; it is a broadcast, and a
  broadcast that did not need to be one trains everyone to ignore the next.

## If you are in a squad

You will know: your prompt ends with a short ORCA footer saying which squad you
belong to and who leads it. If it does not, you are not in one and this section
is not about you.

**If you are a member.** Your lead is your human. Report what you find with
`orca-tell "<one line>" --to <their callsign> --kind notice`, hand finished work
over with `--kind handoff`, and when you are genuinely stuck on something only
they can settle, `--kind ask --wait`. Do **not** use `orca-ask` — the person is
your lead's to interrupt, not yours. Read `orca-read` at the start of every
turn: the lead redirects the squad through it, and working on last turn's
instructions is the failure mode this whole channel exists to prevent.

**If you are the lead.** Your members arrive as your children and report to you.
Hand work out one at a time with `--to <callsign> --kind handoff`, or reach all
of them at once with `--to squad:<name>`. Need another pair of hands? Ask for
one — see the next section — and it joins your squad as your child. Read `orca-read` every turn, unblock
your own people with `orca-tell --reply <messageId> "<answer>"` rather than
letting them wait, consolidate their findings into one answer, and use
`orca-ask` only when nobody in the squad can go further. You are the squad's
single point of contact: every question you forward is one a person has to stop
and answer.

## Asking for another agent

```bash
orca-spawn "<complete brief>"          # or: orca-spawn @briefs/charges.md
```

When a piece of your work is separable and would take you an hour, delegate it:
`orca-spawn` asks ORCA to launch an agent that is **yours** — spawned as your
child, in your squad if you are in one, never a lead — and prints its callsign
so you can address it. It reports to you with `orca-tell`; read `orca-read`
each turn to collect what it found.

Write the brief the way you would for an engineer who has not seen your
conversation: what to do, what done looks like, what not to touch. A thin brief
is refused before anything launches. You may have at most eight live children,
and a squad holds at most thirteen agents; past either, the answer says so and
you hand the work to the ones you already have.

Do not delegate what you could finish in the time it takes to write the brief.

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
