# Hygiene — what ORCA left behind in processes

**Mission:** `mission_mtskpgjhmnn5sbqp`
**Status:** implemented and verified, including a real run against the
operator's machine. **Not committed** (§8).

The message channel truncates, so this is the full report.

---

## 1. What the repository already covered

Before writing anything, what was there:

| Already existed | What it did | What it did NOT cover |
|---|---|---|
| `HygieneSampler` (`collector/hygiene.ts`) | Disk by category, volumes, CPU/memory, growth, and disk **candidates**. It measures processes, but **only the ones it already knows**: this collector and the agents with a pid in its liveness. | It does not discover processes. It knows nothing about Vite, or ports, or hung entrypoints. **It deletes and kills nothing** — the first hygiene delivery observes and previews, and says so. |
| `hub/harness.ts` + `purge_harness` | **The only process-killing capability there was.** It recognizes three harness programs and only the ones pointing at THIS hub. | Only the harness. A hung Vite or hub is invisible to it. |
| `hub/liveness.ts` (`isLiveAgent`, `ghostReason`) | The doctrine: **death demands positive evidence; life is the default**. It lets the hub call an agent finished, with a reason. | It reasons about the hub's world, not about the machine's processes. |
| `shared/archive.ts` + `agents:archive` | Archives finished agents, **ignoring the live ones**, by ids or by filter. | You have to know who to archive: nothing detected the ghost. |
| `transcripts:purge`, `stop`, `remove` | Delete transcripts, stop a session, retire a finished one. | All of them require somebody to already know what is surplus. |
| HYGIENE window | Disk report + `SAMPLE NOW`. | No action. |

**In one line:** ORCA measured disk very well and did not look at processes; it
could kill exactly three harness programs; and it knew how to archive agents
somebody named for it, with nothing to name them.

## 2. What has been added

A second half of hygiene: what ORCA costs in **processes and ports**. It
travels in the same report, over the same frame, in the same panel and on the
same slow clock.

Four classes of stray:

| | |
|---|---|
| `vite` | A dev server **of this repository**, identified by its **cwd** |
| `orca` | An ORCA entrypoint (`src/orca.ts`, `src/hub/server.ts`, `src/collector/index.ts`) |
| `pane` | A tmux pane whose program has already exited, or whose pid does not exist |
| `agent` | An agent still in the registry with positive evidence that its process is gone |

## 3. The rule, and why less will not do

**Killing demands positive evidence of orphanhood; not killing is the
default.** It is the asymmetry of `hub/liveness.ts` applied to processes:
leaving a stray alive costs memory and a port; killing a live one costs
somebody's work — and here "somebody" may be the dev server the operator has in
front of them.

**None of this is enough on its own**, and none of it enters the decision:
having been up a long time · being idle · not showing up in a heartbeat ·
holding an open port. There is a test that pins it down (`being old, idle or
holding a port is not evidence of anything`).

**Three checkable facts are required at once**:

1. **It is ours.** For a Vite, its **cwd** is this repository — never the
   program's name. There is a Vite in every project on the machine, and
   `pkill vite` is exactly what this module exists in order not to do. A
   `vite.config.ts` open in an editor does not count either: what is recognized
   is the **path inside `node_modules`**, not the word.
2. **ORCA launched it and its owner is gone** — a **lease** (§3bis). Not "it
   has no parent": that proves nothing.
3. **It is still the same one.** Pid **and start time** are checked again with
   a **fresh** `ps` read right before killing it — and with them the lease and
   the protections. A pid gets reused; killing by a pid read a minute ago is
   killing a stranger.

### 3bis. Why `ppid === 1` is NOT abandonment, and what replaces it

The first version of this delivery took a process for abandoned because it had
been reparented to init. **That is false.** `nohup npm run dev &`, `setsid`,
`disown` and any deliberately unattended start leave exactly that signature on a
**perfectly healthy** process, which may be serving another console on another
port. Offering to kill it was offering to kill somebody's server, and the only
protection there was was one's own console's port.

It is not fixed by guessing better: **you cannot know whether an unknown
process is surplus**. It is fixed by inverting the question.

**The lease** (`src/shared/lease.ts`). Whoever launches something records it in
`~/.orca/leases/<id>.json`: what was launched (pid **and** start time), from
where, which ports it serves, and **who launched it**. It renews it while it
lives and deletes it on a clean exit. An undeleted lease whose owner is no
longer around **is** the evidence: it means whoever launched it went away badly,
which is exactly when strays get left behind.

The rule ends up like this:

| situation | verdict |
|---|---|
| no lease | **`ambiguous`**. "ORCA did not launch this, so it cannot know whether it is surplus. Running with no parent is what `nohup`, `setsid` and `disown` leave behind." |
| lease renewed recently | **`protected`** |
| lease expired but the owner is still alive (pid + time) | **`protected`** |
| lease expired **and** owner gone | **`orphan`** — the only case with a button |

**The consequence, said out loud:** a Vite somebody started by hand, with or
without `nohup`, **can never be killed from here**. Only what ORCA launched
itself can be. It is less capability and it is the right one.

**Who writes leases.** `tools/lease.mjs` wraps a process and records it;
`npm run dev:ui` already goes through it, so the Vite from `npm run dev` is
collectable. Anything started outside of that carries no lease, and therefore is
not offered. The renewal interval is duplicated in that file because it is loose
JS, and there is a test that holds the two copies together.

**Other consoles of the same project.** What is protected is the **set** of
ports where a console is serving right now — this ORCA's and that of every live
lease — not just one's own. Looking only at one's own left the neighbor's
console on the killable list.

**On cleaning, everything is revalidated, not just the pid**: identity (pid +
time), that the lease is still expired and ownerless, and that the process has
not started serving a console. Any of the three returns it to untouchable, with
the reason.

Three verdicts, and all three are shown:

- **`orphan`** — it meets all three. It carries a button.
- **`ambiguous`** — it is ours but something does not add up: unreadable cwd,
  live parent, no start time, **or no ORCA lease**. **Shown and not touched**,
  and the panel says what it is that ORCA cannot know instead of faking a
  diagnosis.
- **`protected`** — recognized and left alone, **with the reason**: the hub, the
  collector, ORCA itself, the Vite serving this console, another project's Vite.
  They are listed on purpose: a panel that only shows what it is going to kill
  gives you no way to check why everything else was spared, and that check is
  the only real control over an operation that kills processes.

**What is explicitly protected:** this process and its parent · the hub and the
collector · CAPCOM and every live agent (their pids go in as untouchable) · the
Vite on this console's port · any cwd outside the repository · other machines (a
stray only exists on one, and the command carries its `machineId`).

**A ghost agent is RETIRED, not killed.** There is no process to kill, and
pretending otherwise would be the one way to get this wrong. The action goes
through the flow that already existed: `agents:archive` with their ids, which
ignores the live ones on its own.

## 4. Killing, politely and without lying

`SIGTERM` → wait 4 s → `SIGKILL` only if it is still there. A Vite closes its
port and its watchers on `SIGTERM`; killing it outright sometimes leaves the
socket held, which is precisely the resource you wanted to free. Every result
says what actually happened: `stopped` (with the signal it took) · `refused` (it
did not pass revalidation, with the reason) · `gone` (it was not there any more:
killing it **is not faked**) · `failed` · `retired`.

`dryRun` does all the checks and sends no signal.

## 5. Automation: none, on purpose

The existing hygiene policy is explicit: *"this release observes and
previews"*, and `PROTECTED` exists so that nothing recoverable becomes a
candidate. Nothing in this delivery kills a process on its own: **the button is
the action**. I have not added an `autoclean` or an environment variable to turn
it on, because extending a policy of "deletes nothing" to "kills processes by
itself" is not a decision that belongs to this delivery.

## 6. The real run, and what it broke

Against the operator's live hub and collector, with a disposable probe: a
two-line `node` at `~/projects/orca/.orca/strays-probe/node_modules/.bin/vite`,
launched by a shell that then leaves — so it is genuinely orphaned, not
simulated — with its cwd inside the repository.

**Result:**

```
sonda plantada: pid 21658 (cwd ~/projects/orca/.orca/strays-probe)
sonda detectada como orphan/terminate
— clean — { ok: true, detail: "1/1 terminado(s)",
            data: [{ result: "stopped", signal: "TERM", detail: "exited on SIGTERM" }] }
sonda viva tras limpiar: false
no ofrecidos (y por tanto intactos): 5
  orca · src/orca.ts            pid=62467  → sigue vivo
  orca · src/orca.ts            pid=93251  → sigue vivo
  orca · src/collector/index.ts pid=13533  → sigue vivo
  orca · src/collector/index.ts pid=62457  → sigue vivo
  vite · :4478                  pid=62458  → sigue vivo
```

The operator's real Vite came out `protected` with the reason *"this is the
console you are looking at"*, and the two collectors with *"this is ORCA
itself"*.

### What the run broke, and is fixed

**27 live agents marked as ghosts.** The first version took a `thinking` agent
for a ghost when the CLI does not list it and it has neither pid nor pane.
Against the real fleet that was **27 agents, all alive**, for two reasons that
are the same reason:

1. `pid === null` means **"ORCA never knew its pid"** — the norm in a `--bg`
   session — and not "its process does not exist". Treating a missing datum as
   proof of death is exactly the mistake `hub/liveness.ts` documents.
2. A **freshly started** collector has not looked at anybody's liveness: its map
   is empty and the whole fleet looks dead. And the collector restarts on every
   edit under `tsx watch`.

Fixed: a ghost now demands **positive evidence** — a **known** pid that is not
in `ps`, or a pane it claimed to have that is not in the tmux server — and
nothing is asserted until liveness has been looked at at least once
(`livenessReady`). After the fix, on the same machine: **0 ghosts**, 9 strays
listed, none offered for killing.

**Second finding:** the hub's `sanitizeReport` rebuilds the report field by
field, so it was dropping `strays` silently. Now it validates them like
everything else — and more carefully, because every row ends in a button that
kills something: an unknown `verdict` cannot turn into `orphan` through
carelessness, and an absolute path does not cross because it carries the
operator's name.

**Third:** on macOS `/var` is a link to `/private/var`, and `lsof` always
returns the real path. Without resolving links, a process's cwd and the root it
is compared against are two different strings for the same directory: the
detector would have found nothing, **silently**. It came out in the suite
against real processes, not from reading the code.

## 7. Tests

**`npm run typecheck`** — clean. **`npm test -- --changed` → 909/909**, 0
failures.

**`npm test -- strays` → 32/32**, in two suites.

`strays · what ORCA left behind` (22, with hand-written `ps` output):
`ps` is read into numbers · a Vite is recognized by its path and not by the word
(`vim vite.config.ts` and `vitest` do not count) · the entrypoints are
recognized and `test/*` is left to its own tool · a reparented Vite from this
repo is an orphan · **another project's Vite is never ours** · with no readable
cwd it is ambiguous · with a live parent it is ambiguous · **ORCA never offers
itself, nor its parent, nor an agent** · this console's Vite is protected by its
port · with no start time there is no target · **old, idle and holding an open
port is still not anything** · the rest of the machine is invisible · the
orphans go first · a recycled pid is rejected, and four seconds of clock drift
is not a recycling · **a `nohup` Vite from this very repo on an alternate port
is NEVER offered** · an ORCA entrypoint gets the same caution as a Vite ·
**another live console of the same project is protected**, not just one's own
port · a fresh lease protects · an owner that came back protects · a lease for a
recycled pid authorizes nothing · the lease writer's renewal interval and the
contract's match.

`strays · against real processes` (10, **real and disposable processes**, all
under a temporary directory standing in for the repository, so the real fleet is
out of reach **by construction**): **only the one with a lease whose owner is
dead is offered**: the one with a live parent, the lease-less `nohup` and the
one from another project, no — and the dead owner is a process that really
existed and ended, not an invented number — · cleaning really does kill it, and
`dryRun` leaves it alive · one that ignores `SIGTERM` is escalated to `SIGKILL`
and it says so · **a pid that died between the scan and the click is not killed
blindly** · **a recycled pid is rejected and the process stays alive** ·
cleaning something the scan did not offer is refused · **a quiet agent is not a
ghost** · a collector that has not looked declares nobody · a real ghost is
retired without touching any process · nothing outside the sandbox is a target.

**`npx tsx test/hyg-strays.shots.ts`** — passes. It checks in the browser that
the three classes are visible with their mark, that **only the orphan carries a
button**, that `CLEAN n` counts orphans only, that the evidence opens and reads,
that the protected ones say why, that the ordering puts the decidable at the
top, and that the disk report keeps its place.

## 8. Files

**Not committed**, in the tree shared with Q8.

**New (7):** `src/shared/lease.ts` (the lease contract) ·
`src/shared/strays.ts` (pure rules) · `src/collector/strays.ts` (machine reads
and killing) · `tools/lease.mjs` (the writer) · `src/ui/styles/strays.css` ·
`test/strays.test.ts` · `test/strays-live.test.ts` ·
`test/hyg-strays.shots.ts`.

**Touched, additive:** `shared/hygiene.ts` (`strays?` in the report) ·
`shared/protocol.ts` (`strays:clean`) · `hub/hygiene.ts` (validation) ·
`hub/server.ts` (per-machine route, summary, allowlist) ·
`collector/{index,commands}.ts` · `ui/windows/kinds/hygiene.ts` (**one new block
at the end of the body**; the header was not touched, nor the summary, nor
`SAMPLE NOW`, nor the legend, nor `machineBlock()`, nor `paint()`) ·
`ui/main.ts` (one import line) · `package.json` (`dev:ui` goes through the lease
writer) · `test/visual.ts` (two hooks).

**Coordination with Q8:** I gave notice before touching `hygiene.ts`; he replied
that he does not have it open and to go ahead. **Not touched:** `window.css`,
`hud.css`, `sections.ts`, `missions.ts`, `mission-status.ts`,
`windows/kinds/mission.ts` or `controls.ts`. The new styles go in their own
sheet for exactly that reason.

## 9. Activation

- **Active as soon as the collector starts**: the scan rides with the hygiene
  sample, on its ten-minute clock, and with `SAMPLE NOW`.
- **It does nothing on its own.** The section appears only if there is something
  to show, and the button belongs to the operator.
- Without `lsof` (or on Windows) the cwd cannot be read and **everything comes
  out ambiguous**: it degrades to offering nothing, which is the right side.

## 10. Limits

1. **macOS and Linux.** On Windows `readProcs` returns empty and there are no
   strays.
2. **The cwd depends on `lsof` on macOS.** Without it, every Vite is ambiguous.
   There is deliberately no second, "approximate" path: what cannot be
   identified is not touched.
3. **Only what ORCA launched is collected.** A Vite started by hand, with or
   without `nohup`, will never be killable from here — and neither will a stray
   from before this delivery, because it has no lease. It is deliberate: the
   alternative was guessing an unknown process's intent, and you cannot.
4. **There is no time bound between revalidating and killing.** `ps` is read and
   the signal is sent in the same instant, but a process can die and its pid be
   reused in that window. It is a microsecond race and it cannot be closed
   without `pidfd`, which does not exist on macOS; it is said here.
5. **Ghost agents depend on ORCA having known a pid or a pane.** A `--bg` whose
   pid was never known and with no pane cannot be declared dead — and that is
   deliberate after what happened in §6.
6. **Nothing is automated** (§5).
7. The real run killed **one** disposable probe. No real process of the
   operator's has been killed, and the scan on his machine found no orphans to
   offer.
8. **The production run in §6 was done with the old rule** (`ppid === 1` was
   enough). It has not been repeated: the fix is covered by fixtures against
   **real processes** — including a legitimate `nohup` from the same repo on an
   alternate port, excluded, and a process with a genuinely dead owner, eligible
   — and repeating it would have killed processes on the operator's machine
   again without adding anything those tests do not already say.

## 11. How to verify it

```
npm run typecheck
npm test -- strays                  both suites (26)
npx tsx test/hyg-strays.shots.ts    the section, photographed
```

Filters that cover this delivery: `strays`, `hygiene`, `collector`.
