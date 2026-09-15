# Provider marks in the model pickers

**Mission:** `mission_mttsu2rn5ce3wtce`
**Status:** implemented and verified. **Not published** and **not committed**, as
the instruction asked: this goes to CAPCOM for review.

---

## 1. The problem, in one line

`CHANGE MODEL` and `New CAPCOM` mix two providers in the same list, and the names
do not always say so: `opus` and `gpt-5.6-luna` are told apart because the
operator already knows, not because the list shows it. Now it shows it.

## 2. What you see

In the header of each block of the menu, to the left of the name that was already
there:

```
❋ CLAUDE CODE          the eight-ray burst
⬡ CODEX                the hexagonal knot
```

And in the status line, with the menu **closed**, the mark of the provider that
is running right now: `⬡ CODEX · gpt-6-astra`.

**They are each provider's official logo, not an interpretation.** Downloaded as
SVG, rasterized and reduced to the grid: they are drawn at 18×12 pixels per cell,
the average coverage of each cell is measured and the ones over 40% are turned
on. The shape comes from the provider; ORCA only picks the resolution.

An **18×18 grid at 18px** — one cell per pixel, exact and with no smoothing.

### The two attempts that failed, so nobody repeats them

1. **Deriving the geometry.** I derived OpenAI's knot from its structure (three
   loops crossing at 60°) and Claude's burst from its rays. What came out was a
   plausible figure that **was not the logo**: at 11px the knot looked like a nut.
   The operator put it better than I did — "it looks like we just put random
   things in there". An icon you have to explain is not an icon.
2. **Reducing the logo to 11 cells or fewer.** Noise. The knot's stroke and the
   burst's rays are **thinner than a cell** at that size: half of it was lost and
   the other half turned into blobs. Fattening the stroke before reducing does not
   help either: it fills in the knot's gaps and out comes a smudge.

I checked both directions before deciding, not by ear: direct reduction,
reduction with morphological dilation, and grids of 9, 11, 13, 16, 18, 20 and 22
cells. The comparison is photographed in `test/shots/marks-compare2.png`, with the
pixelation at each size, the real unpixelated vector and what was there before,
all three in their real place — next to the group name — so they can be compared
as they look and not as they are described.

**Eighteen cells is where it starts being recognizable**, and that is why it is
18. It is still small — five pixels taller than the text beside it — and it is
still a pixel drawing, which was the starting condition.

## 3. Where the mark goes, and why there

**In the group header, not on every row.** The list is already grouped by
provider: repeating the mark on all ten rows of a block adds no information, and
turns a list into a tapestry. The header says whose the block is, once.

**And in the status line**, because with the menu closed you cannot see the
header, and "whose is the model that is running" is exactly what you look at
before opening anything. There the runtime name is still written beside it: the
mark accompanies the text, it does not replace it — an 18px drawing is not a name.

## 4. What does NOT change

Nothing that already worked, and it is tested one by one (§6):

- the group **names** (`CODEX`, `CLAUDE CODE`) are still text, not an image:
  filtering, jumping by letter and a screen reader read them the same as before;
- the options' **labels and hints**, untouched, including those of what cannot be
  chosen (`CLI not installed`), which is still listed and read out;
- **filtering**, the **keyboard** and **selection**;
- and the eight callers of `pick` that do not pass `mark` are left **byte for
  byte** as they were: with no `mark` nothing is drawn and no class is added.

## 5. Files

| File | What |
|---|---|
| `src/ui/gfx/marks.ts` | **new.** The two grids reduced from the official SVG, `MARKS`, `markForRuntime()` and `markSVG()` |
| `src/ui/controls.ts` | `PickOption.mark?: string`, drawn in the group header |
| `src/ui/windows/capcom-model.ts` | passes `mark` in both pickers and in the status line |
| `src/ui/styles/window.css` | `.pick__group.has-mark`, `.pmark`, and the same for the status line |
| `test/provider-marks.shots.ts` | **new.** Isolated visual QA, desktop and phone |

**SVG and not canvas**, which is the one decision that departs from the house
language. `paintBits` paints into a `<canvas>` because the wordmark and the sigil
live where there is already an element to hold on to and a repaint of their own.
A mark lives inside `pick`, which rebuilds its whole list on every filter: a
canvas would force a manual repaint after every rebuild and carrying the DPR
around. An `<svg>` with `shape-rendering="crispEdges"` is a string, it goes into
the HTML `pick` already writes, it inherits the color with `currentColor` — so the
mark dims with its row without `pick` knowing it exists — and it comes out exact
at any zoom.

## 6. Tests, with their exit code

```
$ npx tsc --noEmit -p tsconfig.json;        TSC_EXIT=0
$ npx tsx test/run.ts --changed;            1114/1115, 1 failed  CHANGED_EXIT=1   (§7: it is E4's)
$ npx tsx test/provider-marks.shots.ts;     MARKS_EXIT=0
$ npx tsx test/capcom-model.visual.ts;      EXIT=0
$ npx tsx test/capcom-new.visual.ts;        EXIT=0
$ npx tsx test/model-catalog.visual.ts;     EXIT=0
$ npx tsx test/provider-handoff.visual.ts;  EXIT=0
```

The four existing visual tests are the ones that touch these two components, and
they are the proof that I have not broken anything of theirs. `capcom-model`,
`model-catalog` and `provider-handoff` need a vite on 4478; there was none, so I
brought up an ephemeral one to run them and **closed it when done** (checked: 0
processes on 4478 afterwards). I did not restart the hub or the collector.

What `provider-marks.shots.ts` checks, in an isolated environment — its own
ephemeral vite, without the project's configuration, without a websocket proxy and
without a hub:

1. `CHANGE MODEL` groups by provider and each header carries **one** mark;
2. the two marks are **different** (the SVGs are compared): the same mark for both
   would be decoration, not a signal;
3. they are pixels and not typography: `crispEdges` and the cells counted;
4. the labels, the hints, the filter, the keyboard and the selection, untouched;
5. the mark goes in the header and is **not** repeated per row (it is counted: 2
   marks in a menu of four options);
6. the status line carries its mark with the menu closed, and the name beside it;
7. the same in `New CAPCOM`;
8. and on the phone, with the picker open as a **dialog**: marks present, no
   horizontal overflow, and the whole dialog inside the screen — the mark widens
   the header, which is what decides the menu's width, so that is **measured** and
   not assumed.

Screenshots: `test/shots/provider-marks-change-model.png`,
`provider-marks-new-capcom.png`, `provider-marks-mobile.png`.

## 7. What is green and what is not

There are two different things here and the first version of this report merged
them into a "green tree" that was not true. They are separated:

**My validation: green.** `TSC_EXIT=0`, the five visual tests at 0, and
`--changed` with **every suite that reaches what I touched** green.

**The shared tree: no.** `--changed` ended at `1114/1115`, `CHANGED_EXIT=1`. The
failure is `synthetic`, in `ejecutar, no nombrar ni precargar`, expecting
`920,921,922` and receiving `911..922`. It is **E4's**: its test
(`test/synthetic.test.ts`) and its implementation (`src/hub/harness.ts`) are being
written right now — both with timestamps from minutes ago — and during this
session that suite and `wake` failed and recovered on their own twice, plus a
`TS2741` in `src/hub/wake.ts` that also resolved itself.

That it is not mine is checked, not asserted: none of my files
(`gfx/marks.ts`, `controls.ts`, `windows/capcom-model.ts`, `styles/window.css`)
appears in the import graph of `test/synthetic.test.ts`, which reaches
`hub/harness.ts` and `hub/server.ts` and does not touch the `ui/` layer.

**No suite is left uncovered on my side.** What I touched in terms of logic is
`pick` and `capcom-model`, and the five visual tests above look at them.

## 8. Limits

1. **Two providers and no more.** `markForRuntime` knows `claude` and `codex`; a
   new runtime draws nothing, which is exactly how the list stands today. There is
   no generic filler mark: a drawing that does not say who it is says nothing.
2. **The mark belongs to the provider, not to the CLI.** If tomorrow Codex served
   a model from another house, its mark would be a different one and the runtime
   would still be `codex`. Today that distinction cannot be made because the
   catalog does not carry it.
3. **Observed along the way, not fixed** (it belongs to `controls.ts` and not to
   this mission): a `pick` that already opened as a dropdown and is reopened after
   shrinking the window to phone dimensions keeps the previous anchored position
   and the dialog ends up off screen (measured: `left:195`, `right:553`,
   `vw:390`). On a real phone it does not happen — it was never a desktop — and
   that is why the phone test uses a new tab. Stated here for whoever owns
   `controls.ts`.
4. **Not published, not deployed and not committed**, as the instruction asked. An
   honest warning: the hub's automatic publisher (`src/hub/publisher.ts`) builds
   when a worker on ORCA's own repo finishes, so **finishing this mission may
   trigger a build by itself**. It is not an action of mine and I cannot avoid it
   from here. What I can say precisely: `tsc --noEmit` passes over the whole tree,
   so if that build fires today, it will not fire because of this — but the tree is
   shared and what holds a minute from now is decided by whoever is writing then,
   not by me (§7).

## 9. How to verify it

```
npm run typecheck
npm test -- --changed
npx tsx test/provider-marks.shots.ts    the marks, desktop and phone
npx tsx test/capcom-new.visual.ts       New CAPCOM, untouched
```

Filters that cover this delivery: `capcom`, `synthetic`, `commands`.
