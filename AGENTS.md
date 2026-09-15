# ORCA

## Style

Follow ORCA's existing style: reuse the current components, typefaces, colors,
spacing and patterns. Use DESIGN.md and the existing implementation as your
reference.

## Verification

Before calling anything done:

```
npm run typecheck
npm test -- --changed
```

`--changed` picks the suites that reach what you touched by walking the import
graph and the paths the tests read from disk (`new URL('../x',
import.meta.url)`, a whole directory, or a `<link href="/src/…css">` in a
Playwright fixture): changing `src/collector/provider-handoff.ts` runs 14 suites
out of 62; changing `src/ui/styles/hud.css`, 9. There is no list to maintain and
it never goes stale. The full suite takes over ten minutes, and that is why the
real alternative to running the affected suites is not running them all: it is
running none of them.

If `sin suite que los cubra` shows up, it is a warning, not a failure: you have
changed something no test looks at. Write the test, or say at delivery time what
was left uncovered. Keeping quiet about it turns "the tests pass" into an empty
phrase. Underneath, it says whether a shot or a visual scene looks at it,
neither of which this run executes.

If no suite runs at all, the run exits with code 3, not green: "I ran nothing"
and "I ran it and it passed" are different things. The two exceptions are
`--changed` with a clean tree, and having touched documentation only (Markdown
in `docs/` or at the root): there is nothing a suite could look at there, and it
exits 0 saying so.

Other forms:

```
npm test                      all 62 suites
npm test -- capcom wake       suites whose name contains one of the filters
npm test -- --since=HEAD~1    against a git reference
npm run visual                visual harness, for UI changes
npm run shots                 the shots, one at a time; `-- hud` filters by name
```

A shot (`test/*.shots.ts`) opens the real console in Chromium and asserts about
what it sees. `npm test` does not discover them — it only looks at
`test/*.test.ts` — and `npm run visual` runs its own scenes, so until
`npm run shots` existed they only ran if somebody typed the filename from
memory: `hud-improve.shots.ts` sat red for weeks with the suite green and the
SELF-IMPROVEMENT panel with no net. If you touch the UI, run the ones that look
at it and say which in the delivery; each one brings up its own hub, its own
Vite and its own fleet, so they go serially and cost minutes, not seconds.

When you deliver, say what you ran and what came out. "The tests pass", without
saying which, is not verification. A failure reported in time costs far less
than one that shows up once something has been built on top of it.

Every delivery document in `docs/` ends by listing the filters that cover it;
keep that habit in new deliveries.
