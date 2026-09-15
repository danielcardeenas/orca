# The harness in quarantine

`npm run mock` connects to the real hub on 4479 if nothing stops it. Someone
started it to photograph the workspace island and left it running for fifteen
minutes. Its fixture agents escalate questions — "Should I upgrade three.js to
0.185?", "Which database should the migration target?" — the hub had no way to
tell an invented escalation from a real one, and it routed every one of them to
the real CAPCOM: nine straight minutes answering them, context from 100% down
to 10%, one compaction along the way.

And the loop that makes it worse: photographing that island **requires**
starting the mock, so working on the harness was what burned the command
session working on the harness.

## The mark, which is what always protects

A machine declares itself `synthetic: true` in its `hello`. The mark is set by
whoever deserves it — `test/fake-collector.ts` — and the hub believes it,
because it is a declaration that **only removes permissions**: nobody gains
anything by declaring themselves fake. That is what makes it safe to accept off
the wire, and what keeps it standing even if someone starts the mock by hand
against whatever port, which is exactly how it happened.

The rule is not a filter over CAPCOM but a **symmetric quarantine**: the
synthetic and the real do not talk to each other in either direction.

- **Escalations.** `CapcomRouter.offer` does not offer one to the command
  session if it comes from the other world. That goes for `sweep` too, the one
  that re-offers whatever is still pending on every pass: without it, a hundred
  and thirty dead questions came knocking again every minute. One line is
  recorded in the feed per machine, not one per question.
- **Messages between agents.** A `squad` is resolved by label and by nothing
  else, so a synthetic squad named like a real one was pasting the message into
  real agents' panes. Now it does not cross. The exception is the operator
  (`fromAgentId: 'ceo'`, with no machine behind it): the human's voice commands
  over the harness too.

What the harness needs is not lost: the synthetic question **stays in the
world, `pending`**, which is exactly what has to be visible and photographable.
And if one day the mock brings up its own CAPCOM, everything works inside its
own world.

The mark is sticky: a machine that already declared itself a fixture does not
leave quarantine because a reconnection arrives without the mark.

## The gate, now guarded by the hub

The first version of this gate lived in the client: the mock asked
`/api/health` whether there was a live command session and refused to start. It
lasted a day. On 2026-09-07 someone answered it with `--anyway` — the flag
exists for the legitimate case — and put **~1,330 synthetic agents and seven
fake projects** into the operator's console, with over a thousand dollars of
fictional spend in the counters; `list_fleet` went from 2 KB to 121 KB and
stopped being any use to CAPCOM.

The lesson is not that a check was missing: it is that the check was performed
by **whoever wanted in**. A guardrail you can answer with a flag is a question,
not a guardrail.

So the decision moved to the hub and was inverted. **The harness no longer asks
permission: it is the hub that has to declare itself a test hub.**

- A test hub is born with `ORCA_HARNESS` in its environment. It is set by
  `test/run.ts` (the whole `npm test` run), by `test/visual.ts` when it brings
  up its own, and by the mock's own `--isolated`. `npm start`, `npm run dev`
  and the operator's service **do not have it and there is no flag that grants
  it**: it is the one thing the harness cannot fake from the other side of the
  wire.
- A `hello` with `synthetic: true` against a hub that does not declare itself a
  test hub is closed with **4004** (`CLOSE_NOT_HARNESS`) and a line in the log,
  *before* touching the world. Not one agent, not one project, not one dollar
  gets to exist.
- `/api/health` publishes `harness: true|false`, so whoever is about to connect
  can refuse on its own with a useful message instead of crashing into a close.

### What `--anyway` does now

It still exists **for what it was invented for**: a *test* hub that already has
a live CAPCOM inside it. It stopped being a master key.

```
$ npx tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway
[fake] ws://127.0.0.1:4479: ese hub NO se declara de pruebas, así que no admite máquinas sintéticas.
[fake] --anyway no sirve para esto y el hub cerraría la conexión de todas formas.
[fake] usa --isolated: levanta un hub propio, con su ORCA_HOME y su puerto.
```

The rule lives entirely in `doorVerdict()`, a pure function the test
interrogates without bringing anything up. A hub that **does not answer** does
not open either: not knowing what is on the other side is exactly the case
where you do not start.

`--isolated` gives you a whole world of your own — its temporary `ORCA_HOME`,
its port, its hub, already marked — and tells you how to point a console at it.
It is the same isolation and the same words as `test/visual.ts --isolated`, on
purpose.

The two gates say the same thing and neither is redundant: the client's
explains the way out, the hub's is the one you cannot skip.

### The visual harness stopped sharing the operator's hub

`test/visual.ts` reused `npm run dev`'s 4479 and started a synthetic fleet on
top of it with `--anyway`. That was the way in. Now `sharing()` only reuses it
if it is going to plant fixtures **and** that hub declares itself a test hub;
otherwise it brings up its own and leaves the operator's as it was. A run that
does not need a fleet (`--fleet=false`) can still share: it injects nothing.
`test/field-stress.ts` declines the standard fleet because it starts its own,
sized to fit, so it says so separately: `{ fleet: false, fixtures: true }`.

`test/visual.ts` recognizes the synthetic fleet by the mark and not by the
machines' names: the hub has to know which ones are fixtures anyway, and
comparing hostnames would break silently the day the mock gets renamed.

### And a test hub does not write into the real one's directory

The gate decides which machines get in; it said nothing about where the hub
writes. A test hub started without its own `ORCA_HOME` — the one from
`test/visual.ts` without `--isolated`, and the one from every `npm test` suite
that brought up a hub without giving it a store — wrote its journal, its
events, its missions and its self-improvement board into `~/.orca/hub`, the
real hub's. On 2026-09-11, 290 of 329 launches in the 24 h journal were from
fixture machines, and the AUTOMEJORA report was measuring tests.

- **The hub refuses.** `startHub` with `ORCA_HARNESS` over the operator's
  `ORCA_HOME` — by default, by name, or through a link that ends up there —
  does not start, and says so on the way out (`harnessHomeRefusal`,
  `src/hub/harness.ts`). Before opening a single file. There is no flag that
  skips it.
- **Harnesses isolate themselves**, which is what keeps the usual usage
  working: `test/run.ts` gives the whole run a temporary `ORCA_HOME`, and
  `test/visual.ts` gives one to every hub it brings up, with `--isolated` or
  without it. Whoever reuses a hub that already serves changes nothing.
- **The journal does not record the harness**, not even in a test hub:
  `createJournal` discards every entry whose machine declares itself
  `synthetic`. By the mark, not by names.

Refusing **and** isolating was chosen instead of one or the other. Refusing
alone would have broken the default path of `npm run visual` and the suites
that bring up a hub without a store; isolating alone would have left the rule
in the client, which is exactly what failed on 2026-09-07. This way current
usage stays the same and forgetting to isolate is a failure at startup, not a
week of mixed data. The only thing that stops working is an `ORCA_HARNESS=1` by
hand over `~/.orca`, and the message says what to do.

## Containment, in case something gets in anyway

The gate stops it from getting in. This is what you do when it **already got
in** — a hub that ran without the gate, a world persisted from before. Until
now the only way out was killing the process by hand and archiving agent by
agent: 1,330 fixtures, one at a time.

`purge_harness`, a CAPCOM MCP tool, does both in one call and in the only order
that works:

1. **Stops the harness processes** that point at *this* hub —
   `fake-collector.ts`, `visual.ts`, `field-stress.ts` — SIGTERM first so the
   mock can make its orderly retreat, SIGKILL only for whoever ignores it.
2. **Purges the world** (`World.purgeSynthetic`): marked machines, their
   agents, their projects, their questions, their artifacts, their collisions
   and their tombstones.

The order is not a detail: a live mock replants its three machines as soon as
you purge underneath it. That is why it is **one** tool and not two — between
two calls there was room for exactly the race that makes the first one
pointless.

The scope is the mark and only the mark. A real agent on a real machine is not
touched even if its project has the same name as a fixture one: **the machine
is the anchor, the name is not**. And on the process side, it only recognizes
three programs and only kills the ones pointing at this port; `test/run.ts` is
off the list on purpose — `npm test` puts nothing into the hub and killing it
would throw away another agent's verification — and an `--isolated` is not
touched either, because it has its own world.

This is also the answer to *"I need CAPCOM to be able to do that kill"*: it was
not given a `Bash(kill:*)` in its `settings.json`. `--allowedTools mcp__orca`
already covers this tool, so a newborn CAPCOM has it without **any** new
permission — and what it has is an operation that does not know how to kill
anything else. A shell `kill` could have taken any pid on the machine.

What it does **not** wipe: the feed. Its lines carry no machine, so there is no
way to tell them apart; the strip is bounded and empties itself.

### The day containment killed an agent

On 2026-09-09, in one heartbeat, CAPCOM called `purge_harness` and the tool
stopped agent **DH** (`pid 68523`) — the one who had built this very boundary.
It reported `stopped: test/fake-collector.ts how=term` and `removed: 0`: not
one synthetic machine, because there were none. Only the agent.

The rule at the time was a substring inside a line:

```ts
const script = HARNESS_SCRIPTS.find((s) => command.includes(s));
```

`command` is the whole `ps` line, and DH's brief quoted literally
`tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway`. A
prompt travels on the command line, so both conditions were right there: the
script and the real hub's port. Both read out of a sentence. And the shot went
to the **group** (`kill(-pid)`) without checking whether that pid led it, so
the scope was not even the process it thought it was killing.

An `includes` over a `ps` line does not distinguish **running** from
**naming**, and in a fleet of agents that talk about the repo, naming is
constant: an editor open on the file, a `grep`, a brief, this very document on
someone's screen. The fix is to look at the structure, not the text:

- **who the executable is**: a short allowlist of interpreters (`node`, `tsx`,
  `npm`, `npx`, `bun`, `deno`). `claude`, `codex`, `zsh`, `vim` and anything
  else are out by not being on it, even if they carry the script's name in
  their arguments;
- **what position the script is in**: it has to appear as the file being
  executed, comparing by path segments — `test/fake-collector-notes.ts` and a
  `.bak` no longer get through — and with only preamble in front of it
  (options, loaders, `npm exec`). The first loose word of a prompt breaks the
  shape;
- **where `--hub=` and `--isolated` are read from**: from *the script's*
  arguments, never from the whole line. That is what stopped a piece of text
  from declaring the real hub's port.

And before each signal, two checks that did not exist: the pid is **re-read**
and the same rule is applied to its current command — between the snapshot and
the shot the number may have changed owner; if it no longer classifies, it is
reported as `changed` and nothing is sent to it — and the group is signaled
**only if the pid leads the group**. Signaling `-pid` for something that does
not lead it reaches its siblings, its shell and its pane: the point here is to
stop a process, not a session.

#### The gate left open by closing the first one

The structural rule allowed, between the interpreter and the script, any loose
module: a token ending in `.js`, `.mjs` or `.cjs`, or any path with
`node_modules`. It was there for a good reason — the mock's real form loads
two, `--require .../preflight.cjs` and `--import file://.../loader.mjs` — but
it put something into the preamble that is not a loader. **A loose module is
the program**, and what comes after it are its arguments.

With that, the whole incident fit again through another door:

```
node .../claude/versions/2.1.266/cli.js --print «arregla test/fake-collector.ts --hub=…»
node tools/report.js test/fake-collector.ts
```

The first is again an agent being told about the harness — an executable from
the allowlist, `cli.js` slipping in as preamble, `--print` as an option, and
the prompt supplying script and port; the second, any tool that receives the
path as an argument. Measured against the code of that first fix: both came out
flagged.

Now a module only counts as preamble if a load option asked for it (`-r`,
`--require`, `--import`, `--loader`, `--experimental-loader`). The four real
forms of the mock — `tsx` as the executable, node's pair of loaders, `.bin/tsx`
and `npm exec tsx` — are still recognized, which is the half you cannot lose
while fixing the other.

#### And the third: stop enumerating what is forbidden

What remained was a flat list where node reads a grammar. The rule walked the
tokens and, as soon as it saw the script, assumed it was going to run; but a
`tok.startsWith('-')` does not distinguish an option from its value, nor a mode
that executes from one that does not. `node --check test/fake-collector.ts` —
what an editor runs on save — `node --print …` and `node --require
test/fake-collector.ts tools/report.js`, where the program is `report.js`, came
out flagged.

The first fix was to enumerate: a list of options that take a value and another
of options that do not execute. It closed nine cases and fell short at the
first review, because `--eval=0` and `-e0` carry the value attached and
`--title` is an option with a value nobody had put on the list. **Node's
options are an open set**: enumerating what is forbidden never ends, and every
gap is a false positive waiting.

So the rule stopped discarding and started **recognizing**. The whole contract
is five shapes, all taken from `ps` or from `package.json`:

```
tsx test/X.ts …                                    npm run mock / visual / stress
node …/.bin/tsx test/X.ts …                        what ps shows of the previous one
node --require …/preflight.cjs --import file://…/loader.mjs test/X.ts …
npx tsx test/X.ts …
npm exec [--] tsx test/X.ts …
```

Between the executable and the script there is room only for one load option
with its module — with `=` or separated — and the value has to end in `.cjs`,
`.mjs` or `.js`: a `.ts` is not a loader, and that is how `--require
test/fake-collector.ts` dies without needing to be named. Whatever does not fit
whole into one of the five is not touched, be it `--check`, `--eval=0`,
`--title`, `--max-old-space-size=4096` or whatever the next version of node
brings.

The price, stated on purpose: a legitimate startup with an option outside the
contract is not recognized, and that mock stays alive until someone stops it by
hand. `bun` and `deno` are not there either, because ORCA does not use them. A
surviving harness process is fixed in ten seconds; an agent that gets SIGTERM
is not. When a new shape actually shows up in `ps`, it gets added to the
contract with its own line in the matrix.

#### What happened to DH, and what was lost

None of his work. DH **finished fine**: the journal closes him as `done` at
`09-09 04:05`, after 37h12m and $10.26, with his delivery written up — "the
real hub is still standing, clean, with its CAPCOM alive". What he built is
whole in the tree: `src/hub/harness.ts`, this suite's tests and this very
section.

What was lost was the process, not the result, and it is worth saying it with
the same precision used to describe the failure: the tool fired at an agent it
had no business reaching, and that is serious for what could have happened — an
agent mid-job loses its session's context — more than for what did happen. The
world purge that came with the shot took away `0` machines: there were none to
take.

## Leaving without a trace

A real collector that shuts down leaves sessions that **still exist on disk**,
and the hub is right to keep them. The mock's do not exist anywhere: when the
process dies there is nothing left for them to correspond to. So now it
withdraws on SIGTERM or SIGINT — `agent:gone` for every agent,
`escalation:withdraw` for every open question — and waits for the socket to
close, because `process.exit` waits for nobody.

And on the hub's side: **the question leaves with the agent**. An agent that
has been evicted, archived, or whose session no longer exists cannot receive
the answer, so leaving it `pending` meant leaving a question in the human's
queue that is no longer any use to anyone. That is how the hub got to a hundred
and thirty.

The mock's decorative agents — the ones that produce the island outside the
fleet — go `pinned`: the recycler for finished agents does not touch them.
Before, they disappeared after twenty seconds, so the island you were about to
photograph emptied itself.

## The enclosure, which is what you see

The quarantine stopped the harness from costing anyone their command session.
It was still costing the screen: `npm run visual` brings up three fixture
machines with their projects, and those projects entered the spiral as real
islands — each in its slot, pushing the spacing of the real ones — while their
invented questions opened windows on top of whatever the operator was looking
at, three per batch. When the tests finished it all disappeared and the fleet
rearranged itself again. Working with the console in front of you while the
tests run was that.

Now the harness's stuff is drawn **beside**, not **among**:

- **One enclosure, not six islands.** Every fixture agent that came out of the
  same directory falls into a single island, `~harness/<slug>`, whether it is
  three machines or one. It takes no slot in the spiral and does not count
  toward its spacing, so the real fleet does not move half a millimeter because
  someone runs the tests — that is `harness-field`'s first test, and it is the
  one that matters.
- **Stuck to its host.** The harness declares in its `hello` which directory it
  came out of (`harnessOf`, the slug of its `cwd`), and the console plants the
  enclosure to the right of that project's island, flush with its top edge; if
  it does not fit there, it tries the other side, above, below, and as a last
  resort moves down until it clears. With no declared host it goes to the
  margin. The field labels it `~~ harness · orca`: whose tests these are, in
  one line.
- **Fenced in, and visibly so.** The enclosure carries a region's frame drawn
  twice, one wall inside another. It is the only thing in the field with a
  double line, so it reads as a fence and not as a plot from the zoom level
  where an island is a block, before any label has letters. The label chip
  repeats that double border, and so does the card for one of its questions.
- **Nothing of its own opens by itself.** An escalation or an artifact from a
  fixture machine does not open a window: nobody is waiting for that answer —
  the hub already has it in quarantine — and the operator pays for the window
  with their screen. It stays in the queue, dimmed and labeled `HARNESS`, and
  it opens if they open it. The card loses the amber: amber means "a person is
  needed here", and here nobody is needed.

The origin is only believed for a machine that already declared itself a
fixture. `synthetic` is a declaration that removes permissions and that is why
it is accepted off the wire; `harnessOf` only says where to draw, and accepting
it from a real machine would let anyone hang off someone else's project island.
It is kept the same way as the mark: a reconnection without it does not empty
an already-planted enclosure.

- **Nothing of its own makes a sound.** Its machines are born, die and ask at a
  rate that is nobody's: twenty tiles at once and a question every few seconds,
  for as long as the test lasts. The ear does not tell one world from the
  other, so a running harness turned the console's soundtrack into a continuous
  tone — that is, into nothing, which is the opposite of what it is for. Now
  the harness's birth, death, artifact and answer are mute, and the alarm only
  sounds if there is a real question waiting (`ui/hud/sound.ts`). It does not
  ring either: the full-screen amber ring — the most expensive gesture the
  console makes — is not triggered by a fixture blocking
  (`ui/hud/alarm.ts`). The lime screen flash is another thing and was never
  its: it comes from the LAUNCH window when the operator brings up a fleet, and
  from the hub link coming back.

What does **not** change: the harness still counts on the mast, in the alarm
and in the fleet's agent count — it is seen, not heard. Its questions stay in
the queue. Seeing something odd there is the reason you photograph the island
in the first place.

What **did** change is the money. The fleet's total spend —
`state.fleet.costUSD`, the one the HUD shows and `/api/health` publishes —
leaves out whatever agents on marked machines spent: that is where the
thousand dollars from the incident got in. Each project's rollup keeps its
figure, because the harness enclosure has to be able to draw its own, and
`list_fleet` still lists those projects — in a test hub they are exactly what
you want to look at — but with `synthetic: true` and a note attached to the
line: *test fixture: not a repository and not real spend*. Labeled, not hidden.

## Leftovers: the servers that outlived their run

The servers `test/visual.ts` brings up run `detached`, in their own group, and
that is deliberate: `npx` forks off the real process, and signaling only the
wrapper left a synthetic fleet talking to the hub forever. But what saves them
from a half-dead parent also saves them from a clean one: if the harness goes
away without being able to run its `shutdown` — a SIGKILL, an agent whose task
gets cut off, a `--keep` interrupted the hard way — its children keep serving.
And you do not notice: they pile up quietly. Measured on the operator's
machine: seven fifteen-hour Vites, each with its esbuild, plus an isolated hub
with its mock.

There is no signal that fixes that, because the process that would have to send
it no longer exists. So every run **writes down what it brought up**
(`$TMPDIR/orca-visual-runs/<pid>.json`: each server's pid and what it was
launched with) and the next one sweeps away whatever belongs to runs whose
owner is no longer alive. The sweep goes in `ensureServers`, before bringing
anything up, which is when it matters.

Two things make it safe, and they are the ones `visual-ports` tests:

- **A live run owns its own**, including a deliberate `--keep`: the owner's pid
  is checked before touching anything of theirs.
- **The pid alone proves nothing.** Numbers get recycled, and killing a third
  party over a repeated number would be much worse than leaving a Vite hanging;
  that is why the registry also stores what the process was launched with, and
  it is compared with what `ps` says about that pid today before sending it
  anything.

Orderly exits are covered where they were missing: `SIGHUP` (closing the
terminal) and `exit` (an uncaught throw) now shut down too, on top of `SIGINT`
and `SIGTERM`, which already did.

## Verification

```sh
npm run typecheck
npm run build
npm test -- --changed                     1098/1098 on 2026-09-09
npm test -- synthetic                     19/19, with the four from the incident
npm test -- synthetic harness-field visual-ports
npm test -- capcom hub messages traffic squads
npm test -- cli workspaces
npm test -- --changed
```

The boundary and the containment live in `synthetic`, each with its real
counterpart in every test so that a hub that rejected everything would not pass
them:

- a hub without the mark closes with 4004 and does not let the machine in; one
  with it accepts it — same `hello`, two stances;
- a **real** collector still gets into the hub without the mark;
- the whole `startFakeFleet` against a hub without the mark places not one
  machine;
- `doorVerdict` in its five cases, including the hub that does not answer;
- `purgeSynthetic` takes away the harness's stuff and leaves the real stuff
  intact;
- the fleet's total is $12 with a thousand dollars of fixture inside;
- `harnessProcs` over a ten-process `ps` snapshot picks four, including the
  mock's real form (`node --require …/preflight.cjs --import …/loader.mjs
  test/fake-collector.ts`), which if unrecognized would leave alive the one
  that actually gets in the way;
- **the incident, as a fixture**: agent DH's exact line, plus a `codex`, a
  `zsh -lc`, a `vim`, a `grep`, a `.bak` and a `…-notes.ts` — all naming the
  script and the real hub — are not flagged, and the only one that actually
  runs it is. With the previous rule, seven out of eight were flagged;
- **the contract, in a 54-line matrix**: the five real shapes are recognized —
  `tsx`, `.bin/tsx`, the loader pair with `=` and without it, `npx tsx`,
  `npm exec -- tsx` — and nothing else is touched: `--eval`, `--print` and
  `--check` in their four spellings each (separate, with `=`, short, short and
  attached), the options with values nobody enumerated (`--title`,
  `--stack-size`, `--max-old-space-size=4096`), the script placed as a load
  module, the programs that only name it, the name's neighbors, `npm run mock`
  and the runtimes ORCA does not use. Against the previous version, fourteen of
  those lines fell on the wrong side (40/54);
- the signal is looked at again before it is sent: whoever leads their group
  gets it at `-pid`, whoever hangs off someone else's group only at their
  `pid`, and the pid that became an agent in the meantime gets **nothing**
  (`how: 'changed'`).

The two tests that matter — the synthetic escalation that does not reach the
command session and the squad message that does not cross — go red if you
remove the guard; that was checked by disabling it. Each carries its real
counterpart in the same test, so that a hub that routed nothing at all would
not pass them.

Not covered by tests: `--isolated` and the actual sending of the signal by
`stopHarnessProcs` — who gets signaled and with what scope *is* tested, with
`identify`/`send` injected; that the operating system delivers it, no — were
exercised by hand, because that brings up real processes. The check against the
operator's hub, with the incident's exact command:

```
$ npx tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway
[fake] ese hub NO se declara de pruebas...                       exit 1

# and skipping the client, speaking the protocol by hand against 4479:
CERRADO code=4004 motivo=hub real: no admite máquinas sintéticas

# the real hub, before and after:  1 machine, 8 agents, 2 projects, $0.11
# the same mock with --isolated:   3 machines, 50 agents, 6 projects, $0.00
#   (harness: true, and $0.00 because all its spend stays out of the total)
```

For the enclosure, `harness-field` covers the three rules — the real fleet
still, a single enclosure, planted next to its host — over the layout, which is
where they live. What no test looks at is what can only be seen: the double
wall, the label and the queue's mark. That was checked by hand, against an
isolated world with the mock's fixture fleet and a real machine injected
through the published protocol — a project whose slug is the repo's, like the
one the harness declares — so as to have both things in the same field: the
island `OR ORCA · 6` and, stuck to its right and flush with its top edge,
`~~ HARNESS · ORCA · 22`. The separation of the two walls came out of that:
with half a unit of gutter they read as one thick line at the zoom where the
island fits on screen.

What that exercise uncovered, and is **not** part of this delivery: with the
factory preference (`origin: 'orca'`) the field hides the entire harness fleet,
because its agents arrive with no verified origin (`unknown`). In a browser
with a fresh profile — the one `test/visual.ts` opens — that leaves the field
empty: `waitForFleet` warns ("the fleet never populated the field") and five
frames are lost. With `origin: 'all'` in `localStorage` the 26 agents show up
and everything else fits. The natural fix is one line in the visual harness; it
was not touched here so as not to reach into a file three other agents were
using.
