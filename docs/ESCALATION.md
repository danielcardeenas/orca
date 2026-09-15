# The agent → human channel

A Claude Code agent has no socket to ORCA. It has a filesystem. That is why the
channel for asking a human something is a mailbox of files inside the project
itself, and not an API.

```
<project>/.orca/ask/<id>.json            the agent asks
<project>/.orca/ask/<id>.answer.json     ORCA answers; the agent polls
```

The collector watches that folder in every project it knows about (`fs.watch` +
a 1s poll), turns each question into an `Escalation` from the contract and emits
it to the hub as `{t:'escalation'}`. The answer travels back through the command
`{k:'answer', escalationId, answer, rememberAs}`.

This document **is** the contract. The CEO runtime and the agent skill depend on
it; changing it without changing all three sides breaks the channel.

---

## 1. Asking

The agent writes a JSON file to `<project>/.orca/ask/<id>.json`. The `<id>` is
chosen by the agent: anything that is a valid filename and does not end in
`.answer` (a uuid, a timestamp, a slug of the question).

```jsonc
{
  // REQUIRED. One single question, on one line. It is what the human will see
  // in the console's interrupt, so it has to be answerable without opening
  // anything else.
  "question": "Do I use Stripe or Mercado Pago for the pilot?",

  // Optional. Context so the human can answer fast and well.
  // It goes below the question in the console. It can be multiline.
  "context": "The client invoices in MXN and already has a Mercado Pago account.\nStripe charges 3.6% + VAT here.",

  // Optional. Suggested answers, 12 maximum. The console paints them as
  // one-press buttons. Keep them short: they are labels, not paragraphs.
  "options": ["Stripe", "Mercado Pago", "Both, behind one interface"],

  // Optional, default false. true = the human can ONLY pick an option.
  // It only has an effect if `options` is not empty. Use it when free text
  // is of no use to you (a binary decision, an enum).
  "optionsOnly": false,

  // Optional, default "normal". "low" | "normal" | "blocking".
  // "blocking" means: I cannot move forward on ANYTHING without this.
  "urgency": "blocking",

  // Optional but STRONGLY recommended. The sessionId of whoever is asking, so
  // the console knows which agent the interrupt belongs to. Without it the
  // collector attributes it to the project's most recently active agent,
  // which with several agents in the same repo can get it wrong.
  "agentId": "78b357fe-4480-419f-bd99-7b5d7980e7fd",

  // Optional. Minutes after which the question withdraws itself.
  // Use it if you are going to die waiting; it avoids zombie interrupts in
  // the console.
  "ttlMinutes": 120
}
```

Rules the agent has to respect:

- **`question` is required.** A file without it is ignored (and a warning is
  logged). Nothing else is.
- **Write atomically.** Write to `<id>.json.tmp` and rename to `<id>.json`. The
  collector retries every second if it reads a half-written JSON, but a rename
  is free and removes the race.
- **`mkdir -p` the folder.** The collector does NOT create `.orca/ask/` — we do
  not want an observation daemon writing inside the user's repos without anyone
  asking it to. The first question is what creates it.
- **One question per file.** If you need three answers, write three files; they
  show up as three interrupts and are answered separately.
- **Add `.orca/` to `.gitignore`.** It is local state, not project code.

## 2. Waiting

The agent polls `<project>/.orca/ask/<id>.answer.json`. A pattern that works
inside a Claude Code session:

```bash
for i in $(seq 1 600); do            # 10 minutes at 1Hz
  [ -f .orca/ask/pago.answer.json ] && cat .orca/ask/pago.answer.json && break
  sleep 1
done
```

While the question is open the agent appears in the console as `blocked` with
`block.kind = "question"` and `block.escalationId` pointing at the escalation.
It is the only state the 3D scene is allowed to shout about.

## 3. The answer

When the human (or the CEO) answers, the collector writes:

```jsonc
{
  "answer": "Mercado Pago",              // what the human said, free text
  "at": 1788539532517,                   // epoch ms
  "answeredBy": "human",                 // "human" | "ceo"
  "rememberAs": "preferred gateway",     // null, or the name the human wants
                                         // this remembered under
  "id": "pago"                           // the <id> of the original file
}
```

...and it **deletes** `<id>.json`. That is the order, and it is deliberate: if
the collector dies between the two operations, the agent already has its answer
and the question would be re-emitted at most once. The other way round the
answer would be lost.

The answer is also written atomically (`.tmp` + rename), so the agent can never
read an incomplete JSON.

## 4. Withdrawing

If the agent resolves the doubt on its own, it **deletes its own `<id>.json`**.
The collector detects it on the next sweep and emits
`{t:'escalation:withdraw', id, reason}`, the interrupt disappears from the
console and the agent goes back to its normal state. Do not leave open questions
you no longer care about: each one is an interrupt to a human.

The same happens on its own when `ttlMinutes` expires.

## 5. Ids

The id that travels over the protocol is **not** the filename. The collector
derives a stable, global one:

```
esc_<sha1(absolute file path)[0..16]>
```

It is stable across collector restarts (the same file always produces the same
id) and it does not collide between projects that happen to have an `ask/1.json`
each. The agent does not need to know it: its own filename is enough.

## 6. What this channel is NOT

- **It is not a chat.** One question, one answer, done. For a conversation there
  is the CEO.
- **It does not answer Claude Code's permission prompts.** That is another thing
  (`block.kind = "permission"`), and today the CLI exposes no way to answer them
  from outside the process — see `docs/CONTRACT-REQUESTS.md`.
- **It does not carry secrets.** If you need a credential, ask the human to
  store it with `key:set`; it will reach the agent as an environment variable
  the next time ORCA launches it, without ever passing through a file in the
  repo.

## 7. Minimal example, end to end

```bash
# The agent asks.
mkdir -p .orca/ask
cat > .orca/ask/q1.json.tmp <<'JSON'
{"question":"Do I deploy to production or stay on staging?",
 "options":["Production","Staging"],"optionsOnly":true,
 "urgency":"blocking","agentId":"'"$CLAUDE_SESSION_ID"'"}
JSON
mv .orca/ask/q1.json.tmp .orca/ask/q1.json

# The agent waits.
while [ ! -f .orca/ask/q1.answer.json ]; do sleep 1; done
ANSWER=$(python3 -c "import json;print(json.load(open('.orca/ask/q1.answer.json'))['answer'])")
echo "the human said: $ANSWER"
```
