# The flight lands where there's no window

A `fly` — to an agent, a squad, a project, the whole fleet — used to do one
thing: put the destination at the center of the glass. With a terminal or a
panel in front, the center of the glass is often exactly what's covered, and
the operator would fly to a tile only to find it behind the window they'd
pressed `F` from.

## What changes

A flight's framing now takes into account windows that are **in the
foreground** — `front` and `pinned`, the ones that live in screen pixels and
don't move with the camera — and picks a target (center + distance) that
leaves the destination in view. The rule, in order:

1. No windows, or the centering is already clear: **the center, as always**.
   Not one coordinate changes from before.
2. If some free rectangle of the glass fits the destination at this zoom:
   the destination slides to the gap closest to the center, moving the
   camera the minimum amount (it gets clipped inside the gap, not centered
   on it).
3. If no gap fits it but one would fit with the camera further back: the
   smallest step back that clears it, up to `ZOOM_OUT_MAX` (2×).
4. If nothing clears it (windows over almost all of the glass): the
   destination sits on the **largest** free rectangle, where the biggest
   portion of it is visible; on a tie, whichever moves the camera least.

Windows in `canvas` mode don't count: they're in world coordinates and move
with the plane, so no camera move can get a tile out from under one. A
16 px margin separates the destination from the edge of any window.

## Where it lives

- `src/ui/field/framing.ts`, new and **pure** (no three, no DOM): `aim(box,
  z, view, obstacles)` returns `{x, y, z}`. Underneath, `freeRects`
  enumerates the maximal empty rectangles of the viewport (edge grid +
  prefix sum; trivial with the dozen or so windows of a console) and
  `coveredArea` measures exactly what portion of a rectangle falls under
  the union of the windows. `projectBox` is the inverse, for the tests.
  `FOV` moved here and `camera.ts` re-exports it (`bookmarks.ts` imports it
  from the camera and stays the same).
- `src/ui/field/camera.ts`: `show(box, z)` is the window-aware flight and
  `frame(box, pad)` goes through it, so squads, projects, `frameAround`,
  and the whole fleet benefit without touching their callers. `flyTo(x, y,
  z)` is still the raw flight. `setObstacles(fn)` receives who's in front,
  read at the moment of each flight.
- `src/ui/field/field.ts`: `flyTo(id)` and `frameAgents` with a single tile
  fly with `show` and the tile's box (`tileBox`, the same extent as
  `screenOf`). `FieldHandle.setObstacles` exposes the hook. `flyToPoint`
  (markers, minimap, placing an artifact) and `frameWindow` (locating a
  canvas window) stay raw: they mean a place, not a thing to see.
- `src/ui/main.ts`: wires `field.setObstacles` with `wm.stack()` filtered
  to `mode !== 'canvas'`, and adds the test hook `__orca.fly(id)` (it's
  `c.go`).

With tilt applied, the arithmetic is that of the flat plane: the offset is
approximate, not exact. No case has been found where that leaves a tile
behind a window.

## Verification

`npm run typecheck`: clean.

`npm test -- framing` (`test/framing.test.ts`, new): 12/12. Covers no
windows (tile and fleet: the center, coordinate by coordinate), a window
that doesn't cover the center (nothing changes), a window over the center
(the tile slides just to its right, same height, same zoom, margin
respected), several windows (finds the gap between them), a gap too small
(the camera backs off the minimum step, 1.5× and not 2×, and it clears),
nothing clears it (it sits on the largest free band and shows more than
centering would), a window over the whole glass (the center, there's
nowhere else), the fleet with a window over half the screen (backs off and
fits in the other half), and the two primitives (`freeRects` with a window
in the middle gives four bands; `coveredArea` counts overlaps once).

`npm test -- --changed` (80 suites, including other uncommitted changes in
the tree): 956/956, run twice, the second time with the final state of all
the files.

**By hand, against the real console** (`npx tsx test/framing.shots.ts
--isolated`, its own hub and synthetic fleet, Chromium 1440×900): flying to
an agent with no windows → centered within 2 px; another agent's window
opens (comes out `front`, 632×688 on the left, covering the center) and
flying again → the tile lands at x=664, y=294, whole, to the right of the
window and at the height of the center; with two windows in the stack, the
same; and `FRAME` with both windows open leaves the whole fleet (21 tiles)
in the right half, none under a window. Photos at
`test/shots/framing-{0,1,2,3}-*.png`. The script checks the two promises
depending on what the windows leave: if there's room for the tile, it
requires a clean tile; if not, it requires more visible than centering
would show.

A harness trap that cost two runs: tiles slide into place (`spot.x` eases
toward `spot.tx`) and the synthetic fleet repositions them without
warning, so `flyAndLand` waits for the tile to settle, flies, and repeats
if `tx/ty` changed during the flight.

No suite covers: the wiring in `main.ts` and the `__orca.fly` hook are
only exercised by the shot, which isn't part of `npm test`.

Filters covering this delivery: `framing`.
Visual harness: `npx tsx test/framing.shots.ts --isolated`.
