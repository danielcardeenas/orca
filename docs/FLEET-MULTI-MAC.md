# One fleet on two Macs

One hub, one collector per machine, and CAPCOM handing out the work between the
two without anybody having to name them. This document says what was there,
what was missing for a second Mac to be **capacity** and not just **presence**,
and how you add one.

## What was already there

The architecture was always a multi-machine one: `Machine` is defined as "your
Mac, a VPS, a container", each collector keeps a single outbound connection to
the hub, and the hub routes every command by `machineId`. CAPCOM turns itself
off in a collector that points at a remote hub, so two machines never run two
CAPCOMs. Access over Tailscale is already solved in `docs/REMOTE-ACCESS.md`: the
hub listens on `0.0.0.0:4479` and startup publishes it over https inside the
tailnet.

What looks the same from anywhere, with nothing to do: agents, feed,
conversations, escalations, messages, artifacts (they travel as bytes through
the collector), the chat with the CEO, journal, costs and budgets. All of it
lives in the hub or reaches it.

## What was missing

Connecting the second collector worked. What did not work was getting work to
it:

1. **CAPCOM could not see the machines.** `list_fleet` returned projects,
   blocked agents and squads. Not how many machines there are, not which one is
   loaded, not which one each project lives on.

2. **Two clones were one.** The project id carries the machine
   (`<machineId>/<slug>`), but CAPCOM speaks in codes, and the same repo cloned
   on two Macs is two projects with the same code. `findProject` did a `find` by
   code: always the first one, always the same machine. The second Mac could sit
   empty and never receive anything.

3. **A new path with two machines was an error.** `spawn_agent` with an absolute
   path that ORCA does not know registers it in the collector that has it. With
   one machine there is no doubt; with two, `projectFor` refused: "a path does
   not say which one owns it".

4. **The CLI refused too.** `orca spawn AX "..."` with two clones of AX failed
   with "matches 2 projects — use the id".

## What changed

All of it in `src/agents/tools.ts`, except the brief and the CLI.

- **`list_fleet` lists the machines.** Each one with `name`, `online`,
  `live_agents`, `cpu_pct`, `mem_pct` and the project codes it has, including
  the clones with no session yet, which the project list still leaves out. Each
  project also carries `machine`. The summary says "2/2 machines online" only
  when there is more than one.

- **The least loaded clone takes it.** `pickProject` sorts the matches: online
  machines first, then the ones with fewer live agents, then less CPU. A clone
  from the synthetic harness always sorts last. With a single match it returns
  what it returned before: on one Mac nothing changes, not even the summary
  text.

- **`machine` on `spawn_agent`, `launch_squad` and `register_project`.** A
  hostname (whole, or its first label) or an id from `list_fleet`. It pins the
  launch to that machine; an unknown or offline one is a readable rejection that
  lists the ones there are. A squad is never split across machines: its members
  share a disk.

- **A path is asked of all of them.** With several machines, `projectFor` sends
  `project:register` to every real online collector. Each one registers it if it
  has the folder and rejects it if not; among those that have it, the launch
  goes to the least loaded. If none has it, the error brings each one's reason.

- **CAPCOM's brief** says that the fleet may span several machines, that the
  distribution is automatic, when to name one, and that what a worker commits
  reaches the other machine through git and not through ORCA.

- **`orca spawn|squad|launch --machine <host|id>`.** And without `--machine`,
  two clones of the same repo (same code, same path, different machines) are no
  longer an ambiguity: the CLI passes the code and the hub distributes.

## Adding a second Mac

On the new Mac, with Tailscale on the same tailnet:

```
git clone <orca repo> ~/projects/orca && cd ~/projects/orca && npm install
mkdir -p ~/.orca && scp <main-mac>:~/.orca/token ~/.orca/token && chmod 600 ~/.orca/token
ORCA_HUB_URL=ws://<main-mac>.<tailnet>.ts.net:4479 ORCA_WORKTREES=1 npm run prod:collector
```

With the hub published through `tailscale serve`,
`ORCA_HUB_URL=wss://<main-mac>.<tailnet>.ts.net` works too. The collector
appends the socket's path by itself.

What has to be on the new Mac:

- **The same commit of ORCA.** The hub rejects old wire formats by collector
  version; two different checkouts are two different protocols.
- **`claude` (and `codex`, if you use it) signed in, and tmux.** The workers run
  there; the hub only gives orders.
- **The repos cloned, at the same path as on the main Mac.** It is not
  mandatory, but with the same path `spawn_agent /Users/dan/projects/x` finds
  the folder on both, and the console's file viewer, which reads from the hub's
  disk, shows what a worker on the other Mac quotes.
- **A common git remote.** It is where the results meet: a worker leaves commits
  on the disk of the Mac where it ran. With `ORCA_WORKTREES=1` each worker works
  on its own branch, and the brief has to ask it to push when somebody on the
  other machine needs what it did.

To check that it has joined:

```
orca health          # "2 collectors"
orca ls              # the projects from both machines
```

## What is still per machine

- **Project keys** (`key:set`): they never leave the machine that stores them. A
  project that needs a key needs it on every clone that uses it.
- **Per-project budgets**: they go by id, and two clones are two ids. The squad
  and agent ones do not change.
- **`/api/file`** reads from the hub's disk. A file that is not an artifact and
  is not on the main Mac cannot be opened from the console.
- **A project with no sessions** does not appear in `list_fleet`'s project list
  (as always), but it does appear in `machines[].projects`, which is where
  CAPCOM looks to see which machine has a copy.

## Tests

```
npm test -- multi-machine capcom cli briefing
```

`test/multi-machine.test.ts` is the new suite, all of it boxed in: a
`CeoContext` with two machines, two clones and a `dispatch` that records where
each command went. It covers the survey with machines and load, the handoff to
the least loaded clone, `machine` by hostname, by short label and by id, the
readable rejection of an unknown or offline machine, registering a path only on
the machine that has it and the rejection with reasons when none has it, a whole
squad on a single clone, that with one machine the summary is the usual one, and
that the synthetic harness never receives real work.

`test/cli.test.ts` adds a case with a real hub and a second machine injected
with a clone of the fake fleet's project: `orca spawn <code> --machine <host>`
lands on that machine, without `--machine` the CLI no longer says "matches 2
projects" but leaves it to the hub, and an invented machine is exit 1 with the
list of the ones that report in.

What no test covers: two real Macs. The remote collector, the shared token and
the tailnet are tested in `docs/REMOTE-ACCESS.md` for the console, not for a
second collector with workers. The first time a Mac is added you have to look at
`orca health` and `list_fleet` before trusting it.
