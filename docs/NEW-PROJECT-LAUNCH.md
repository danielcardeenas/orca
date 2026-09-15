# Launching on a new folder

What happened on 2026-09-08, with the exact data. The operator asked for work on
`/Users/danielcardenas/projects/ventures`, just created. CAPCOM launched a squad
of five. All five started, painted Claude Code's native dialog

```
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
```

and there they stayed for twenty-five minutes. ORCA counted them as `blocked`
with the reason "waiting on its terminal: nothing has been painted for 20s with a
turn open", which is true and useless. The operator went looking for them with
`tmux ls` and got "no sessions", because ORCA's sessions live on their own
socket. And the project did not even exist for the hub: it had to be seeded by
running `claude -p` twice by hand.

Four failures, all from the same family: **ORCA knew something the agent or the
operator needed, and did not tell them — or told them badly.**

---

## 1 · Trust, before the spawn

`src/collector/trust.ts`, called from `CommandRunner.spawn` / `spawnPane`
(`src/collector/commands.ts`).

What was measured against Claude Code 2.1.263:

- `--permission-mode bypassPermissions` does **not** skip that dialog. Folder
  trust comes before tool permissions.
- While the dialog is on screen the CLI does **not create** its directory in
  `~/.claude/projects` — not with `--session-id` either. With no transcript there
  is no deriver, and with no deriver ORCA does not look at that pane.
- The state lives in `~/.claude.json`, in
  `projects["<real absolute path>"].hasTrustDialogAccepted`. The key is the REAL
  path: in this file everything under `/tmp` appears as `/private/tmp/…`.

### What was decided about `~/.claude.json`, and why

**ORCA writes the entry, right before launching, only for the exact path it is
going to launch on.** The reasoning, and why the scope is so narrow:

1. The dialog asks "do you trust this folder?" of a screen nobody is watching. In
   an autonomous fleet the question is not answered: it hangs.
2. **The decision has already been made, and earlier.** An operator — or CAPCOM
   on their behalf — named that path and asked for an agent there with permission
   to read, edit and run. Granting the trust at that same instant does not add one
   gram of power over what the launch already grants; it only writes it where the
   CLI reads it. The barrier that matters is who chose the path, and that one is
   intact.
3. The scope is **exactly** that of the launch: the path being launched on —
   neither the parent nor the siblings — and only after passing the guards that
   already existed (`launchable`, `excludedWorkspace`, the refusal of CAPCOM's
   workspace). A worktree counts as a folder of its own, because for the CLI it
   is.

And what is **not** done:

- The file is not created if it does not exist: its absence means Claude Code has
  never run on this machine, and its first startup writes its onboarding there.
  Getting ahead of it with a single-key file is inventing its configuration, not
  answering its dialog.
- A file that does not parse is not rewritten.
- Nothing is downgraded: if the entry already says `true`, there is no write.
- The write is atomic and **optimistic**: a temp file in the same directory,
  `fsync`, the `mtime`+size are re-read right before the `rename` and, if the file
  changed underneath, it is retried from scratch. The file is alive — other
  sessions write their `lastCost` every few seconds.
- The original's mode is preserved. The previous `preTrust` (CAPCOM's) wrote a
  fixed `0644`; over a `0600` that was a silent opening up of a file that in some
  installations carries OAuth credentials. Fixed when consolidating.

### Opt-in, opt-out, and folders of our own

Making it explicitly opt-in was considered and discarded: the "do not grant"
default is exactly the failure being fixed, and an opt-in you have to remember is
the same class of ritual as `orca-install`. What there is instead is an honest
way out:

- `ORCA_TRUST_SPAWNS=0` forbids the grant. With that, a launch on an untrusted
  folder **is rejected with the why and with what to do**, instead of freezing to
  wait for nobody. Rejecting is safe; hanging is not.

Nor is "a folder ORCA created" told apart from "someone else's folder", and on
purpose: the only folder ORCA creates on its own is a worktree inside a project
the operator already named, and the distinction that really matters — who chose
the path — is already made by the launch itself. Adding a second category would
have been one more rule to explain with no extra decision to protect.

`preTrust` and `preTrustCodex` in `capcom.ts` still exist with the same
signature; `preTrust` now delegates to `trust.ts`, so there is a single
implementation and a single place where this reasoning is written down.

The tests never touch the real `~/.claude.json`: `CommandDeps.trustFile` accepts
a path or `false`, and under `ORCA_HARNESS` the default is to do nothing.

---

## 2 · How the block looks when it happens anyway

Before, a worker stopped at a native dialog came out — when it came out at all —
as:

```
input · waiting on its terminal: nothing has been painted for 20s with a turn open
```

Now it comes out as:

```
input · native dialog waiting: "Quick safety check: Is this a project you created
or one you trust?" — nobody can answer it from ORCA; answer it in its terminal:
tmux -L orca attach -t =orca-<sessionId>
```

Three things changed:

- **`promptOn` already recognized the trust dialog and ORCA did nothing with
  it** (`if (prompt.kind === 'trust') continue;`). Now it produces a block with
  the question read off the screen. There is no escalation because there is no key
  ORCA can send on anyone's behalf: trust has no "just this once" scope.
- **The socket goes in the command.** `attachHint()` in `src/collector/tmux.ts`
  is now the only source of "how you reach a pane", and it always carries
  `-L orca`. A bare `tmux ls` answers "no server running". CAPCOM's brief says so
  too, so it repeats it verbatim to the operator.
- **Panes with no session.** `readScreens` walked derivers, and a pane stuck in
  the dialog has no transcript, hence no deriver, hence it was invisible.
  `readOrphanScreens` sweeps the ORCA panes no agent claims and publishes one
  alert line per dialog, exactly once. The first time it ran on the live system it
  found a survivor of the incident: a pane had been stopped for eight hours at the
  `ventures` dialog with nothing saying so.

---

## 3 · Registering projects

Projects were only discovered from the slugs in `~/.claude/projects`
(`ProjectRegistry.ensureWork`), so a folder with no previous session did not
exist for the hub. Now:

- **`spawn_agent` and `launch_squad` accept an absolute path** in `project_id`.
  If ORCA does not know it, it registers it on the machine that has it and
  launches, in the same call (`projectFor`, `src/agents/tools.ts`).
- **`register_project`** is the explicit door, for when the operator says "add
  this project" and wants its code before deciding anything.
- Underneath, a new command `project:register` (hub → collector). The collector
  validates the same things a spawn would validate — it exists, it is a directory,
  it is not a system path, it is not CAPCOM's workspace nor a scratchpad —
  resolves the real path and sends the snapshot **before** answering, so the hub
  has the project by the time the ack arrives.
- The registration **is remembered** in `~/.orca/projects.json` and re-adopted at
  startup: a project that does not have transcripts yet is not rediscovered on its
  own, and losing it on every collector restart would bring the ritual back in
  through the back door.
- With more than one machine connected, a path does not say whose it is: the
  answer says so, instead of guessing.

`refuseWorkspace` cut at the first slash ("`<machine>/<slug>`"), which turned
`/Users/dan/x` into `Users/dan/x` and made the guard recognize nothing. Fixed: an
absolute path is passed whole.

---

## 4 · The commands the brief promises

The footer the collector attaches to the brief of every squad member names
`orca-tell`, `orca-read`, `orca-spawn` and `orca-recover`. **None of them was on
the worker's PATH.** They live as files in `bin/*.mjs`, and `orca-install` links
them into `<project>/.claude/bin/`, which is not a directory Claude Code puts on
anybody's PATH. Measured across fourteen agents in two squads: at least six spent
whole turns looking for them (`which orca-tell`, `find ~/.orca`, `npm ls -g`,
digging around `~/.claude/plugins`); one died without writing its deliverable
after fifteen minutes of investigation; several closed their work apologizing for
not having been able to notify their lead — which meant the lead did not find out
they had finished either.

**Solution: the collector puts the commands on the PATH of the session it
launches** (`src/collector/shims.ts`). Each shim is a two-line `sh` script with
the absolute path of the `.mjs` and this collector's `node`, written under
`~/.orca/shims/`.

With a trap that cost a whole attempt: **tmux does not pass `PATH` through `-e`.**
Measured against tmux 3.7c, freshly started server:

```
tmux -L x new-session -d -e "PATH=/tmp/ZZZ:$PATH" -e ORCA_PROBE=yes \
  -- sh -c 'echo $PATH; echo $ORCA_PROBE'
  → ORCA_PROBE=yes         arrives
  → PATH without /tmp/ZZZ  does NOT arrive
```

The initial process of a session inherits the `PATH` of the tmux **server**, not
the session's; the other variables do travel (`ORCA_PANE`, `ORCA_SPAWNED` and the
keys had been arriving all along). So the `PATH` is passed where tmux cannot
rewrite it: in front of the argv, with `/usr/bin/env`, which execs in place — the
pane is still the CLI, with the same pid, and there is still no shell in the
middle (`env` receives an argv, not a line). Without `/usr/bin/env` nothing is
touched and the worker starts as before.

The other two ways out were discarded:

- *Removing the promise from the brief* leaves the member with no channel to its
  lead, which is giving up on what a squad is.
- *Writing the absolute path in the brief* works and reads terribly, changes with
  every installation, and does not help the agent writing a script nor the
  operator copying a line from the documentation.

It is done at launch and not with an installer because the installer is a manual
step, per project, that ORCA never runs.

One deliberate detail: **a squad member is not given `orca-ask`**. The footer
already told it not to use it; taking the tool away is more reliable than asking
for it not to be used. The lead and the standalone agent do carry it: they are the
door to the operator.

### The deliverable is the file, not the message

The member's footer now opens by saying so:

> Your deliverable is what you leave on disk in your working directory […] The
> messages below are how you keep your lead informed — they are courtesy, never
> the deliverable. If one fails, say so in one line in your final summary and
> finish anyway.

And it closes by saying that if a command is missing that is an ORCA bug, not
something to go hunting for through `npm`, `~/.orca` or the plugin directories —
which is literally what six agents did.

### The lead finds out anyway

`wake.tellLead` (`src/hub/wake.ts`): when a squad member reaches `done` or `dead`
**without having written to its lead**, the hub sends the lead a `notice` (or a
`warning` if it died) saying there is a deliverable in its working directory and
to go read it. It is not sent if the member already reported — the notice is the
backstop, not a copy — nor if the lead is no longer alive, in which case CAPCOM
finds out through its own channel. The lead's footer announces it, so it does not
read a member's silence as "it did nothing".

---

## Demonstration by hand

On the live system (hub and collector running from this tree), on 2026-09-08:

```
$ mkdir /Users/danielcardenas/projects/orca-trust-demo     # a virgin folder
$ # no entry in ~/.claude.json, no sessions in ~/.claude/projects

register_project {"path":"/Users/danielcardenas/projects/orca-trust-demo"}
  → OC is on the map · /Users/danielcardenas/projects/orca-trust-demo

spawn_agent {"project_id":"/Users/danielcardenas/projects/orca-trust-demo", …}
  → spawned an agent on OC · pane orca-81b619ce-…

$ cat /Users/danielcardenas/projects/orca-trust-demo/TRUST-DEMO.md
/Users/danielcardenas/projects/orca-trust-demo
2026-09-08
launched by ORCA with no human at the keyboard
```

Not one human keystroke between the spawn and the file. The trust entry appeared
on its own in `~/.claude.json` right before the launch.

And the second path, forcing the case the first one avoids — a pane launched
**bypassing** the collector on an untrusted folder. In the hub's feed, seconds
later:

```
alert | ORCA | orca-d234a791-… no ha llegado a existir como sesión: está parado
en un diálogo del CLI. native dialog waiting: "Quick safety check: Is this a
project you created or one you trust?" — nobody can answer it from ORCA; answer
it in its terminal: tmux -L orca attach -t =orca-d234a791-…
```

In the same sweep, without looking for it, `orca-22645b3e-…` showed up: one of
the incident's five workers, eight hours stopped at the `ventures` dialog. It was
left where it was — turning off other people's agents is not part of this
delivery — but for the first time ORCA names it.

And the fourth defect, with a real squad member on another new folder. Its
mission was `which orca-tell orca-read orca-ask` and to send a message:

```
/Users/danielcardenas/.orca/shims/squad/orca-tell
/Users/danielcardenas/.orca/shims/squad/orca-read
orca-ask not found

sent: tell_mtrypun8tlnfor (notice → squad:shimdemo-01)
(exit: 0)
```

The two commands the brief promises it resolve; `orca-ask`, which the brief
forbids it, does not exist for it. The first attempt at this same test gave "not
found" for all three, and that is what uncovered the `PATH` business in tmux.

Everything created for the demonstrations was removed: the panes, the folders,
their entries in `~/.claude.json` and the test's `~/.orca/projects.json`.

---

## Coverage

```
npm test -- trust        the whole case: trust, dialog, shims, registration
npm test -- screen       the trust dialog against the real screen
npm test -- capcom       preTrust delegated, and the brief names register_project
npm test -- commands squads interrupt   the three spawn paths
npm test -- codex        the argv and rollout discovery
npm test -- tmux         the spawn in a pane (PATH in front of the argv)
```
