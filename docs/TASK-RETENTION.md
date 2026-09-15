# Retiring task conversations

Once a task was created it could never be removed. `TaskStore` had `create`,
`message`, `assign` and `bindSquad`, and no way back: the command window's
selector showed all of them forever, finished ones included, and on reaching a
hundred `create` threw `Task limit reached (100)` and the hub was left unable to
create tasks. It was not an interface gap; the operation did not exist.

Now there are two, deliberately different.

## Archiving, which is the normal case

`archivedAt` takes the task out of view and touches nothing else. It keeps the
whole conversation, its agents, its state and its history, and it can be undone.
An archived task:

- does not show up in the command window's selector nor in the HUD's task panel;
- leaves no arc in the command post's halo;
- does not appear in `list_tasks` nor in a new CAPCOM's continuity checkpoint;
- does not collect new results from its workers (`observe` skips it) and does not
  wake CAPCOM when one of them finishes;
- **does not count against the cap of a hundred**, which is what unblocks the dead
  end.

Coming back is `restore`, and it returns the task intact.

## Purging, which is final

`purge` deletes the task from `tasks.json` with no way back, and **requires it to
be archived**. Two steps on purpose: archiving is the reversible one and is
already enough to recover the slot, so the only thing that reaches the purge is
what someone decided to retire and then decided again to delete. The hub announces
the removal with `{ t: 'task', task, purged: true }`; the console removes the row
instead of drawing it, and if it was the open conversation it goes back to the
general one.

## How you ask for it

In the command window, **ARCHIVE**, next to NEW TASK, appears when a task
conversation is open. A task that is still active asks for confirmation — its
workers are still there and its thread is what explains them; a finished one goes
without ceremony.

From the bar:

```text
/tasks archive [task_id]     retires the open one, or the one you name
/tasks archived              lists the retired ones, with their id
/tasks restore <task_id>     brings it back
/tasks purge <task_id>       deletes, only if it was already archived; asks to confirm
/tasks finished              archives every finished one at once
```

`/tasks finished` is the usual cleanup gesture: what piles up without anyone
looking at it are the `completed` and `failed` ones.

`restore` and `purge` need the id, and archiving deselects the conversation —
carrying on writing into something you can no longer see would make no sense — so
there is no open one to act on. That is what `/tasks archived` is for: what has
been retired does not show up in the selector, which is exactly the point, and
without that listing its id would not be anywhere in the console.

## What a clean New CAPCOM does NOT do

None of this. `New CAPCOM → Clean context` clears CAPCOM's context — the new
session inherits no conversation, no checkpoint and no rules — and its scope ends
there. The tasks, the hub conversation, the persisted rules and the workers stay
exactly where they were.

It is deliberate in both directions. A context reset must not erase the hub's
record as a side effect: that record is precisely what makes the session
disposable, and what a new CAPCOM reads with `briefing` to find out what is owed.
Retiring tasks is a separate decision, and that is why it is asked for separately.
See [CAPCOM-NEW.md](CAPCOM-NEW.md) and [CAPCOM-ROTATION.md](CAPCOM-ROTATION.md).

## Verification

```sh
npm run typecheck
npm test -- tasks
npm test -- command task-status
npm test -- capcom-new provider-handoff
```

Not covered by tests: the command window's ARCHIVE button and the bar's `/tasks`
command are console DOM, and this repo has no DOM harness for the selector. The
logic both of them invoke — archive, restore, purge, the cap, the filtering of the
view and of the listing — is covered, including the WebSocket path the console
uses.
