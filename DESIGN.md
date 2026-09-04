# ORCA — design system

ORCA is a containment console for a fleet of coding agents. Its visual language
is a direct replica of the Axolots `/system` boot comp: a near-black instrument
bezel, one lime that means *live*, one red that means *breach*, unsmoothed pixel
type, and CRT treatment over the whole field.

This file is the contract. Anything in the console that is not described here is
drift, not design.

## Thesis

The operator is watching a system that is already running. Nothing in the
console competes for attention except an agent that needs a human. Every
rectangle is an instrument; nothing is a marketing card.

**Refuses:** SaaS dashboard chrome, soft drop shadows, friendly rounded cards,
gradients, decorative colour, emoji, illustration, any animation that exists to
look alive rather than to report something.

## Palette

Colour carries meaning here. If a colour appears without its meaning, that is a
bug.

| Token | Value | Means |
|---|---|---|
| `--bezel` | `#0b0a0d` | the page, outside the instrument |
| `--shell` | `#141318` | the instrument housing |
| `--screen` | `#121116` | the glass |
| `--screen-in` | `#17161c` | a panel recessed into the glass |
| `--lime` | `#c0f94a` | **live, confirmed, working.** The only accent. |
| `--amber` | `#f5a524` | **a human is required.** Nothing else, ever. |
| `--red` | `#ff2a12` | **dead, or breach.** Never decoration. |
| `--red-deep` | `#2a0504` | the field under a breach |
| `--xhair-gold` | `#c4a06a` | left-hand crosshairs |
| `--xhair-blue` | `#6a8cff` | right-hand crosshairs |

Ink ramp: `--ink #e8e8ea` · `--ink-bright #f2f4f0` · `--ink-mid #c5cad3` ·
`--ink-dim #8b9088` · `--ink-dimmer #6a7068` · `--ink-faint #4a4e48`.

Structure: `--line #2a2e38` · `--line-soft #22252d` · `--tile #252a38` ·
`--pill-off #3a3a40`.

Agent states each own a colour, shared by the deck and the 3D scene:
`booting #6a8cff` · `thinking #8fb8ff` · `working #c0f94a` · `blocked #f5a524` ·
`idle #6e736c` · `done #4a4e48` · `dead #ff2a12`.

## Type

Two families, and the split is semantic, not aesthetic.

**Tiny5** — everything that *labels*. Uppercase, `letter-spacing: 0.14em`,
`-webkit-font-smoothing: none`. Smoothing this font destroys the pixel grid.

Ramp: `--tiny 10px` · `--dim 11px` · `--sm 12px` · `--md 14px` · `--card 18px` ·
`--title clamp(22–36px)` · `--cta clamp(14–20px)` · `--banner clamp(18–32px)` ·
`--huge clamp(42–84px)`.

**Geist Mono** (`.mono`, 11px, lowercase permitted) — everything a machine
wrote: log lines, commands, file paths, agent titles, conversation text. If a
human would copy-paste it, it is mono.

`.chroma` adds the comp's chromatic split —
`1px 0 0 rgba(255,60,80,.45), -1px 0 0 rgba(60,180,255,.45)` — and belongs only
on titles and scrambled glyph fields.

## Geometry

Radii: `--r-shell 28px` (the instrument housing) · `--r-screen 18px` (the glass)
· `--r-panel 10px` (a lime slab) · `--r-chip 3px`. Everything else is `2px` or
square. A rounded corner larger than 3px on a data element is wrong.

Borders are `1px solid var(--line)`. Agent tiles carry their state on a `2px`
left edge so a column of them is scannable without reading.

The signature shape is `.tile`: a rectangle with a notch bitten out of its right
edge, cut with a percentage `clip-path`. It must stay roughly square — a
stretched tile turns the bite into a wedge.

## Motion

| Token | Value | For |
|---|---|---|
| `--t-snap` | `0.12s` | a state flip |
| `--t-quick` | `0.28s` | a panel arriving |
| `--t-move` | `0.55s` | a wipe or a fill |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | arrivals |
| `--ease-inout` | `cubic-bezier(.65,0,.35,1)` | wipes |

Rules taken from the comp and kept:

- **Instruments snap, they do not cross-fade.** A tile arrives with
  `back.out(2)` at 0.22s. It does not fade in.
- **A fill grows from where it starts.** The ALGN zipper grows from centre out;
  the load bar from the left; the confirm wipe from the left.
- **Growth is straight.** In the 3D scene the ribbons travel laterally and never
  pump their height, because a pumping height reads as data changing.
- **Nothing animates for attention except a blocked agent.** That tile inverts
  to amber and breathes on a 2.2s cycle. One exception, deliberately.
- **Activity bars report speed, never progress.** They are travelling bands with
  no end state, because an agent has no percentage complete and pretending
  otherwise is a lie the operator will act on.

`prefers-reduced-motion` removes the scanlines, the breathing, and the travelling
bands; every state remains legible as a static colour.

## Field treatment

Four fixed layers sit over the whole console, in this order:
grain (`z 78`, opacity `.04`) · vignette (`z 79`,
`inset 0 0 120px 40px var(--bezel)`) · scanlines (`z 80`, 2px/3px repeating,
`mix-blend-mode: multiply`, opacity `.55`) · cursor (`z 95`, 8px, difference
blend, opening to a 22px reticle over anything interactive).

The native cursor is hidden everywhere except text inputs.

## The boot sequence

A compression of the comp, ~12s, skippable, and every line of it reports real
state. Beats: POST → wordmark + load bar → handshake glyphs → check square →
align deck → ALGN staircase → radar sweep → FLEET ONLINE.

The ALGN staircase is the signature move and must be preserved exactly: rows
appear flush, separate into a staircase (each lower row inset further on both
sides), the zipper grows from the centre outward, then they rejoin flush. No
zoom on the way out.

## Layout

```
┌──────────────────────────────────────────────┐
│ MASTHEAD   wordmark · link · gauges · view   │  46px
├──────────┬────────────────────┬──────────────┤
│ RAIL     │ STAGE              │ SIDE         │
│ machines │ deck 2D | fleet 3D │ CEO          │
│ projects │                    │ interrupts   │
├──────────┴────────────────────┴──────────────┤
│ FEED  telemetry, scrolling                   │  30px
└──────────────────────────────────────────────┘
```

232px / 1fr / 340px. Below 940px the rail and side collapse; the interrupt queue
is the whole product on a phone.

## The 3D scene

Same palette, same states, no new vocabulary. A project is a platform outlined
like an instrument face; an agent is a ribbon standing on it.

- `working` — travels wide, amplitude scales with tokens/sec
- `thinking` — contracts, pulses from inside, barely moves
- `blocked` — **stops dead** and goes amber. Stillness inside a moving field is
  the loudest signal available and it costs no colour.
- `idle` — a slow drift
- `dead` — collapses to the platform, red
- ribbon **width** is spend; **height** is uptime; a curve from parent to child
  is lineage

## Verification

`npx tsx test/visual.ts` writes the whole console to `test/shots/` — the boot
sampled along its timeline, every deck state, the drawer, the 3D scene, the
interrupt queue, the breach, and the phone layout. A design change that is not
looked at in those frames is not finished.
