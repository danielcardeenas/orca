# Agent window scale and recovery from the tray

Windows opened from agents use a fixed scale of 320 pixels of content per
field unit. A 640-pixel window takes up two units, whether it opens nearby
or far away. Its initial position is calculated next to the agent in world
coordinates, without capturing the zoom level at the moment of the click.
CAPCOM opened from its agent uses that same reference. Manual resizing
remains the operator's call.

The tray opens or minimizes. Recovering a window keeps its canvas, front,
or fixed mode; a window far from the canvas is framed with a camera flight
toward its own bounds, reserving space for the top and bottom bars. A
window that is already visible does not trigger another flight when
restored. FRONT/CANVAS remains an explicit header action.

Clicking an agent opens its window; clicking it again closes it. If it was
minimized, it recovers it. The native `dblclick` event does not add a
third opening after the two clicks. The keyboard selector uses the same
recovery in the existing mode as the tray.

## Verification

- `npm run typecheck`: correct on the final check. An earlier run found
  transient errors in `src/ui/hud/improve.ts`, outside this delivery; they
  disappeared without editing that file.
- `npm test -- --changed`: 1,041/1,041 checks correct. Includes the prior
  changes that already exist in the shared tree.
- `npm test -- window-canvas visual-ports`: 13/13 correct. The browser test
  covers scale and position when opening far/near, opening/closing from
  the origin, recovery with a flight, minimize/restore without changing
  mode, and content preservation.
- `npm run visual -- console --isolated`: verifies open/close clicks, the
  double click without a third opening, the real flight on recovery from
  the tray, and subsequent minimizing while preserving canvas. Screenshots:
  `test/shots/field-03-agent.png` and `field-03-agent-located.png`.
  The lasso scene is skipped: the gesture did not select multiple agents.
  Earlier runs found agents that changed or left the field during the
  test; the check now follows the identity of the opened agent and
  queries its position before each click.
- The Impeccable detector found no issues in the UI files modified in
  this delivery.

The uncovered-suites notice includes `main.ts`, help, and documentation;
the manager test uses simulated camera callbacks. The real field
interaction is additionally reviewed in the visual harness. The harness
uses the agent's real projection to click it, instead of estimating its
position from its label's typography.

Filters covering this delivery: `window-canvas`, `visual-ports`.
Visual harness: `console --isolated`.
