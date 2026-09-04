---
name: orca-ask
description: Ask the human operator a question and wait for their answer, when you are blocked on something only they can decide — a preference, a business call, a credential, an ambiguity where guessing wrong is expensive. Use when you would otherwise stop and wait, guess, or hand back an unfinished task with a question in the summary. Do NOT use for anything you can determine from the repo, the tests, or the tools you already have.
---

# Asking the human

You are running under ORCA, a fleet console. The person who started you is not
watching this terminal — they are watching a console that shows every agent
across every machine at once. This skill is how you reach them.

Your question goes first to ORCA's CEO agent, which tries to answer it from what
the human has already told it. Only if it cannot does the question reach the
human as an interruption. So asking is cheap when the answer is already known,
and it is the right move when it is not.

## When to ask

Ask when the answer lives in the human's head and nowhere else:

- a preference you have never been told (which library, which pattern, which name)
- a business or product decision (ship now or wait, which customer comes first)
- a credential, an access grant, or permission to touch something real
- an ambiguity in the brief where guessing wrong costs an hour or does something
  hard to undo

**Do not ask** when you could find out. Read the repo. Run the tests. Check git
history. Look at how the neighbouring module does it. An agent that asks what it
could have read is worse than one that guesses, because it spends the one
resource that does not scale: the human's attention.

**Do not ask** and then stop. Ask, then keep working on everything that does not
depend on the answer. Come back to the blocked part when the answer lands.

## How to ask

```bash
orca-ask "Which payment provider for the pilot?" \
  --context "The client invoices in MXN and already has a Mercado Pago account. Stripe charges 3.6% + tax here." \
  --option "Stripe" \
  --option "Mercado Pago" \
  --option "Both, behind one interface" \
  --urgency blocking \
  --wait
```

`orca-ask` lives at `<orca>/bin/orca-ask.mjs`. If it is not on your PATH, run it
directly:

```bash
node /path/to/orca/bin/orca-ask.mjs "…" --wait
```

With `--wait` the command blocks and prints the answer on stdout when it
arrives, so you can read it and carry on in the same turn. Without `--wait` it
prints the question id and returns; poll later with
`orca-ask --check <id>`.

If ORCA is not running, `orca-ask` says so and exits non-zero. That is your
signal to fall back to normal behaviour: state the assumption you are making,
proceed, and flag it in your summary.

## Writing the question

The human is often on a phone, standing up, with four seconds of attention. The
whole craft is in making a question answerable in that window.

**One question.** Not three. If you have three, ask the one that unblocks the
most and infer the rest.

**No preamble.** Not "I was working on the auth module and I noticed that…".
Just the question. The console already shows them who you are and what you were
doing.

**Options whenever the answer is a choice.** They render as one-tap buttons. A
question with options gets answered in seconds; an open one waits for hours.
Keep them short — they are labels, not sentences.

**Context is for deciding, not for explaining yourself.** Two or three lines of
what actually bears on the choice. Costs, constraints, what breaks either way.
Never a narrative of what you have been doing.

**Urgency is a claim you must be able to defend.** `blocking` means you have
genuinely stopped — nothing else in your brief can proceed. If you can keep
working on something else, it is `normal`. Overusing `blocking` trains the human
to ignore it, and then the one time it is true they miss it.

## Good and bad

```
BAD   "What should I do about the tests?"
GOOD  "The auth tests hit the real Stripe sandbox. Mock them, or give me a
       test key?"  --option "Mock them"  --option "I'll add a test key"

BAD   "I need clarification on the deployment approach before proceeding."
GOOD  "Deploy staging to workers.dev or staging.axolots.ai?"
       --option "workers.dev"  --option "staging.axolots.ai"

BAD   "Which file should I put this in?"          ← read the repo
BAD   "Should I write tests?"                     ← yes
BAD   "Is it okay if I continue?"                 ← just continue
```

## After the answer

The human's answer may be recorded as a standing rule, so the same question
never reaches them again. That makes it worth acting on the *rule* they gave,
not only the instance: if they say "test keys on staging, always", apply that
everywhere it holds, not just to the line that prompted you.
