# ORCA in production

Always run the optimized build, and let publishing improvements leave what is
standing alone until the operator decides otherwise.

## Day to day

```
npm run publish     typechecks, builds the console and sweeps up what is left over
npm run prod        hub + collector, no watch, serving that console
```

`prod` brings both up under a supervisor, which is what makes it possible to
restart them later from the console itself (below).

The console comes out on the hub's port —4479, or the https url that `tailscale
serve` publishes on the tailnet— and there is no second process to keep alive:
Vite is out of the equation. The hub serves `dist/` with three cache policies
(`serveStatic` in `src/hub/server.ts`): `index.html` as `no-store`, the
`/assets/*` with a hash and `immutable` for a year, and the fixed-name things
—manifest, icons, fonts, sfx— revalidated with `Last-Modified`, which is a 304
with no body.

And with that comes what development does not have: a minified bundle, a service
worker, a boot with no network and a console installable on a phone
(`docs/PWA.md`).

## Publishing does not reload anyone

`npm run publish` (`tools/publish.mjs`) does three things, in this order:

1. **`tsc --noEmit`.** Vite does not check types: without this gate, publishing
   is publishing blind. If it fails, nothing is touched and the previous build
   stays standing.
2. **`vite build`, which does NOT empty `dist/`.** That is what makes it possible
   to build on top of a console someone is looking at. With the default
   emptying, for the seconds the build takes the live page loses fonts, sounds,
   `/sw.js` and the index — and if the build fails, it loses them for good.
   Without emptying, the build is additive: the new `/assets/*` carry a hash and
   live alongside the previous generation's, and the index, which is the only
   fixed-name thing that decides which build is which, is rewritten at the end. A
   broken build never gets to touch it.
3. **The sweep.** Two generations are kept: the one the index served before and
   the new one. The first is the one loaded in the tab that has not reloaded yet;
   it is not going to ask for its bundle any more —it has it— but it will ask for
   its sourcemap if someone opens the dev tools. Anything older than those two
   cannot be requested by anyone, and is deleted. Without the sweep,
   `dist/assets` would grow without end: that is why a bare `npx vite build`
   works but leaves rubbish behind.

From there on the usual doctrine rules: the console does not change under the
operator's hand. The index's set of `/assets/*` **is** the build id; the page
remembers its own on load and compares it every minute, when the tab comes back
to the front and when the link with the hub is recovered. When it differs,
`UPDATE AVAILABLE · CLICK TO RELOAD` lights up, and the click is the reload
(`src/ui/hud/update.ts`). The service worker follows the same rule: the new
worker waits in `waiting` until that click, with no `skipWaiting`
(`public/sw.js`).

## Publishing by itself, when the work finishes

A manual step between "the agent finished" and "the operator can see it" is a
step that does not get taken: the work stays on disk, done and never arriving.
That is why the hub publishes on its own (`src/hub/publisher.ts`) at two moments:

- **An agent that was working on ORCA's repo goes to `done`.** Only `done` —a
  dead agent finished nothing—, only workers —the end of a CAPCOM is the end of a
  command session, not of a batch of work— and only the repo itself.
- **A branch lands in ORCA's repo** (`land_work`, in `src/agents/tools.ts`).

None of that reloads anything. Publishing produces the build; the pill offers it;
the click is still the operator's. Automatic up to the offer, never beyond.

Three things keep it from being a nuisance:

**Only the repo itself.** ORCA governs many projects and publishing only makes
sense for its own. The comparison is between resolved paths against the tree the
process runs from, not by project name: one can be called `orca` without being
it, and the real one can be behind a symlink. A worker in a worktree counts,
because its project is still this one.

**It waits and it groups.** A squad finishes in a cluster. The first request
opens a 30 s window and whatever arrives within it travels along. And there are
never two builds at once: whatever is requested while one is building is noted
down and done once at the end, because two builds over the same `dist/` are
exactly the race `emptyOutDir: false` avoids.

**A failure does not repeat.** The tree is shared and dirty on purpose: the
typecheck goes red often, and because of someone else's work. When that happens
nothing is touched —the standing console keeps its good build— and CAPCOM is
told, since it is the one who can fix it; the operator is not interrupted, he
only sees the pill when there is something that can really be applied. And the
same error is not counted twice: warning on every attempt turns the warning into
noise and the noise into silence.

`ORCA_AUTOPUBLISH=0` turns it off and leaves the usual manual publish. A test hub
never builds.

## The asymmetry, said out loud

**Reloading updates the console and nothing else.** The hub and the collector
load their code at startup and never look at it again, so after publishing you
can end up with a new bundle talking to an old process — and the symptom of that
(a command that does nothing, a field that arrives empty) does not look like the
cause.

That is why the hub watches itself (`src/hub/source-rev.ts`): it takes its code's
revision at startup, takes it again every 30 s and, if it changed, tells the
consoles with the `server` frame (`src/shared/protocol.ts`). There a second pill
lights up, `SERVER CODE CHANGED · RESTART ORCA`, with different text because the
action is different: this one is not fixed with a click, it is fixed by
restarting ORCA.

### The click that restarts

That pill is a button when it can be one. `npm run prod` puts
`tools/supervise.mjs` in front of the hub and the collector, and a supervised
process knows how to ask to be relieved: it exits with code 75 (`EX_TEMPFAIL`,
"try again") and the supervisor relaunches it in the same terminal, with the same
logs and the same process tree. The whole contract is two pieces —a mark in the
environment and an exit code— and it lives in `src/shared/restart.ts`.

What happens when you press it: the hub warns the collectors, gives them half a
second for the frame to make it out over the wire, shuts down cleanly and exits
with 75. Each collector decides for itself —with no supervisor behind it, it
ignores it, because a collector that shuts down and does not come back leaves its
machine out of the fleet— and the agents are not touched: they live in tmux, not
inside these processes, and they keep working while the processes come back.

There is no ack, because whoever would have to send it is precisely what is
dying. The confirmation is the link: it drops, it comes back, and there the
console reloads by itself. Reloading there does not break the doctrine, it
honours it — the click IS the authorization, and leaving the old console talking
to the new hub would be the only way for that click to end up worse than it
started. If the link does not so much as flinch in 15 s, nothing happened and the
button comes back.

With no supervisor —`npm start`, or the hub launched by hand— the `server` frame
arrives with `restartable: false`, the pill stays as the usual notice and says
what to type. Offering a button that cannot work is worse than not offering it:
the operator thinks it is already done.

And a brake: a process that asks to be relieved three times without managing to
live five seconds ends the cycle. That is a broken tree restarting against code
that does not compile, and what is useful then is seeing the error, not another
attempt.

What counts as server code: all of `src/**/*.ts` except `src/ui/`, which already
has its own signal. `src/shared/` counts even though the console shares it — it
can move the protocol, and erring towards "warns too much" costs a glance. No
contents are read: path, size and mtime are enough.

In development this never lights up, and not because of an `if`: under `tsx
watch` the process restarts on save, so its startup revision is the disk's again
before anyone has time to look.

The notice arrives through both of a console's entrances: the token in the query,
which is the browser's, and the `hello`, which is everything else's. Wiring it in
only one is a bug the WebSocket tests do not see — they come in through the
`hello` one — while the real console never finds out about anything.

## What stays the same in development

`npm run dev` does not change: Vite on 4478, hub and collector under `tsx watch`,
and the instant update notice over the dev server's WebSocket. What changes is
that you no longer have to work that way to have ORCA standing.

## Tests

```
npm test -- source-rev publish publisher restart serve update
```
