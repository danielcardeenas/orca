# ORCA — agent and squad identity in the field

Design, 2026-09-05, drawn from two screenshots of the real field (a 33-tile
region and a tile blown up to tier 5) and from the frames of the `offworld.mp4`
comp between 7.5 s and 12 s (the NULL→ACTIVE pipe tree and the tile grid).
Each section settles one decision. The file split at the end is the contract
between agents.

**The thesis.** Today an agent is a notched rectangle with a colored stripe; a
squad is a word floating over a borderless block; a relation is a lime pipe
that crosses over whatever is in its way. All three use the same lime, so the
eye cannot tell *structure* (who belongs to whom) from *activity* (who is
working). The comp does tell them apart: structure is grey and carries the lime
*inside*; the lit tile is the only solid lime block; and no cable crosses a
tile. The design below splits those three roles and gives every agent and every
squad a mark that survives zoom.

---

## 0. What the screenshots show broken (fix before designing on top)

| # | Symptom in the screenshot | Cause | Fix |
|---|---|---|---|
| 0.1 | The lime pipe runs **over** the text of tile LL and of row B1…2T | `createSwarm` is called before `createPipes` (`field.ts:186-187`); both materials are `transparent` without `depthWrite`, and Three sorts transparent objects at the same position by insertion order | `mesh.renderOrder = -1` for bus, core and ports in `pipes.ts`; pulses to `+1`. The z is already below the tiles'; all that is missing is for the order to respect it |
| 0.2 | Pipes cross whole rows of tiles (horizontal bus halfway up B1…2T) | `routeLineage` bends at `midY` between parent and child; two rows apart, the elbow lands on the row in between | Routing through **gutters** (§4.1). No pipe touches a tile |
| 0.3 | `$0.00` and `LL` start underneath the status stripe | The stripe measures `max(4.5 %, 2.5 px)` of the tile; `--pad-x` measures `4px·u` ≈ 1.6 % | All three bands start at `left: 7%` (§2.1) |
| 0.4 | `UPTIME  TURNS` ends up under the blue band that runs | The shader band occupies the bottom 7–10 %; the bottom DOM band reaches `bottom: 0` | `.lbl__bot { bottom: 11% }` (§2.1) |
| 0.5 | `Inventory OR…` and `I have a co…` clipped at eleven characters | Both lines live in the middle band, capped at 66 % by the notch | The NOW line moves down to the bottom band, which is full width; mission gets two lines (§2.2) |
| 0.6 | `axolots-25` as the title | It is the Claude Code session title and it repeats the project | Rule: if the title starts with the project's name, it is discarded and the mission moves up (§2.2) |
| 0.7 | A stray `□` under the NOW line | An emoji in `lastSay` that neither Geist Mono nor Tiny5 has | `lbl.ts` filters `\p{Extended_Pictographic}` and variation selectors before painting |

These seven are mechanical and not a matter of opinion; they come first because
any photo of the new design would come out wrong with them still in it.

---

## 1. The agent: a mark that is not text

### 1.1 The sigil

**Decision.** Every tile carries a **sigil**: a 5×5 pixel glyph, mirrored on X,
in the tile's top-right corner (x 0.80–0.955 · y 0.775–0.93, clear of the notch
that runs from y 0.30 to 0.70). Fifteen bits decide the drawing. It is the mark
that identifies an agent when the tile is 60 px and not even the callsign fits,
and it is the same mark you will see in its window's header.

**Where the bits come from.** From the FNV hash of a *seed*:

- standalone agent → `agent.id`;
- squad member → **the squad's name**, not its id. That way five members wear
  the same shoulder patch and the block reads as one body even before you see
  the outline;
- the lead carries the **inverted sigil**: a block of ink with the glyph
  knocked out in body color. It replaces today's filled square (`swarm.ts`,
  `mark`), which said "lead" but not of what.

**Implementation.** One per-instance attribute `iSigil` (float; fifteen bits
fit exactly in the mantissa). In the fragment, for cell `(cx, cy)` of the glyph
with `cx' = min(cx, 4 − cx)`, the bit is
`mod(floor(iSigil / exp2(cy·3 + cx')), 2)`. Cost: one multiply and two `floor`
per pixel inside a 0.15×0.15 region of the tile. Zero CPU. The same
`sigilBits(seed)` lives in `gfx/sigil.ts` and also renders the glyph to DOM
(`<i class="sigil">` with 25 `box-shadow`) for the window header and the squad
label.

**Color.** Ink (`uInk`) on a dark body; body (`uBody`) on a full amber tile.
Never the status color: the sigil says *who*, the stripe says *how it is doing*.

### 1.2 The runtime, in the stripe

**Decision.** The status stripe on the left edge carries the **runtime
texture**: solid for Claude, 2:1 dashes for Codex, 1:1 dots for Grok, thin
solid for anything else. It is the only runtime signal that survives every
zoom; the `.lbl__rt` chip still spells it out in letters when there is room.
The tile's shape does not change per runtime: the text bands are built around
*this* notch and a different notch per CLI would break them.

**Implementation.** `iAux` goes from `vec3` to `vec4`; `.w` is the runtime id
(0 claude, 1 codex, 2 grok, 3 other). The pattern is computed on `t.y` with
`fract(t.y · 10)`, in tile units, so a large tile does not show a hundred
dashes.

### 1.3 CAPCOM

Only one per fleet, and it is the voice that answers. It is the only exception
by role, and it is an exception of **color**, not of shape (revised
2026-09-06):

- **Cyan** (`--cyan`, `#4fe3ff`). The outline is permanently cyan, the halo is
  cyan and breathes slowly even when the tile is at rest, the sigil (the `C`
  from `gfx/logo.ts`) is cyan ink, and the body carries 7 % cyan over the dark.
  A **stroke** sweeps the tile top to bottom every ~6 s with a short trail,
  like an oscilloscope beam; with `prefers-reduced-motion` it stays still.
  Nothing else in the field may wear this color: lime is the fleet, amber is
  the person, cyan is command.
- **Outside the projects.** It does not live in any region: it sits at the
  spiral's origin (`layout.ts`, slot 0 moves to an outer ring) with the regions
  around it, at scale `CAPCOM_SCALE` (1.4). Its folder on disk is its home,
  not a repo, and earns no region; a stray worker in there does earn one, and
  that is how the straying shows. Its pipes take the direct route, like those
  of a hand-pinned tile.
- **Two labels.** Over the tile, centered on its top edge, a `CAPCOM · COMMAND`
  chip in cyan (`.rgn--capcom`), the equivalent of a region's label or a
  squad's; like a squad's, it never hides at any zoom nor yields to a
  collision, and a click opens the conversation. Inside the tile, `CAPCOM`
  where the callsign would go, and `HL · COMMAND` where a worker carries its
  project and its origin, with a beacon in front breathing at the same rate.
  At rest it does not dim: CAPCOM idle is CAPCOM listening. In the console, the
  command line's target chip, its window's name and its voice in TALK all carry
  the same cyan.
- **Clearance.** If a hand-dragged region or tile covers the origin, CAPCOM
  moves up to the first free gap (`CAPCOM_CLEAR`): it never ends up inside a
  project or a squad.
- **One body, not several** (revised 2026-09-06). CAPCOM is still *one* tile:
  splitting it into blocks would make it indistinguishable from a squad (§3).
  What says it is the command post is what it carries around it, and that lives
  in `field/command.ts` — a single quad, a single shader, one `draw call`:
  - **The ring.** A rounded outline at `RING_OFF` from the tile's edge, split
    into one arc per open task (`WorldState.tasks`, state `active`). The arc is
    lit while the task is moving — fresh conversation (`TASK_HOT_MS`) or one of
    its agents working — and unlit while it waits; the one the operator has
    open goes at double stroke. A completed task disappears from the ring. With
    no tasks, the ring is a faint continuous line: the post is there, and it is
    holding nothing.
  - **The notches.** Amber ticks at the bottom of the ring, one per escalation
    nobody has answered (`pending` or `with_ceo`). It is the load the operator
    is going to have to take on, and that is why it is amber and not cyan.
  - **The turn.** At rest the core breathes as always; on its turn
    (`thinking`/`working`) it beats 2.6× faster and its outline goes solid;
    waiting on the operator, the halo and the glow tint amber. It reaches the
    tile shader as the uniform `uCap`: there is only one CAPCOM, so it does not
    cost a per-instance attribute.
  - **The links.** Faint cyan pipes (`PipeKind` `command`, no ports) from
    CAPCOM to whatever it launched — its own child, or a root with
    `origin: 'orca'` — dropping to a third when the agent finishes. With fifty
    agents they are noise, so they are a preference and are off by default.

  The four pieces are flags in `prefs.ts` (`capcomTasks`, `capcomNotches`,
  `capcomPulse`, `capcomLinks`) and each one turned off returns the field to
  what it drew before. The ring is not drawn in the deck: a hoop around a tile
  in a strict grid would cross its neighbors.

---

## 2. The text inside the tile

### 2.1 The bands

The three bands stay; their edges and their share change.

```
 ┌─────────────────────────────────────┐
 │▌ top  auto     x 7–78 %   LL  AX ·CX │▒▒▒│  ← sigil at 80–95 %
 │▌ mid  flex 1   x 7–66 %          ▐████│  ← notch 70–100 %, only < 320 px
 │▌               (x 7–96 % from 320 px)  │
 │▌ bot  auto     x 7–96 %  NOW ─────────│
 │▌               $  TOK/S  UP  TURNS  [PILL]│
 │▌ (shader band, 0–10 %)                 │
 └─────────────────────────────────────┘
```

- `left: 7%` on all three: the stripe measures 4.5 % and needs air.
- The column ends at `bottom: 11%`: the speed band runs below it.
- **The bands are a flex column, not three fixed-height boxes.** The bottom one
  measures what it contains and the middle one takes the rest and clips its
  lines. With percentage heights, NOW and the metrics were clipped at one zoom
  and left slack at another; now they are clipped at none. (The percentages go
  in an absolute column inside the tile, `.lbl__col`: a percentage `padding` on
  `.lbl` resolves against the whole layer, not against the tile.)
- **The notch withdraws as you get closer.** It quotes the comp's card at a
  glance, but on a tile where a sentence already fits it only eats words. The
  shader slides it out past the right edge between 260 and 320 px; from tier 4
  on, the middle band has the full width.
- The **status pill** leaves the top-right corner (that is the sigil's now) and
  goes at the end of the metrics row, right-aligned. It is where the comp puts
  `OFFLINE` on the DEEP-SPACE RADAR ARRAY card: under the title, not over it.

### 2.1b The tile's outline

**Decision.** A tile's border is a **2 screen-px band** in `#4a5262` — one step
above `--line` — not the 1 px `--line` over a body two shades darker that you
could never find. The band follows the silhouette, bite included: the shader
samples the shape at 2 px in the four directions and paints where the interior
does not reach (`uLinePx`). Selection, hover and CAPCOM keep their line colors;
only the resting state changes. The window outline stays at `--line`: it is
drawn once around a panel, not forty times over the ground as noise.

### 2.2 What goes in each band, and the ladder

| Tier | width px | top | mid | bot |
|---|---|---|---|---|
| 1 | ≥ 44 | callsign · project | — | — |
| 2 | ≥ 112 | + runtime chip | title **or** mission, 2 lines | — |
| 3 | ≥ 190 | | | **NOW**, 1 line, full width |
| 4 | ≥ 320 | | title 1 line + mission 2 lines | NOW + metrics |
| 5 | ≥ 520 | + `RUNTIME · MODEL · MACHINE` | | + pill |

New rules:

- **NOW lives at the bottom.** It is the line that changes most and the one
  that was clipped most at 66 %. At the bottom it has 89 % of the tile and a
  single line.
- **The mission gains two lines** (`-webkit-line-clamp: 2`). It is the sentence
  that explains why the agent exists; eleven characters explain nothing.
- **The title is a name, not the brief.** The collector falls back to the first
  prompt when the session has no `ai-title`, so half the squad was titled `Eres
  el agente A en una prueba corta de saludo…`. `nameOf()` (`ui/util.ts`): if
  the title is 56+ characters or opens by telling the agent who it is
  (`Eres…`, `You are…`, `Actúa como…`), or is a bare session id
  (`9585cb99`), and the mission is shorter, the mission is painted. The agent
  window uses the same rule for its header.
- **Repeated title, title out.** If `title` starts with the project's name or
  code (the `axolots-25` case), it is not painted and the mission takes its
  place. If there is no mission, the title is painted even if it repeats:
  better a redundant fact than a gap.
- **No markdown.** `**No he podido escribir**`, `## Recomendación`, list `- `,
  `[texto](url)` and code backticks are stripped before painting (`plain()`);
  the words remain in their order. `snake_case` is not italics.
- **Honest metrics, fixed columns.** The four columns do not move, so the eye
  can find them; a value that makes no sense in the current state (TOK/S while
  idle) is painted `—` in `--ink-faint`, not `0`.
- **No tofu.** Emojis and variation selectors are filtered out of the text
  coming from the agent before it is painted.

None of this changes the `--u` unit system or the rule that only crossing a
rung rewrites the interior.

### 2.3 The shape says something

**Decision.** Every feature of the silhouette answers a question the operator
asks from a distance. Nothing is ornament; the bite stops being one.

| Feature | Means | Who carries it |
|---|---|---|
| Bite on the right | "I have a parent": it is the port where its pipe lands | children only; a root is a whole rectangle |
| Tab under the bottom edge (x 0.11–0.25) | "I have children": my ties leave through there | parents |
| One plate behind, a shade lighter, one step down-right | squad member | members |
| Two plates | squad lead | leads |
| Long-dashed outline (28 px, 72 % filled) | a session ORCA did not launch: in the fleet, not of the fleet | `origin: 'external'` |
| Perforation line in the bottom margin (y 0.09, under the text column) | `done`: the ticket has been used; the stub's tear line | finished |
| Hollow: outline and sigil, no body | `dead`, like the port that empties when its core drains | dead |

**Implementation.** One `iForm` attribute per instance: scale, plates (0–2),
topology bits (1 child · 2 parent · 4 external) and life (0 · 1 done · 2 dead).
The silhouette is a `shape(t, bk, tab)` function that the shader also samples
for the 2 px border and for the plates, so everything follows the same form.
The pixel is computed with the instance's scale, because a tray cell is the
same shader at 0.3.

The notch in the edge for `blocked` was discarded: the tile already inverts to
amber, and a second shape signal for the same thing would be noise on top of
the one thing that has to shout.

### 2.4 Blocks: the parent and the children that only talk to it

**Decision.** A child whose only interlocutor is its parent is not a node in
the graph: it is part of the parent. It folds into the parent's **block**: a
**tray** — a grid cell next to the parent's tile — with up to six cells and no
pipe between them. Parent and tray rest on a **slab**: a filled plane one step
lighter than the ground (`#141721`), with no outline. The slab says "one piece"
without adding a line to a field that already has the region's and the squad's;
the outline (lime) appears only when the block is selected. From afar, one
silhouette; up close, the callsign and status of each cell. A seventh child
opens a second tray.

**The cells grow according to how many there are** (`trayGrid`): a lone child
takes up almost the whole tray (scale 0.62), two go to 0.44, three or four to
0.42 in 2 × 2, five or six to 0.3 in 3 × 2. A single cell is not a speck in an
empty tray; its callsign becomes readable two zoom steps before the callsign of
six does. Its border is 1 px, not 2: at 2, the border would be most of the
cell.

**The block moves as one piece.** Dragging the parent or any cell drags parent,
trays and cells together. Only the parent gets pinned: the layout puts the tray
next to a pinned parent, and a pinned cell would become a tile again
(`blocks.ts`), so the block would burst in your hand. A click on a cell is
still a click on that cell.

**Air.** The squad outline leaves `SQUAD_PAD` (0.15) between the tiles and the
line; the slab leaves `BLOCK_PAD` (0.08). Both fit in the gutter (0.24) and are
different so that a block inside a squad shows two things and not one line
drawn twice. A frame flush against the tile's edge read as the tile's edge, and
a tile touching it read as spilling out.

**Who folds in** (`blocks.ts`, `absorbedChildren`):

- every Claude Code `Task` subagent (`Agent.subagent`, a new field the
  collector pulls from the transcript's `subagents/` path), always;
- a child launched by ORCA (`origin: 'orca'`) as long as its only traffic is
  with its parent. The first message to or from anyone else — or to a project,
  a squad or the fleet — takes it out of the block: it earns a tile and a pipe.
  It is a visible promotion: "this child now talks to the world".

**Never folds in:** a child blocked on a person (the amber has to show), one
with children of its own, one enlisted in a squad (the squad is its block), one
from another project, one whose parent is not in the field, or one the operator
pinned by hand. The deck folds nobody in: its order is the information.

**Implementation.** `layoutFleet` receives the child → parent map and inserts a
`tray` entry right behind the parent in lineage order; the tray inherits the
parent's squad for packing and follows the parent if the parent is pinned. Each
folded child has its `Spot` with `scale: 0.3` and `trayOf`, so selection,
windows and labels work the same. `tie()` does not draw the tie of a child that
is in its parent's tray, and its birth is a cell growing, not a core coming
down a pipe.

---

## 3. The squad: a tile of tiles

### 3.1 Notched outline

**Decision.** A squad has an outline: the 1 px `--line` line (one step lighter
than the region's, which is `--line-soft`) around the block of its members'
cells, with the **same notch as the tile** — a fixed 0.50 × 0.30 unit step in
the top-right corner, not proportional, because a wide block with a
proportional notch would look like something else. The squad is a tile made of
tiles and is drawn as one.

The label rests **on the top line**, 0.3 units from the left corner, with a
`--bezel` background, like a `fieldset` legend: the line passes underneath and
the label interrupts it. Under focus, the whole outline lights up when any
member is in the selection (`focusNear` includes squad mates).

**Implementation.** `pipes.add()` with the outline's polyline (nine points,
including the step), `thick 0.4`, `kind 'lineage'`, z −0.38 (above the region,
below the tiles). When the squad appears for the first time, the outline is
**drawn** from the lead's corner clockwise in `T.move` using the same filled
core from §4.2 (`fill` 0→1). No fade.

### 3.2 The label and its ladder

The label stops being two words and takes on three states depending on
`pxPerUnit`:

| ppu | What it shows |
|---|---|
| < 40 (tiles illegible) | the squad's **sigil** + **roster** |
| 40–120 | sigil + name + `n` + roster |
| ≥ 120 | + `LEAD K9` + the lead's mission on one line (max 48 chars) + `2 NEED YOU` in amber when it applies |

**The roster** is the new piece: a 6×6 px square per member, 2 px gap, in
`Squad.memberIds` order (lead first, with a 1 px ink frame), each in that
member's status color. It is the squad's pulse at any zoom: when the tiles are
specks, the roster still says "five working, one waiting on you". It changes by
**cut**, with the same heartbeat as the tile: the square that changes jumps to
`--ink-bright` for a frame and falls to its color in `T.snap`. Cap of 32
squares (`MAX_SQUAD_NAME` already limits the name; the roster limits the
width).

### 3.3 The squad's port

On the top line, 0.15 units from the left corner and before the label, a
**square port** (`pipes.port`, scale 1.3, `--ink-dim`). It is the point where a
`toSquad` message lands (today `squadAnchor` already returns that corner) and
where the **fan-out** (§5.3) leaves from. It lights up to ink while there is a
message in flight toward it and returns to `--ink-dim`.

### 3.4 What does not change

Packing (`squadOrder`, `packCells`) already makes contiguous blocks with the
lead in the first cell; the label is never hidden any more; the hub already
routes `scope:'squad'`. The design leans on that and does not touch it.

---

## 4. Pipes that mean something

### 4.1 Gutters

**Decision.** Every pipe lives in the grid's **gutters** — the `GAP_Y` between
rows and `GAP_X` between columns — and enters a tile only through a port on its
edge. Parent→child route:

1. leaves through the parent's bottom port (`x = P.x − 0.32`);
2. drops to the horizontal gutter under the parent
   (`y = P.y − TILE_H/2 − GAP_Y/2`);
3. runs to the vertical gutter **to the left of the child's column**
   (`x = C.x − TILE_W/2 − GAP_X/2`);
4. goes down it to the gutter above the child;
5. enters the child through its top port (`x = C.x − 0.32`).

Six points; two if the child is directly below. A child in the **same row**
enters from below (down, along the bottom gutter, up). Peer-to-peer messages
use the same grid: they leave through a side to the vertical gutter, run along
a horizontal one, and enter through a side. A tile **pinned by the operator**
has broken the grid on purpose: for it, the current
`routeLineage`/`routeMessage` are kept.

**Lanes.** A 0.26 gutter takes three 0.055 pipes at `−0.075 · 0 · +0.075`. The
lane is assigned by `hash(parentId) % 3` (messages: `hash(fromId)`), so one
parent's children share a bus and two families in the same gutter do not step
on each other. Crossings still exist; what no longer exists is a pipe over a
tile.

The router takes `gapX/gapY` from the `Layout` (field and deck have different
gaps) instead of constants; `layout.ts` exposes them.

### 4.2 Grey bus, lime core

**Decision.** Lineage is drawn as in the comp: a grey **bus** (`C_LINE`,
`thick 1.0`) and, inside it, a **core** (`thick 0.42`) that carries the lime.
The bus is structure: it exists from the moment the child exists and does not
change. The core is life: full lime if the child is `working`, lime at 55 % in
`thinking/booting/idle`, **absent** in `done/dead`. Lime stops meaning "there
is a pipe" and goes back to meaning "there is activity", which is what it means
on the tile.

The lead→member tie that today is painted the same as lineage is painted the
same here too; it is the same class of tie.

**Implementation.** New `PipeKind 'core'` (id 5). For it, `iMeta.y` stops being
age and becomes the **filled length** in world units; the fragment paints
`vAlong < iMeta.y`. `add()` returns the route's total length so the caller can
pass `fill · len`. `fill` is an animated scalar (§5).

### 4.3 NULL / ACTV ports

The ports are the comp's `NULL`/`ACTIVE` boxes without the word: **filled with
ink** when the core reaches them, **hollow** (a ring) when it does not. A
newly created child has its hollow port in its cell before it has a tile.

**Implementation.** A second instanced mesh `holes` of squares in `uBody` at
scale 0.5 on top of the port; `port(x, y, z, color, scale, sel, hollow)`.

### 4.4 Hierarchy of weights and colors

| Relation | Color | Weight | Motion | Visible from afar? |
|---|---|---|---|---|
| Region (outline) | `--line-soft` | 0.4 | — | yes |
| Squad (outline) | `--line` | 0.4 | drawn at birth | yes |
| Lineage, bus | `C_LINE` | 1.0 | slow dashes parent→child | only if it crosses a region or is long |
| Lineage, core | lime / lime 55 % | 0.42 | same dashes, in phase with the bus | same as the bus |
| Lead→member tie | same as lineage | 0.8 / 0.35 | same | same |
| open `ask` | amber | 1.0 | fast dash toward whoever owes | always |
| Peer-to-peer wait | blue | 1.0 | fast dash toward whoever owes | always |
| `notice` | blue | 0.7 | slow dashes; goes out in 60 s | only if it crosses a region or is long |
| Collision | red | 1.0 | dotted, **still** | always |
| Hot (selection) | full lime | 1.2 | — (solid) | always |

**Nothing structural is a solid line.** The bus and its core are dashes of
about 18 px drifting from parent to child at 40 px/s, at any zoom (the period
and the speed are computed in pixels, not in world units). An `ask` carries
longer and faster dashes, in amber, so the two motions never read as one. Only
the selection (`hot`), the outlines (`frame`) and the answer retracting stay
solid.

### 4.5 Zoom decides what is wiring and what is noise

**Decision.** From afar, the console shows **which squad talks to which**; up
close, **who hangs off whom**. With fifty agents and two hundred solid pipes in
view, neither of the two could be read.

Every segment carries a **span** (`span`, 0 → 1, `spanOf`): 1 if the pipe
leaves its region or covers more than `SPAN_FAR` (3.2) units; 0 if it joins
neighbors (less than `SPAN_NEAR`, 1.4); a smooth ramp in between. A tie that is
selected or under the cursor is always span 1: what the operator is looking at
is never detail.

Zoom comes in as `uLod` (`lodOf`): 0 when a tile is smaller than `LOD_FAR_PX`
(100 px), 1 from `LOD_NEAR_PX` (190 px, the `labels.ts` rung at which the tile
shows what it is doing). The alpha of a local `lineage`, `core` or `notice`
pipe is multiplied by `mix(uLod, 1, span)`. Ports have no alpha, so a local
port **grows** with zoom from nothing (`port(…, local)`) instead of appearing
all at once; YOU's ports and the squads' are always at full size.

What needs a person does not hide at any zoom: `ask`, `hot` and collision
ignore the span. Amber is still amber.

Amber stays reserved for what only a person can resolve; nothing
here touches that.

---

## 5. Motion: GSAP for the discrete, shader for the continuous

**Architecture.** Today the field animates with its own `anims` and a hand-made
`backOut`. It moves to `field/anim.ts`: a registry of `{ v }` scalars tweened
by GSAP with `T`/`EASE`/`dur()` from `motion.ts`, read by the RAF
(`anim.get('core:'+id)`). The shader keeps what has no end (breathing, speed
band, dashes); GSAP takes what has a beginning and an end. All three engines
still read a single contract.

### 5.1 Birth (A8 of the comp)

Today the tile appears over the parent and slides to its cell with the pipe
already in place. It becomes the comp's gesture:

1. the child's cell shows its **hollow port** in the same frame as the patch;
2. the **bus** appears whole (grey, cut);
3. the **core** grows from the parent's port to the child's in `T.move`,
   `EASE.inout`;
4. on arrival, the port fills and the **tile enters** with `back.out(2)` in
   `T.quick`, already in its cell.

A squad is born this way in a chain: the lead grows from its parent; each
member grows from the lead with the `beats(n)` offsets that `burstOffset`
already computes today. With five members that is four cores at 100 ms — half a
second, nothing — and then the fifth. With `prefers-reduced-motion`, everything
lands in the final state.

### 5.2 Dying and finishing

`dead`: the tile flashes red once and sinks (this already exists); the **core
drains** back toward the parent in `T.move` and the child's port is left
hollow. `done`: the same without the flash. The bus stays: the child existed.

### 5.3 Talking

- **Message to an agent.** The pulse stops being a square at constant speed:
  it is a lime **segment** of 0.35 units travelling the route with `EASE.inout`
  (duration `len / 9`, min. `T.quick`) leaving a trail that fades out in 0.6 s.
  Cut on arrival.
- **Message to a squad.** The pulse reaches the **squad's port** (§3.3), the
  port lights up, and from there `n` pulses leave for the members' top ports
  with `beats(n)` offsets: the **fan-out**. It is the picture of "I talked to
  the squad".
- **Answer to an `ask`.** When `m.answer` appears: the amber pipe **cuts to
  full lime for a frame** and drains from whoever asked toward whoever answered
  in `T.quick`; after that it does not exist. Never a fade.

### 5.4 The roster

Every square that changes state jumps to `--ink-bright` and falls to its color
in `T.snap`, in the same frame the tile does its flash. It is the same
heartbeat at another scale.

---

## 6. Micro-animations: every interaction has a gesture

**Rule.** Every operator interaction produces a gesture, and every gesture
comes from the comp's vocabulary. Durations only from `T`;
easings only from `EASE`; palettes cut, shapes ease; red is not animated;
nothing arrives at a constant rate; with `prefers-reduced-motion` everything
lands in the final state via `dur()`. A gesture that does not fit in a row of
this table does not get implemented.

### 6.1 Windows

| Moment | Gesture | Time |
|---|---|---|
| **Open** | The housing arrives from the point that opened it (tile, tray, command) with `back.out(2)`, scale 0.86→1, **no fade** (today there is `opacity 0→1`; out). In the same frame the anchor pipe to the tile **is drawn** from the tile to the window (core §4.2, `fill` 0→1). The header's callsign **assembles itself** out of pixels (A2): 3 frames of scrambled glyphs, then a cut to the real one. The body's sections **cascade in** (A1): each `.sec` appears by cut, `beats(n)` offsets compressed to 40 ms per step | housing `T.quick` · pipe `T.quick` · callsign 0.18 s · cascade ≤ 0.3 s |
| **Close (normal)** | Short collapse (A12): the body falls below the edge, the housing flattens into a 2 px bar and cuts. The anchor pipe **drains** back to the tile at the same time | `T.quick`, `EASE.inout` |
| **Close (answered / finished / dead)** | These already exist: lime `wipe`, pixel-by-pixel `check`, and for `dead` a cut to red and a collapse without the flash | unchanged |
| **Focus** | The line under the header (`.win__head::after`) **grows from left to right**; on losing focus, a cut | `T.snap` |
| **Fold to the tray** | The housing flies toward its tray tile (scaling down to 58×44, `EASE.inout`) and cuts; the tray tile **enters** with `back.out(2)` from scale 0.6 | `T.quick` + `T.snap` |
| **Unfold** | The inverse: the tray tile flattens into a bar and the window arrives from it | `T.quick` |
| **PIN** | The button cuts to lime; the anchor pipe is drawn (pin) or drains (unpin) | `T.quick` |
| **Drag / resize** | Direct, no tween: chrome that lags behind the hand feels broken. The anchor pipe follows every frame (already) | — |
| **Hex telemetry** | Scrambles every 70 ms **only while its agent is `working`** (A9); frozen in any other state | 70 ms |
| **Agent state changes** | The header does the same flash as the tile: it jumps to `--ink-bright` for a frame and falls to the status color | `T.snap` |

### 6.2 Controls

| Control | Gesture |
|---|---|
| `.btn` hover | Cut to lime (already). No transition |
| `.btn` press | `translate(1px, 1px)` while held down; cut |
| `.slab-btn` (lime) on confirm | Inverts to ink for a frame and back (`T.snap`): the comp's local flash. If the action takes a while (spawn, launch), the thin loading band (A3) runs along the slab's bottom edge until the ack |
| `kbd` | **Keyboard echo**: when the shortcut is pressed, its visible `kbd` cuts to lime and falls in `T.snap`. Applies to the mast, windows, tray, bookmarks |
| `pick` open | Arrives with `back.out` (already); the rows **cascade in** at 20 ms, by cut |
| `pick` choose | The chosen row jumps to ink for a frame and falls to lime; the menu cuts |
| `toggle` | Cut (already) + the thin band runs once across the 11 px tile in 120 ms |
| `fold` | `+`→`−` cut; body cuts (already). Unchanged |
| Inputs | Native. Caret untouched |

### 6.3 HUD

| Piece | Gesture |
|---|---|
| Command line: target change | The chip (`CAPCOM` → `@K9`) cuts to the new color and does a one-frame ink flash. `UNKNOWN` in red **is not animated** |
| Command line: send | The text is **wiped in lime** from left to right (A5 at line scale, `T.quick`) and empties by cut. The pulse in the field (§5.3) starts in the same frame |
| `/` menu | Rows cascade at 30 ms; the selection moves by cut |
| Tray: new tile | Arrives with `back.out(2)` from the window that spawned it, scale 0.6→1 |
| Tray: tile leaving | Flattens into a bar and cuts (short A12) |
| Tray: `` ` `` mode | The row **rises 4 px** in `T.snap` (the shape eases); the lime border cuts. Leaving: the inverse |
| Mast: counters | A number that changes scrambles for 3 frames (A9) and lands. `NEED YOU` going up: cut to amber + the `alarm.ts` ring (already) |
| Bookmarks: save | The cell cuts to lime with a frame of ink first |
| Minimap | Axis construction (A13) on open and a ring per `patch` (A14); already planned, unchanged |
| Cursor | Click: the 8 px square drops to 4 px and comes back in `T.snap`. Over a blocked target (amber tile, `is-blocked` window) the reticle cuts to amber |
| Region: hover | Border cuts to `--line` (already). Click: camera flight (already) |

### 6.4 Field

| Moment | Gesture |
|---|---|
| Tile selection | The lime line cuts (already) and **four 6 px corners** appear around the DOM label (`.lbl.is-sel::before/::after` + two `<i>`), by cut. Deselection: cut |
| Stepping up a rung | When the zoom crosses a `TIER_PX` upward, the new interior elements cascade in at 30 ms. Going down: cut |
| Lasso | A 1 px dashed lime rectangle while dragging (already); on release, the captured tiles do the heartbeat flash in the same frame |
| Birth / death / talking / answering | §5 |

---

## 7. File split

Six columns, disjoint. Nobody edits outside their own; whatever they need from
another column they consume through the signature written here.

| Col. | Files | What |
|---|---|---|
| **A** | `src/ui/gfx/sigil.ts` (new) · `src/ui/field/swarm.ts` | `sigilBits(seed): number` (15 bits, FNV-1a), `sigilHTML(bits: number, inverted?: boolean): string` (an `<i class="sigil">` with 25 `box-shadow`, 1 unit = `1em/5`), `CAPCOM_BITS`. In swarm: `iSigil`, `iAux` → vec4 (`.w` runtime id), sigil decoding, inverted lead, per-runtime stripe texture, permanent lime outline when `iAux.w == 9` (CAPCOM); delete `mark`. `write()` gains `sigil: number, runtime: number` at the end |
| **B** | `src/ui/field/labels.ts` · `src/ui/styles/field.css` | §0.3–0.7, §2, §6.4 (selection corners, cascade when stepping up a rung). CSS for `.sigil` and for `.squad`/`.roster` **no**: those live in `styles/squad.css` (D) and `styles/sigil.css` (A, imported from `main.ts` by Fable) |
| **C** | `src/ui/field/pipes.ts` · `src/ui/field/layout.ts` · `test/motion.test.ts` | `renderOrder` (−1 bus/core/ports, +1 pulses); `PipeKind 'core'` (id 5, `iMeta.y` = filled length); `add(...)` returns `number` (total length); `port(x, y, z, color, scale?, sel?, hollow?)`; `routeGutter(P, C, gaps: {x: number; y: number}, lane: -1|0|1): Pt[]` and `routeGutterMsg(A, B, gaps, lane)`; `pulse()` as a segment with a trail (§5.3). `Layout.gapX/gapY`. Property test: on a synthetic 6×4 grid, no route intersects any tile rectangle |
| **D** | `src/ui/field/field.ts` · `src/ui/field/anim.ts` (new) · `src/ui/styles/squad.css` (new) · `test/visual.ts` | `anim.ts`: `grow(key, {to, dur, ease})`, `drain(key, ...)`, `get(key): number`, `has`, `kill(key)`, `sweep(liveKeys)`. In field: outline + port + label with roster (§3), `buildPipes` bus/core/lanes (§4), birth/death/talking/fan-out/answer (§5), lasso-flash (§6.4); replace `anims`/`backOut`. New visual scenes |
| **E** | `src/ui/windows/wm.ts` · `src/ui/windows/fx.ts` · `src/ui/windows/kinds/*.ts` · `src/ui/styles/window.css` | All of §6.1 and §6.2 for `.btn`/`.slab-btn`/`kbd` inside windows. Sigil next to the callsign in `chrome()`, consuming `sigilHTML` from `gfx/sigil.ts` (signature above; if A has not landed yet, a local stub with the same signature, deleted on integration) |
| **F** | `src/ui/controls.ts` · `src/ui/hud/*.ts` · `src/ui/styles/hud.css` | §6.2 (`pick`, `toggle`, `kbd` echo in the mast) and all of §6.3 |
| **Fable** | `src/ui/main.ts` · `DESIGN.md` · integration | Imports of `sigil.css`/`squad.css`; rewrite **Tiles**, **Pipes**, add **Squads** and **Micro-interactions** to the contract; `npm run typecheck`, `npm test`, `npm run visual` at the end |

Signatures that cross columns, fixed here so nobody waits on anybody:

```ts
// gfx/sigil.ts (A) — consumed by E and D
export function sigilBits(seed: string): number;          // 0 … 2^15−1
export function sigilHTML(bits: number, inverted?: boolean): string;
export const CAPCOM_BITS: number;

// field/pipes.ts (C) — consumed by D
add(points, z, color, kind, age, thick?, sel?): number;   // total length
port(x, y, z, color, scale?, sel?, hollow?): void;
routeGutter(P: Pt, C: Pt, gaps: {x: number; y: number}, lane: -1 | 0 | 1): Pt[];
routeGutterMsg(A: Pt, B: Pt, gaps: {x: number; y: number}, lane: -1 | 0 | 1): Pt[];
type PipeKind = 'lineage' | 'notice' | 'ask' | 'collision' | 'hot' | 'core';

// field/layout.ts (C) — consumed by D
interface Layout { …; gapX: number; gapY: number }

// field/swarm.ts (A) — consumed by D
write(slot, x, y, z, scale, color, alert, speed, sel, alpha, seed,
      flash, focusAlpha, lead, sigil: number, runtime: number): void;
// runtime: 0 claude · 1 codex · 2 grok · 3 other · 9 capcom
```

## 8. Verification

- `npm run typecheck` and `npm test` green (includes the gutter test).
- `npm run visual`: the new scenes and the old ones with no regressions.
- `npm run stress`: 1,000 agents at 60 fps with bus+core (two `add` per lineage
  doubles the segments; capacity already grows by two).
- By eye, against the comp frames at 8.0 s and 10.5 s: the grey bus with the
  lime inside, the hollow and filled ports, no cable over a tile.
- The seven rows of §0, one by one, on the same 33-tile region and the same LL
  tile from the screenshots.
- Every row of §6, one by one, with `--headed`.
