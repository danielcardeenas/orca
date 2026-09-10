# ORCA — design contract

ORCA is a containment console for fleets of coding agents. Its language is the
Axolots `/system` boot comp, frame for frame: a near-black instrument, one lime
that means *live*, one red that means *breach*, unsmoothed pixel type, and CRT
treatment over the whole field. This file is the contract. Anything in the
console not described here is drift.

## Thesis

**There is no dashboard.** The whole viewport is the field: an infinite,
navigable space where every agent stands as an instrument tile, wired to the
agents it spawned, talks to, waits on, or collides with. Everything else —
an agent's interior, CAPCOM, the interrupt queue, telemetry, an artifact — is
a *window* the operator opens over the field, drags, pins to an agent, or
folds into the tray. The operator arranges the space; the space remembers.

The console does not compete for attention. Nothing animates to look alive.
The only thing allowed to demand a human is an agent that needs one, and it
arrives as an amber window snapping out of the tile that raised it.

**Refuses:** sidebars, rails, three-column layouts, tabs that swap the stage,
SaaS cards, soft shadows, gradients, decorative colour, emoji, any element that
exists because a dashboard usually has one.

## Palette

Colour is meaning. A colour without its meaning is a bug.

| Token | Value | Means |
|---|---|---|
| `--bezel` | `#0b0a0d` | the page, outside the instrument |
| `--shell` | `#141318` | the instrument housing (window chrome) |
| `--screen` | `#121116` | the glass (window body) |
| `--screen-in` | `#17161c` | a panel recessed into the glass |
| `--lime` | `#c0f94a` | **live, confirmed, working.** The only accent. |
| `--amber` | `#f5a524` | **a human is required.** Nothing else, ever. |
| `--st-thinking` | `#8fb8ff` | stalled, but not on you |
| `--red` | `#ff2a12` | **dead, or breach.** Never decoration. |
| `--auto` | `#b47cff` | **ORCA looking at itself.** The AUTOMEJORA section only. Never an agent state. |
| `--red-deep` | `#2a0504` | the field under a breach |
| `--xhair-gold` | `#c4a06a` | left-hand crosshairs |
| `--xhair-blue` | `#6a8cff` | right-hand crosshairs |

Ink: `--ink #e8e8ea` · `--ink-bright #f2f4f0` · `--ink-mid #c5cad3` ·
`--ink-dim #8b9088` · `--ink-dimmer #6a7068` · `--ink-faint #4a4e48`.
Structure: `--line #2a2e38` · `--line-soft #22252d` · `--tile #252a38` ·
`--pill-off #3a3a40` · off-slab `#c5c8cc`.

Agent states own a colour, shared by the tile shader, the labels, the window
chrome and the tray: `booting #6a8cff` · `thinking #8fb8ff` · `working #c0f94a`
· `blocked #f5a524` · `idle #6e736c` · `done #4a4e48` · `dead #ff2a12`.

**The amber discipline.** An agent waiting on *another agent* is blue. Only a
wait that terminates at a person is amber. An operator who learns that amber
sometimes means nothing stops looking.

## Type

**Tiny5** labels. Uppercase, `letter-spacing: 0.14em`, never smoothed.
**Geist Mono** is everything a machine wrote: paths, commands, log lines, what
an agent said. If a human would copy-paste it, it is mono. `.chroma` (the
comp's red/blue split) belongs only on titles and scrambled glyph fields.

## The field

The field is a WebGL plane the camera faces. Scrolling pans it; zoom is a
deliberate gesture, ⌘/Ctrl+scroll or a pinch, toward the cursor. It pans in
X/Y and dollies in Z;
a **tilt** (key `O`) unlocks a pitch for looking at the fleet's shape, and
locks back for working. Facing the plane is the rule because text, images and
video are read head-on; an orbiting camera turns all three into mush.

Every tile stands on the plane. Depth once carried attention — blocked agents
rode forward, dead ones sank back — but under a perspective camera that is
parallax, and a fleet that slides over its islands while you pan reads as
loose, not as ranked. State lives on the tile itself: its edge, its colour,
its halo. The tilt still shows the fleet's shape, flat.

**Tiles.** An agent is the comp's notched tile — a rectangle with a bite out of
its right edge — drawn by one instanced shader. Its state rides the left edge;
a working tile carries a travelling band whose speed is tokens/sec; a blocked
tile inverts to amber and breathes on a 2.2s cycle; a dead tile is a red ghost.
Two marks that are not text ride on it. The **sigil**, a 5×5 pixel glyph in
the top-right corner clear of the bite, says *who*: fifteen bits hashed from
the agent's id, or from its squad's name so a squad wears one patch and its
lead wears it inverted; CAPCOM wears the C of the wordmark and a permanent
lime line. The **stripe texture** says which runtime: solid Claude, dashed
Codex, dotted Grok. An AUTOMEJORA reviewer keeps its runtime's stripe and its
state's edge, and adds a permanent violet outline and a violet sigil. Text is DOM, laid over the tile as three bands that avoid
the stripe, the bite and the band, and climbs a ladder with the tile's width:
callsign and project at 44px, mission at 112, what it is doing now at 190,
the numbers at 320, runtime · model · machine and the status pill at 520.

**Pipes.** Relationships are the comp's tree: thick orthogonal pipes with square
ports at each end, running only in the gutters between tiles — never across
one. Lineage is a grey **bus** with a lime **core** inside it: the bus exists
while the child exists, the core carries the child's life (full lime working,
dimmer alive, drained when done or dead). A port is filled when the core has
reached it and hollow when it has not — the comp's ACTIVE and NULL. An `ask`
is an amber pipe with a travelling dash toward whoever owes the answer. A
`notice` is a blue pipe that fades over a minute. A file collision is a red
dotted pipe that does not move. A message in flight is a lime segment that
runs the pipe once, eased, and leaves a short trail.

**Squads.** A squad is a tile of tiles: its members pack into one block
inside their region, lead first, under a 1px outline with the tile's own
notch at the top-right corner. The rótulo sits on the top edge like a
fieldset's legend and carries the squad's sigil, its name and count, and the
**roster** — one small square per member, lit by state, lead framed — so a
squad's pulse is readable when its tiles are specks. A port on the top edge
is where a message to the squad lands before fanning out to its members.

**Regions.** Projects are clusters on a phyllotaxis spiral, so adding one never
moves another. Each region carries a thin `--line` outline and a label that
fades as the tiles become readable. Children are packed beside their parent so
lineage pipes stay short.

**Placement.** Drag a tile and it stays where you put it, across reloads and
across machines. The operator's arrangement always beats the automatic one.

**Media.** An artifact pulled into the field is a real image or video quad next
to the agent that made it, or a sandboxed HTML surface projected over the
canvas. Work appears where you are, not as a path in a log.

**Ground.** The panel itself: a matrix of RGB subpixels seen through a macro
lens — three dim stripes per cell on a black mask, a faint light from the
top-left, the edges going soft and dark, a few driven blocks brighter than
the rest. One shader in world space, with the cell pitch stepping by powers
of two so a cell always spans 12–24 screen pixels and two octaves cross-fade
across each step. It is what makes the canvas a surface rather than a void,
and the motion cue when the camera pans. Nothing on it moves by itself.

## Windows

A window is a small instrument in the comp's HUD shell: shell housing, glass
body, gold crosshair top-left, blue crosshair bottom-right, a tele line of
scrambled hex top-right, a stamp bottom-left. Header: callsign or kind in
Tiny5, then `FRONT` (or `CANVAS`), `PIN` when in front, `—` and `×`. Radius `--r-panel 10px` on the housing, `2px` on
everything inside.

Windows **open in front**: beside their source, screen-fixed and at reading
size, whatever zoom the camera is at. A window that arrived at the camera's
scale arrived unreadable — from any ordinary zoom the housing was a stamp, and
the operator had to fly in to read what they had just asked for. Every window
still knows its place on the **canvas** from the moment it opens, at remembered
world coordinates, so `CANVAS` drops it beside its tile rather than wherever
the glass happened to hold it. A canvas window moves and scales with the
camera and uses a fixed world scale (320 layout pixels per world unit),
independent of the opening zoom. An agent's window keeps its pipe to the tile
in every mode — the line says whose window this is, and that does not stop
being true because the housing is on the glass. It is drawn whenever the tile
is in front of the camera, on screen or not: a pipe running off the edge is
what says where a canvas window came from once a zoom or a pan has lost its
tile. Clicking an agent opens its window; the next click closes it. A
native double-click does not add a third opening after those two activations.
Drag the header to arrange the workspace,
the corner to resize. A canvas window has no far rendering: no compact card,
no fade, no threshold at which it changes. From afar it is the housing, small,
at the camera's scale, and zooming in makes it bigger — nothing else happens.
It scales with the canvas, without inverse zoom compensation or a minimum
screen size. Below reading scale (camera scale under 0.55) the window is a
stamp: too small to work in, only to move, so a press-and-drag anywhere on it,
body included, drags it, and the body takes no pointer. A still press on a
stamp does nothing; the tray or the zoom brings it up to reading size. The
tray remains the persistent way to find open windows.

`FRONT` brings a window to a readable, screen-fixed size. `CANVAS` returns it
to its saved world position; `Esc` also returns a foreground window. `PIN`
keeps a foreground window fixed to the screen. The global HUD and pending
interrupt count stay above the canvas windows. Mobile retains full-size sheets.

The existing **tray** remains the control for every open window. It identifies
`canvas`, `front`, `fixed` and `folded` windows. Clicking retrieves a window
from anywhere; clicking the visible active window minimizes it. Retrieval
preserves canvas/front/fixed mode. For a distant canvas window the camera flies
to the window bounds at reading size, keeping space for the mast and dock. Closing is explicit (`×` or the tray's
close command); `—` folds into the tray. Persistent window sessions remember
world position and mode. Ephemeral agent/interrupt sessions are not reopened
automatically after reload.

Kinds: `agent` · `interrupt` · `queue` · `capcom` · `mission` · `feed` · `fleet`
(a project, a machine, or a lasso selection) · `spawn` · `launch` · `artifact` ·
`gallery` · `timeline` · `breach` · `help`. `capcom` is the transcript of the
command session; the human talks to it, it talks to the fleet.

**No window draws a second field.** A `mission` answers who is on it with a
list — project, squad, members, the lead's mark inverted, every row wearing the
same sigil its tile does — and answers *where* by acting on the real field:
select the crew, frame it, focus, `Backspace` to come back. A map inside a
window would be a second truth about where an agent stands, and the small one
would always be the worse of the two. Lists and glyphs in windows; the field
is the field.

An `interrupt` window opens itself, anchored to the agent, when an escalation
lands; it carries the question, what CAPCOM tried, one-tap options, free
text, `REMEMBER`, and `UNBLOCKS n`. Answering wipes it lime and closes it.
Only what arrives while you are looking opens itself, three at a time and
only if its tile is on screen; a backlog never floods the field, it waits in
the queue with a count on the mast.

## AUTOMEJORA

Everything else on the field reports the **fleet**. One section reports the
**instrument**: how ORCA and CAPCOM are actually being used, what gets in the
way, and what could be better. It is a section of its own, top right under the
mast, and it looks like one — because a proposal about the console read in the
mission panel's dress would pass for an agent's work.

**Its own colour.** `--auto`, a violet that exists nowhere else in ORCA. Every
other colour here means an agent: lime live, amber *a person is required*, red
breach, cyan CAPCOM, blue waiting on a peer. None of them could be borrowed
without lying — least of all amber, which means a stopped agent needs an answer
now, and a proposal stops nobody. A new hue used in exactly one place is what
keeps that discipline intact.

**Its own shape.** Missions are the boot's ALGN rows. These are cards with the
tile's bite taken out of the *opposite* corner — top-left — and a bar down the
left edge. The bar is **solid** when the proposal rests on measurements and
**dashed** when it is a hypothesis: the texture says what the idea is made of
before the label does, the way a tile's stripe says which runtime is inside.

**What a card says, in the order a decision gets made.** Folded: area, whether
it is measured or a hypothesis, the title, two lines of summary, and impact and
effort as two three-cell meters — shown *only* when the review had grounds to
estimate them, because an invented estimate is worse than none. Open: the
evidence (figures, quoted), the hypothesis when the idea did not come from a
measurement, the long detail, the question it asks the operator, and the whole
conversation.

**Its own notification, once.** A new proposal shows a count on the head, a
violet dot on its corner, one sideways step of the section and one sound. None
of it repeats for that proposal, ever — re-raising the same idea bumps a
counter and stays quiet. It is off once the card is opened, which is when it
was actually read. Nothing here opens itself: the only thing in ORCA allowed to
demand a human is a stopped agent.

**Its cost, on the face of it.** The status line says why no review is due yet —
`NEXT IN 3H`, `WAITING FOR SIGNAL · 12/40`, `CAPCOM IS MID-TURN` — never a
generic. Beside it, `REVIEW NOW`, `PAUSE`, and `SETUP` for the three limits
(how often, how many a day, how much new signal is worth a turn). A periodic
review the operator cannot see, stop or space out is a bill they do not control.

**A review is an agent, not a turn.** Each pass is a temporary **reviewer**
that ORCA launches down the ordinary spawn path: it stands on the field with a
callsign, a state and a spend like anything else, it reads, it files what it
proposes, and it ends. It wears a **permanent violet outline** and a violet
sigil — the same move as CAPCOM's cyan line, and for the same reason: there is
a kind of session here that is not doing the fleet's work, and it says so at
any zoom. The violet is an **identity, never a state**: the body colour and the
left edge keep saying what the agent is actually doing, so a reviewer that is
blocked is amber inside a violet frame and one that died is red. The section's
status row carries it live — callsign, real state, minutes in, tokens spent of
the ceiling it was given — with one button that flies to it and one that stops
it. An open proposal names the reviewer that wrote it, and that name is a way
back to the work.

**It proposes; the operator decides.** The reviewer has no edit tools —
removed at launch, not asked for in prose — so the only thing that turns a
proposal into work is `IMPLEMENT`, which opens an ordinary mission with
the proposal inside and links the two. FORGE leads that mission using the
existing crew, conversation and blocker views; CAPCOM retains final review,
closure and publication. A proposal that is already a mission
cannot become a second one. `⌥I` and `/improve` bring the section forward; on a
phone the section bar does (`docs/MISSIONS.md`). See `docs/AUTOMEJORA.md`.

**FORGE on the field.** Its real `forge-*` squad lead stands outside the project
outline, close to ORCA's right edge and apart from CAPCOM, at CAPCOM's tile scale,
with a permanent FORGE label naming the lead
and observed activity. Existing lineage and squad pipes connect its workers.
A violet affiliation pipe connects the project perimeter to the lead, and
multiple instances keep vertical clearance for their labels and tiles.
The active mission gives it the reviewer's violet identity; state and runtime
keep their own marks. There is one tile per real lead, no synthetic agent or
second lifecycle. Deck mode and operator placements retain their usual rules.

## The command line

One input, bottom centre, always there. Plain text talks to CAPCOM.
`@K9 …` talks to an agent. `@LZ …` talks to every agent in a project.
`/spawn`, `/find K9`, `/frame`, `/queue`, `/ceo`, `/feed`, `/fleet`,
`/tilt`. A lasso selection becomes the target chip on the line, and `Enter`
sends to all of them. `/` focuses it from anywhere; `Esc` returns to the field.

## Focus, beat, and the human node

**Focus.** Holding `Space` with a selection drops everything the selection
does not touch to 12 %: the selected tiles stay at 1, the agents at the far
end of their pipes at 0.45. Focus answers "who does this talk to", not "where
is this". With nothing selected it does nothing but say so.

**The beat.** A tile that changes state snaps to its state colour and decays
in 120 ms. Every tile in the same patch beats together, without stagger — the
video's tiles light in irregular groups, never in a wave. A fleet of a
thousand beating at once is a fact, not an effect.

**The amber discipline, enforced.** Full amber with glow and breath is only
for an agent whose question you can answer from this console. A permission
prompt that must be answered in a terminal keeps an amber edge and a dark
body: it is yours, but not here.

**YOU.** Each region has a human node at its top-right corner, `YOU · n`,
shown only while `n > 0`. Every agent waiting on a person runs an amber pipe
into it; a peer wait runs blue to the agent it waits on. The inverted V that
converges on YOU is what `UNBLOCKS n` looks like.

## Navigation

**Keyboard discipline.** Single letters are never global openers; that is how
a keyboard saturates. With a window active, the window owns the keyboard:
every button wears a `kbd` with its letter (`S` say, `X` stop, `1…9` the
options of an interrupt), `Esc` closes, `-` folds, `` ` `` cycles the stack,
`V` reveals an anchored window whose tile is off-screen. Chords work anywhere:
`⌘K` the command line, `⌥` + letter opens a window (`⌥C` CAPCOM, `⌥Q` queue,
`⌥F` feed, `⌥E` fleet, `⌥N` spawn, `⌥L` launch, `⌥G` gallery, `⌥T` time,
`⌥M` music, `⌥S` sound), `⌥1…9` fly to a bookmark, `⌥⇧1…9` set one. The
field keeps its own single keys only while no window is active: `F` frame,
`O` tilt, `Z` fullscreen, `D` deck, `M` minimap, `Space` focus, `Tab` next agent that needs
you. `Backspace` returns to the view before the last flight. The stack is
the tray: open windows as notched tiles, the active one lime, then the folded
ones; `` ` `` enters tray mode to walk them with the arrows and close with
`Backspace`. The minimap (`M`) is the radar: regions, agents as
dots, the viewport as a lime rectangle you can drag. Programmed flights push
history; hand panning never does.

## Launch, gallery, time

`/launch <preset>` fires a saved fleet and the window becomes the comp's ALGN
modal: rows in flush, into the staircase, one zipper per agent as its spawn
is acknowledged, back to flush, collapse. A failed spawn turns its row red and
the window stays. `G` opens the gallery of everything the fleet has made;
drag a thumbnail onto the field to place it. An image or a video from the
desktop dropped on the field stays there, where it was let go, as a surface
like a placed artifact. Any other file dropped on a tile, on the ground, or
into a message box lands on the hub's disk and its path lands in the
composer, as it would in a terminal; nothing is sent until the operator says
what to do with it. `T` opens the last 24 hours:
scrub, and the field draws that instant while the mast says `REPLAY · hh:mm`;
below, what happened while you were away.

## Sound

Samples, not synthesis. Four words, and they are not the same word.

An **event** is something the console did — there are 47 of them, `SoundName`
in `src/ui/hud/sound.ts`, in five groups. A **clip** is one audio file; a pack
has 32, because siblings share: the five windows that open a list of rows all
ring `open.list`, the five that open a tool all ring `open.tool`, a deck tick
and a replay step are the same tap. `CLIP_OF` owns that mapping and it is the
same in every pack. A **pack** is one voice for all 32 clips. A **preset** is
a pack plus per-event overrides.

### The five packs

Made by `tools/sfx-gen.mjs` with ElevenLabs Sound Effects v2 through fal.ai,
0.5–1.4 s each, into `public/sfx/packs/<pack>/<clip>.mp3` with a manifest
beside them and `packs/index.json` over all of it. A prompt is
`<pack style> <what the gesture is> <pack materials> <the shared line below>`:
the gesture is written once, in neutral terms, so an event reads as the same
event in all four voices, and the style is what makes a pack a pack.

| Pack | The voice |
|---|---|
| `cinema` | High-budget film UI. Glass and air over a soft sub transient, a short tail with minimal reverb. Designed, restrained, never a beep. |
| `mac` | A modern Apple system sound made richer: round warm marimba and struck-glass notes, gently rounded attack, brief, groovy. |
| `capcom` | Mission control with the radio switched off. Pure tones of the Quindar family, a relay far away in the rack, tape barely audible. No static, no squelch. |
| `mechanical` | Small switches, relays, keycaps, latches and spring detents, recorded very close and very soft. Nothing tonal, only a thing a hand moved. |
| `legacy` | Not generated: the eight original takes and the eleven cuts of the reference film, with the film's score still under them. Kept to be heard, not recommended. |

Every clip is a micro-sound meant to be played over ambient music, so every
prompt ends with the same line, word for word:

> `no 8-bit, no chiptune, no retro game console, no voice, no words, no speech,
> rich layered micro-sound, soft transient, short decay, sits under ambient
> music, mono, no music`

`prompt_influence` is 0.6 so the model actually honours it, and everything is
0.5 s — the API's floor — except the three that are events rather than
touches: `breach` (1.4), `launch` (1.2), `deck.enter` (0.9).

`--dry-run` prints every prompt and the bill before a byte is spent; `--check`
holds the generator's clip table and `CLIP_OF` against each other **and fails
the whole set if any prompt reaches for an arcade, a radio operator or a
talking machine**; a clip already on disk is skipped unless `--force`, so a
rerun after a failure is free.

### The events

| Group | Events |
|---|---|
| FLEET | `interrupt` `answer` `spawn` `launch` `squad` `dead` `breach` `link` `artifact` `placed` |
| WINDOWS | `open.agent` `open.interrupt` `open.queue` `open.capcom` `open.feed` `open.fleet` `open.spawn` `open.launch` `open.artifact` `open.gallery` `open.timeline` `open.sfx` `open.help` `open.music` `close` `fold` `unfold` `wipe` `check` |
| NAVIGATION | `bookmark.save` `bookmark.go` `back` `frame` `tilt.on` `tilt.off` `focus.on` `focus.off` `lasso` `select` |
| DECK | `deck.enter` `deck.exit` `deck.sort` `deck.settle` `deck.tick` |
| REPLAY | `replay.enter` `replay.exit` `replay.step` |

Seven of them the console rings itself, from the store: `interrupt` when the
alarm comes on, `answer` when an escalation is answered, `spawn` when one or
two agents are born in a patch and `squad` when three or more are, `dead`,
`link`/`breach`, and `artifact` when one appears. Everything else is a gesture
the console made rather than a fact the world reported, so its caller rings
it — `getSound()?.play('deck.enter')`. `play()` takes any string and a name no
pack answers is silence, never a throw: a caller may ring the future.

### Where the callers ring it

| Event | Where | What fires it |
|---|---|---|
| `open.*` | `main.ts` — the wm's `onFocus` | `getSound()?.play(openSoundFor(w.spec.kind))` on a window's first focus. `OPEN_OF_KIND` in `sound.ts` is the kind → event table. |
| `close` | `wm.ts` — `close()` | a window actually leaving; `closeWith` rings its own gesture instead |
| `fold` / `unfold` | `wm.ts` — `minimize()` / `restore()` | the tray |
| `wipe` / `check` | `wm.ts` — `closeWith()` | the two confirmations, before the sweep starts |
| `launch` | `command.ts` — `/launch <preset>` | already wired |
| `placed` | `main.ts` — `placeArtifact()` | after `field.placeNear` |
| `capcom.thinking` | `sound.ts` — observed CAPCOM activity via `capcomOf` / `capcomFeedback` | Opt-in, at most once per recent outgoing message (30 s), ten seconds apart. Activity only: never receipt, delivery or a finished reply. Snapshots and reconnections establish a silent baseline. |
| `bookmark.save` / `bookmark.go` / `back` | `bookmarks.ts` — `save()` / `go()` / `back()` | rung on the branch that succeeded |
| `frame` | `main.ts` — the `F` key and the selbar's FRAME | before `field.frameAll()` |
| `tilt.on` / `tilt.off` | `main.ts` — the `O` key | on the value it sets |
| `focus.on` / `focus.off` | `main.ts` — Space down / up | `focus.on` only when `setFocus(true)` returned true |
| `lasso` / `select` | `field.ts` — the pointerup that ends a lasso, and `onSelect` | `lasso` for the rectangle, `select` for a tile picked |
| `deck.enter` / `deck.exit` / `deck.sort` | `main.ts` — `c.deck()` | on the branch each takes |
| `deck.tick` / `deck.settle` | `field.ts` — where `holdUntil.delete(s.id)` releases a tile, and the frame the map empties on | the coalescer holds ticks to six a second and eight a slide |
| `replay.enter` / `replay.exit` | `main.ts` — `setReplay()` | `entering`, and the null branch |
| `replay.step` | `timeline.ts` — `scrubTo()` | each step of the scrubber |

### Presets

Five from the factory are just their pack. `mixed` is the argument that the
console does not have one voice but four instruments: CINEMA for the fleet,
MAC for the windows, MECHANICAL for the way you move around, CAPCOM for the
deck and the past. An override is `"clip"` (in the current pack) or `"pack:clip"`
(anywhere), which is the whole of what makes `mixed` possible — and what lets
the operator build one by hand, row by row, and press SAVE PRESET.

Resolution, in order, ending in silence rather than in a throw:

    the event's override → the current pack's clip for that event → nothing.

Persisted: `orca.sfx.pack.v2`, `orca.sfx.map.v2` (overrides),
`orca.sfx.presets.v1` (the operator's), `orca.sfx.preset.v2` (which one is in
force), `orca.sfx.vol.v1`, `orca.sound.muted`. The `v2` keys are what retires
a pack cleanly; a stored pack the index no longer lists falls back to the
default rather than going silent.

### How loud, how often

Muted until `S`, master at 0.8 in ten steps, decoded lazily on first use — a
muted console has spent nothing on 160 files — and a per-play gain that varies
±1 dB so two blips in a row are not the same blip. No pitch shifting, never a
loop.

One sound of a kind per 400 ms, three per second in total. The deck's arrival
is the exception: `deck.tick` and `replay.step` may fire six times a second,
at most eight per slide, and they do not spend the global budget. 250 ms of
quiet starts a new slide. `prefers-reduced-motion` is about motion, not audio,
and silences nothing.

CAPCOM activity has its own persisted level (`orca.sfx.capcom-thinking.vol.v1`),
off at zero by default, also subject to master level and mute. Its existing
`tick` is capped at 180 ms with a 12 ms attack and fade to zero at 160 ms;
peak gain is a quarter of the selected relative level. No loop or replay.
Loss of confirmed activity, ready/error/waiting states, disconnection, hidden
tab, mute and disposal cancel active or pending cues. Decode older than one
second is discarded. Audio supplements the existing visual status; reduced
motion does not substitute for the explicit sound preference.

### The window

`S` mutes; the SFX window is where the voice is chosen. PRESET, PACK, the
ten-step master and the mute at the top, with SAVE PRESET, DELETE and RESET.
Then the 47 events under a Tiny5 header per group, each with the clip that
answers it and a `▶`. Then the packs, one row each, with a sample of
`open.agent` and how many of the 32 they have. Auditioning ignores the mute: a
`▶` is the operator asking, not the console speaking.

## Motion

| Token | Value | For |
|---|---|---|
| `--t-snap` | `0.12s` | a state flip |
| `--t-quick` | `0.28s` | a window arriving |
| `--t-move` | `0.55s` | a wipe or a fill |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | arrivals |
| `--ease-inout` | `cubic-bezier(.65,0,.35,1)` | wipes |

- One contract for three engines. `src/ui/motion.ts` owns every duration
  and easing; CSS reads them as custom properties, GSAP as defaults, the
  shaders as uniforms. Shapes ease, palettes cut. Nothing arrives at a
  constant rhythm: `beats(n)` gives the video's 4-2-3-5-2-6.
- Instruments snap, they do not cross-fade. A window arrives with
  `back.out(2)` at 0.22s from the point it was opened at. Answering an
  interrupt wipes it lime, left to right, and cuts. An agent finishing draws
  the check pixel by pixel and collapses.
- A spawn is the comp's tree lighting: the child's hollow port appears in
  its cell, the bus cuts in, the lime core grows from the parent's port to
  the child's over `--t-move`, and only then does the tile arrive with
  `back.out(2)`. A squad's members grow from its lead on `beats(n)`. A dying
  tile flashes red once and sinks; its core drains back to the parent.
- Every interaction has a gesture and every gesture is from the comp
  (`docs/IDENTITY.md` §6): a window arrives without a fade, its anchor pipe
  traces itself, its callsign assembles from pixels, its sections cascade;
  a plain close collapses to a bar; folding flies to the tray tile; the
  header underline grows on focus; a confirming slab inverts one frame; a
  chord echoes on its `kbd`; the command line wipes lime on send; a counter
  scrambles three frames before landing; the cursor pinches on click and
  turns amber over a block. Red never animates.
- Camera flights ease; panning and zooming are direct, because a canvas that
  lags the hand feels broken.
- Activity bands report speed, never progress. An agent has no percentage.
- Nothing animates for attention except a blocked tile and its window.
- `prefers-reduced-motion` removes scanlines, breathing, bands and flights.

## Field treatment

Fixed layers over the whole viewport, in order: grain (`z 78`, `.04`) ·
vignette (`z 79`) · scanlines (`z 80`, 2px/3px, multiply, `.55`) · cursor
(`z 95`, 8px difference-blend square, opening to a reticle over anything
live). Four crosshairs at the viewport corners: gold left, blue right. The
native cursor is hidden everywhere except text inputs.

## Boot

The comp compressed to ~9s, skippable, every line real: POST → wordmark and
load bar → handshake glyphs → check → align deck → SYNC staircase → radar →
FLEET ONLINE. The staircase-then-zipper move on the SYNC rows is preserved
exactly. The radar's dot grid becomes the field's ground; the boot does not
cut to the console, the console is what the radar was looking at.

## Verification

`npm run visual` photographs the boot along its timeline and every console
state into `test/shots/`. `npm run stress` injects synthetic fleets from 24 to
3,000 agents and reports frame time and draw calls. A visual change nobody
looked at in those frames is not finished.
