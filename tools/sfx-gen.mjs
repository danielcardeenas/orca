// Generate ORCA's sound packs with ElevenLabs Sound Effects v2 on fal.ai.
//
//   node tools/sfx-gen.mjs --dry-run          every prompt, the count, the bill
//   node tools/sfx-gen.mjs                    everything missing, four packs
//   node tools/sfx-gen.mjs --pack capcom      one pack
//   node tools/sfx-gen.mjs --event breach     one clip in every pack
//   node tools/sfx-gen.mjs --pack cinema --event tick --force   redo one take
//   node tools/sfx-gen.mjs --manifests        rewrite the JSON, generate nothing
//
// Reads FAL_KEY from the repo's .env (../.env from orca/). Writes
// `public/sfx/packs/<pack>/<clip>.mp3`, one `manifest.json` per pack and
// `public/sfx/packs/index.json` over them. A clip that already exists on disk
// is skipped unless `--force`, so a rerun after a failure costs nothing.
//
// ── What a pack is ───────────────────────────────────────────────────
//
// The console has 47 events (`SoundName` in src/ui/hud/sound.ts) and a pack
// has 32 clips: siblings share. Five windows opening a list of rows are one
// `open.list`; `deck.tick` and `replay.step` are one `tick`. `CLIP_OF` in
// sound.ts owns that mapping and this file owns the clips it names — the two
// tables are checked against each other by `--check`.
//
// A prompt is `<pack style> <what the gesture is> <pack materials> <SHARED>`.
// The gesture is written once, in neutral terms, so the same event reads as
// the same event in all four packs; the style and the materials are what make
// a pack a pack. A few clips per pack override the neutral text where the
// pack has its own idea of that gesture — a pure tone for CAPCOM's channel, a
// keycap for MECHANICAL's tick, a marimba note for MAC's.
//
// `SHARED` closes every prompt and is not negotiable: no 8-bit, no chiptune,
// no retro game console, and above all no voice and no words. These are micro
// sounds that have to survive being played over ambient music, so they are
// rich and layered and they get out of the way. `--check` fails the whole set
// if a banned word ever appears in a prompt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PACKS = path.join(ROOT, 'public', 'sfx', 'packs');

/** fal's price for one ElevenLabs Sound Effects v2 generation, in USD.
 *  An estimate for the summary line, not a bill. */
const USD_PER_CLIP = 0.08;
/** The API refuses anything shorter, whatever the prompt asks for. */
const MIN_LEN = 0.5;
/** And it refuses a `text` longer than this, with a 422 and no audio. */
const MAX_PROMPT = 450;
const MAX_LEN = 1.4;
/** How many generations are in flight at once. */
const LANES = 4;

/**
 * The end of every prompt, word for word. It is what stops the model reaching
 * for a game console, a voice, or a sound that fights the room it plays in.
 */
const SHARED = 'no 8-bit, no chiptune, no retro game console, no voice, no words, no speech, rich layered micro-sound, soft transient, short decay, sits under ambient music, mono, no music';

/**
 * Anything that would drag a prompt back toward an arcade, a radio operator or
 * a talking machine. `--check` refuses the set if one of these shows up in a
 * composed prompt outside `SHARED`'s own negations.
 */
const BANNED = [
  '8-bit', '8 bit', 'chiptune', 'chip tone', 'chip tune', 'square wave', 'pixel',
  'atari', 'nintendo', 'sega', 'gameboy', 'game boy', 'arcade', 'retro',   'video game', 'game console', 'bleep', 'bloop', 'voice', 'vocal', 'speech',
  'spoken', 'announcer', 'radio chatter', 'squelch', 'walkie', 'talkie',
];

/* ── The clips: one gesture each, shared by every pack ──────────────── */

/**
 * `d` is seconds of audio, `act` is the gesture — what the sound has to say,
 * with no material in it and no era in it. Grouped the way the SFX window
 * groups them.
 *
 * Everything is 0.5 s, the API's floor, except the three that are genuinely
 * events rather than touches: a breach, a launch, and the whole fleet landing
 * in one grid. A micro-sound that plays under music has no business running
 * longer than the gesture it belongs to.
 */
const CLIPS = {
  /* fleet */
  interrupt:     { g: 'fleet', d: 0.5, label: 'a human is needed',   act: 'Two soft notes rising, small and urgent, never harsh: something asking for a human.' },
  answer:        { g: 'fleet', d: 0.5, label: 'a question closed',   act: 'One warm accent closing and resolving downward: a question answered.' },
  spawn:         { g: 'fleet', d: 0.5, label: 'lineage grew',        act: 'Three tiny ascending touches, each lighter than the last: a new thing under its parent.' },
  launch:        { g: 'fleet', d: 1.2, label: 'a fleet went up',     act: 'A rich layered swell in two waves resolving into one bright accent: a fleet going up.' },
  squad:         { g: 'fleet', d: 0.5, label: 'a squadron formed',   act: 'A tight irregular cluster of small touches with one accent under them: a group forming.' },
  dead:          { g: 'fleet', d: 0.5, label: 'a unit ended',        act: 'One low soft descending fall, brief and final: something powering down for good.' },
  breach:        { g: 'fleet', d: 1.4, label: 'the link went down',  act: 'Three dark low pulses, insistent and tense, never distorted: something has failed.' },
  link:          { g: 'fleet', d: 0.5, label: 'the link came back',  act: 'A short rising sweep resolving onto one clean sustained note: a connection locking in.' },
  artifact:      { g: 'fleet', d: 0.5, label: 'an artifact landed',  act: 'One soft arriving accent with a small bright tail: a file landing on the desk.' },
  placed:        { g: 'fleet', d: 0.5, label: 'placed on the field', act: 'One dry soft impact with a very short body: a flat object set down and staying.' },

  /* windows */
  'open.agent':  { g: 'windows', d: 0.5, label: 'an instrument arrived', act: 'One small opening touch with a hair of body under it: a single panel arriving.' },
  'open.alert':  { g: 'windows', d: 0.5, label: 'it arrived urgent',     act: 'A sharper two-part opening accent, a shade urgent: a panel that opened itself.' },
  'open.list':   { g: 'windows', d: 0.5, label: 'rows unrolled',         act: 'A short opening touch then a fine granular flutter: a list of rows unrolling.' },
  'open.tool':   { g: 'windows', d: 0.5, label: 'a tool arrived',        act: 'One firm plain opening accent with no tail: a tool panel arriving.' },
  'open.capcom': { g: 'windows', d: 0.5, label: 'a channel opened',      act: 'An opening accent settling onto one steady held note: a channel coming up.' },
  close:         { g: 'windows', d: 0.5, label: 'a panel left',          act: 'One short closing accent falling slightly at the end: a panel leaving.' },
  fold:          { g: 'windows', d: 0.5, label: 'folded to the tray',    act: 'A short descending slide into a soft catch: a panel folding into a tray.' },
  unfold:        { g: 'windows', d: 0.5, label: 'back out of the tray',  act: 'A short ascending slide out of a soft catch: a panel back out of a tray.' },
  wipe:          { g: 'windows', d: 0.5, label: 'the lime sweep',        act: 'One smooth short sweep travelling across and stopping clean: a bar wiping a panel.' },

  /* navigation */
  'bookmark.save': { g: 'navigation', d: 0.5, label: 'a view pinned',   act: 'One crisp pressing accent that seats and releases: a view pinned to a slot.' },
  fly:             { g: 'navigation', d: 0.5, label: 'the camera flew', act: 'A short travelling sweep that departs and lands: a camera arriving elsewhere.' },
  'mode.on':       { g: 'navigation', d: 0.5, label: 'a mode engaged',  act: 'One short rising two-step: a mode engaging and holding.' },
  'mode.off':      { g: 'navigation', d: 0.5, label: 'a mode released', act: 'One short falling two-step: a mode releasing and letting go.' },
  lasso:           { g: 'navigation', d: 0.5, label: 'a lasso closed',  act: 'A fine granular sweep ending in one small touch: a rectangle dragged shut.' },
  select:          { g: 'navigation', d: 0.5, label: 'a thing picked',  act: 'One tiny bright touch, dry and immediate, no tail: a thing picked.' },

  /* deck */
  'deck.enter':  { g: 'deck', d: 0.9, label: 'the deck aligned',   act: 'A soft downward accent opening into a wide flat bed: everything snapping into one grid.' },
  'deck.exit':   { g: 'deck', d: 0.5, label: 'back to the field',  act: 'A short upward release, loosening: a grid letting go.' },
  'deck.sort':   { g: 'deck', d: 0.5, label: 'rows reordered',     act: 'A quick shuffling flutter of several small touches: rows reordering.' },
  'deck.settle': { g: 'deck', d: 0.5, label: 'the deck landed',    act: 'A last irregular cluster resolving into one soft low accent: an arrival finishing.' },
  tick:          { g: 'deck', d: 0.5, label: 'one tile landed',    act: 'One very small dry touch with almost no tail, alone in silence: one tile landing.' },

  /* replay */
  'replay.enter': { g: 'replay', d: 0.5, label: 'into the past',  act: 'A downward slide settling onto a steady low bed: out of now into what happened.' },
  'replay.exit':  { g: 'replay', d: 0.5, label: 'back to live',   act: 'An upward slide returning to a clean neutral end: back to the present.' },
};

/* ── The four voices ────────────────────────────────────────────────── */

/**
 * `style` opens every prompt, `materials` follows the gesture, and `SHARED`
 * closes it, so the middle — the gesture — is the only thing that changes
 * between clips of a pack. `over` replaces the gesture where the pack has its
 * own word for it: MECHANICAL has no notes to slide, CAPCOM has no radio, MAC
 * says everything as a note.
 *
 * Every one of these is written short on purpose. The API refuses a prompt
 * over `MAX_PROMPT` characters and `SHARED` alone is 171 of them, so a style
 * that runs long does not read as ambitious — it reads as an HTTP 422.
 */
const PACKS_DEF = {
  cinema: {
    label: 'CINEMA',
    style: 'Film sci-fi interface design: glass and air over a soft sub transient, very short tail, minimal reverb.',
    materials: 'Glass, breath, felt sub. Restrained, never a beep.',
    over: {
      breach: 'Three deep felt sub impacts with a dark ring decaying over them: something structural failed.',
      tick: 'One tiny glass tap with a breath of air behind it, alone in silence.',
      'deck.enter': 'One deep felt sub impact opening into a wide glassy bed of air.',
      launch: 'A layered rise of glass and air in two waves resolving into one bright shimmer.',
    },
  },
  mac: {
    label: 'MAC',
    style: 'Modern Apple system sound, richer: a round warm marimba or glass note, soft attack, short musical decay, groovy.',
    materials: 'Warm wood and glass mallet with felt. No melody.',
    over: {
      answer: 'One warm rounded mallet note resolving down a step: a question answered.',
      link: 'Two warm notes rising and resolving onto one clean sustained note.',
      launch: 'A groovy cascade of warm rounded notes in two waves resolving onto one bright note.',
      breach: 'Three low warm notes pulsing insistently, dark and rounded, still musical.',
      tick: 'One tiny marimba note, the shortest possible, alone in silence.',
    },
  },
  capcom: {
    label: 'CAPCOM',
    style: 'Mission control instruments, radio off: pure sine tones, a distant relay, tape beneath. Calm, clean, nothing harsh.',
    materials: 'A pure tone, a soft relay, a hair of tape. Understated.',
    over: {
      link: 'One pure sine tone arriving clean and holding: the circuit is live.',
      breach: 'Three low pure tones pulsing insistently with a soft relay closing between them.',
      'open.capcom': 'One pure tone, then the channel holding open on a soft bed.',
      interrupt: 'Two rising pure pips, calm and precise: a station calling for a human.',
      tick: 'One relay contact closing softly, tiny, alone in silence.',
      wipe: 'Tape running smoothly past the head end to end and stopping clean.',
    },
  },
  mechanical: {
    label: 'MECHANICAL',
    style: 'Tiny real mechanisms, close and soft: small switches, relays, keycaps, latches, detents. Gentle, nothing tonal.',
    materials: 'Metal, felt, plastic, spring. Unpitched, hand-moved.',
    over: {
      interrupt: 'Two small switches thrown fast, the second firmer: something asking for attention.',
      link: 'A latch travelling and seating with a soft firm click: the connector is home.',
      breach: 'Three relays closing heavily in a row with a little metal rattle after them.',
      launch: 'A rack of small relays firing in two soft waves, then one firmer contactor seating.',
      'open.capcom': 'A rotary switch stepping through its detents and stopping on one.',
      wipe: 'A carriage running along a rail end to end and stopping clean.',
      fly: 'A slider running down a track and arriving against its stop.',
      'mode.on': 'One small switch thrown up and holding there.',
      'mode.off': 'One small switch thrown back down and released.',
      'deck.enter': 'A row of small switches thrown together with one soft latch closing under them.',
      'deck.settle': 'A last handful of keycaps bottoming out unevenly and one soft latch closing.',
      'replay.enter': 'A lever thrown and a spool winding down to a stop.',
      'replay.exit': 'A spool winding back up to speed and a lever seating home.',
      tick: 'One keycap bottoming out softly, tiny, alone in silence.',
    },
  },
};

/* ── Args ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const DRY = flag('dry-run');
const FORCE = flag('force');
const YES = flag('yes');
const ONLY_MANIFESTS = flag('manifests');
const CHECK = flag('check');
const onlyPack = val('pack');
const onlyEvent = val('event');

if (onlyPack && !PACKS_DEF[onlyPack]) { console.error(`unknown pack ${onlyPack} · ${Object.keys(PACKS_DEF).join(' ')}`); process.exit(1); }
if (onlyEvent && !CLIPS[onlyEvent]) { console.error(`unknown clip ${onlyEvent} · ${Object.keys(CLIPS).join(' ')}`); process.exit(1); }

const packIds = onlyPack ? [onlyPack] : Object.keys(PACKS_DEF);
const clipIds = onlyEvent ? [onlyEvent] : Object.keys(CLIPS);

/** `<style> <gesture> <materials>` — the whole prompt, in one line. */
function promptFor(packId, clipId) {
  const p = PACKS_DEF[packId];
  const c = CLIPS[clipId];
  return `${p.style} ${p.over?.[clipId] ?? c.act} ${p.materials} ${SHARED}`;
}

function lenOf(clipId) {
  return Math.min(MAX_LEN, Math.max(MIN_LEN, CLIPS[clipId].d));
}

/** Every prompt the whole set would send, so both guards read the same thing. */
function everyPrompt() {
  const out = [];
  for (const packId of Object.keys(PACKS_DEF)) {
    for (const clipId of Object.keys(CLIPS)) out.push({ at: `${packId}/${clipId}`, text: promptFor(packId, clipId) });
  }
  return out;
}
const longest = () => everyPrompt().reduce((m, p) => Math.max(m, p.text.length), 0);
/**
 * The API answers a long prompt with a 422 and no audio — free, but a whole
 * run of nothing. Catching it here costs a millisecond and it is the
 * difference between a bad prompt and a wasted afternoon.
 */
const tooLong = () => everyPrompt().filter((p) => p.text.length > MAX_PROMPT).map((p) => ({ at: p.at, n: p.text.length }));

/* ── --check: the clip table against sound.ts's CLIP_OF ─────────────── */

if (CHECK) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'hud', 'sound.ts'), 'utf8');
  const block = src.match(/export const CLIP_OF[^{]*\{([\s\S]*?)\n\};/);
  if (!block) { console.error('could not find CLIP_OF in sound.ts'); process.exit(1); }
  const wanted = new Set([...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]));
  const have = new Set(Object.keys(CLIPS));
  const missing = [...wanted].filter((x) => !have.has(x));
  const extra = [...have].filter((x) => !wanted.has(x));
  if (missing.length) console.error(`sound.ts wants clips this file does not make: ${missing.join(', ')}`);
  if (extra.length) console.error(`this file makes clips sound.ts never asks for: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) console.log(`ok · ${have.size} clips, and sound.ts names every one of them`);

  // No prompt may reach for an arcade, a radio operator or a talking machine.
  // SHARED's own negations are cut out first: they are the only place these
  // words are allowed to appear, and there they are what forbids them.
  const dirty = [];
  for (const packId of Object.keys(PACKS_DEF)) {
    for (const clipId of Object.keys(CLIPS)) {
      const body = promptFor(packId, clipId).replace(SHARED, '').toLowerCase();
      for (const w of BANNED) if (body.includes(w)) dirty.push(`${packId}/${clipId}: "${w}"`);
    }
  }
  if (dirty.length) console.error(`prompts reaching for something they must not:\n  ${dirty.join('\n  ')}`);
  else console.log(`ok · ${Object.keys(PACKS_DEF).length * have.size} prompts, none of them retro and none of them speaking`);
  const over = tooLong();
  if (over.length) console.error(`prompts the API will refuse (>${MAX_PROMPT}):\n  ${over.map((o) => `${o.at} ${o.n}`).join('\n  ')}`);
  else console.log(`ok · longest prompt ${longest()} of ${MAX_PROMPT} characters, shared style included verbatim`);
  process.exit(missing.length || extra.length || dirty.length || over.length ? 1 : 0);
}

/* ── Manifests ──────────────────────────────────────────────────────── */

/** Every `file` in a pack manifest is relative to `/sfx/`, like the old one. */
function writePackManifest(packId) {
  const dir = path.join(PACKS, packId);
  fs.mkdirSync(dir, { recursive: true });
  const clips = Object.keys(CLIPS)
    .filter((id) => fs.existsSync(path.join(dir, `${id}.mp3`)))
    .map((id) => ({ id, file: `packs/${packId}/${id}.mp3`, label: CLIPS[id].label, len: lenOf(id) }));
  const m = { pack: packId, label: PACKS_DEF[packId].label, style: PACKS_DEF[packId].style, clips };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 1)}\n`);
  return clips.length;
}

/**
 * `legacy` is not generated: it points at what was already here — the first
 * eight generated events and the eleven cuts of the reference film — so the
 * console's old voice stays pickable after the packs land. Its labels come
 * from `public/sfx/manifest.json`, which is where the film's timestamps live.
 */
const LEGACY = {
  interrupt: 'gen/interrupt-1.mp3', answer: 'gen/answer-1.mp3', spawn: 'gen/spawn-1.mp3',
  launch: 'gen/launch-1.mp3', squad: 'gen/spawn-2.mp3', dead: 'gen/dead-1.mp3',
  breach: 'gen/breach-1.mp3', link: 'gen/link-1.mp3', artifact: '09-blip.m4a', placed: '02-deck.m4a',
  'open.agent': 'gen/open-1.mp3', 'open.alert': 'gen/interrupt-2.mp3', 'open.list': 'gen/open-2.mp3',
  'open.tool': 'gen/open-1.mp3', 'open.capcom': '10-signal.m4a', close: 'gen/dead-2.mp3',
  fold: 'gen/open-2.mp3', unfold: 'gen/open-1.mp3', wipe: '06-zipper.m4a',
  'bookmark.save': 'gen/answer-2.mp3', fly: '08-beams.m4a', 'mode.on': 'gen/link-2.mp3',
  'mode.off': 'gen/dead-2.mp3', lasso: '07-radar.m4a', select: '03-tick-a.m4a',
  'deck.enter': '02-deck.m4a', 'deck.exit': 'gen/open-2.mp3', 'deck.sort': '04-tick-b.m4a',
  'deck.settle': '01-glyph.m4a', tick: '03-tick-a.m4a',
  'replay.enter': '05-tick-c.m4a', 'replay.exit': '04-tick-b.m4a',
};

function writeLegacyManifest() {
  const dir = path.join(PACKS, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  let old = [];
  try { old = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'sfx', 'manifest.json'), 'utf8')); } catch { /* gone is fine */ }
  const byFile = new Map(old.map((c) => [c.file, c]));
  const clips = Object.entries(LEGACY)
    .filter(([, file]) => fs.existsSync(path.join(ROOT, 'public', 'sfx', file)))
    .map(([id, file]) => {
      const src = byFile.get(file);
      return { id, file, label: src?.label ?? CLIPS[id].label, len: src?.len ?? lenOf(id) };
    });
  const m = {
    pack: 'legacy', label: 'LEGACY',
    style: "The console's first voice: eight generated takes and eleven cuts of the reference film, with the film's score still under them.",
    clips,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 1)}\n`);
  return clips.length;
}

function writeIndex() {
  fs.mkdirSync(PACKS, { recursive: true });
  const ids = [...Object.keys(PACKS_DEF), 'legacy'];
  const list = ids.map((id) => {
    let m = { label: id.toUpperCase(), style: '', clips: [] };
    try { m = JSON.parse(fs.readFileSync(path.join(PACKS, id, 'manifest.json'), 'utf8')); } catch { /* not made yet */ }
    return { id, label: m.label, style: m.style, count: m.clips.length, manifest: `packs/${id}/manifest.json` };
  });
  fs.writeFileSync(path.join(PACKS, 'index.json'), `${JSON.stringify(list, null, 1)}\n`);
  return list;
}

function manifests() {
  for (const id of Object.keys(PACKS_DEF)) writePackManifest(id);
  writeLegacyManifest();
  const list = writeIndex();
  for (const p of list) console.log(`  ${p.id.padEnd(11)} ${String(p.count).padStart(2)} clips`);
}

if (ONLY_MANIFESTS) { console.log('manifests:'); manifests(); process.exit(0); }

/* ── The plan, and what it costs ────────────────────────────────────── */

const jobs = [];
for (const packId of packIds) {
  for (const clipId of clipIds) {
    const out = path.join(PACKS, packId, `${clipId}.mp3`);
    const have = fs.existsSync(out);
    jobs.push({ packId, clipId, out, skip: have && !FORCE });
  }
}
const todo = jobs.filter((j) => !j.skip);

if (DRY) {
  for (const packId of packIds) {
    const p = PACKS_DEF[packId];
    console.log(`\n══ ${packId} · ${p.label} ${'═'.repeat(Math.max(0, 56 - packId.length - p.label.length))}`);
    for (const clipId of clipIds) {
      console.log(`\n  ${clipId}  ${lenOf(clipId).toFixed(2)}s  [${CLIPS[clipId].g}]`);
      console.log(`  ${promptFor(packId, clipId)}`);
    }
  }
}

const bill = (n) => `${n} generation${n === 1 ? '' : 's'} · ≈ $${(n * USD_PER_CLIP).toFixed(2)} at $${USD_PER_CLIP.toFixed(2)} each`;
console.log(`\n${'─'.repeat(64)}`);
console.log(`packs   ${packIds.join(', ')}`);
console.log(`clips   ${clipIds.length} per pack`);
console.log(`prompt  ${longest()} chars at the longest, ceiling ${MAX_PROMPT}`);
console.log(`on disk ${jobs.length - todo.length} (skipped${FORCE ? ', but --force overrides' : ''})`);
console.log(`to make ${bill(todo.length)}`);
console.log(`${'─'.repeat(64)}\n`);

const over = tooLong();
if (over.length) {
  console.error(`${over.length} prompt(s) over the API's ${MAX_PROMPT}-character ceiling; nothing was sent:`);
  for (const o of over) console.error(`  ${o.at}  ${o.n}`);
  process.exit(1);
}

if (DRY) process.exit(0);
if (!todo.length) { console.log('nothing to generate · rewriting manifests'); manifests(); process.exit(0); }

/* ── fal ────────────────────────────────────────────────────────────── */

const envFile = fs.readFileSync(path.join(ROOT, '..', '.env'), 'utf8');
const env = Object.fromEntries(envFile.split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
if (!env.FAL_KEY) { console.error('no FAL_KEY in ../.env'); process.exit(1); }
const H = { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' };
const ENDPOINT = 'https://fal.run/fal-ai/elevenlabs/sound-effects/v2';

if (!YES) {
  process.stdout.write('starting in ');
  for (let i = 5; i > 0; i--) { process.stdout.write(`${i} `); await new Promise((r) => setTimeout(r, 1000)); }
  process.stdout.write('— ctrl-c now if that is wrong\n\n');
}

let made = 0, failed = 0;
const queue = todo.slice();

async function one(job) {
  const body = {
    text: promptFor(job.packId, job.clipId),
    duration_seconds: lenOf(job.clipId),
    prompt_influence: 0.6,
    output_format: 'mp3_44100_128',
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: H, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.audio?.url) throw new Error(JSON.stringify(j).slice(0, 200));
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      fs.writeFileSync(job.out, Buffer.from(await (await fetch(j.audio.url)).arrayBuffer()));
      made++;
      console.log(`  ✓ ${job.packId}/${job.clipId}.mp3  ${fs.statSync(job.out).size} bytes  (${made + failed}/${todo.length})`);
      return;
    } catch (err) {
      if (attempt === 3) { failed++; console.error(`  ✗ ${job.packId}/${job.clipId}  ${String(err).slice(0, 160)}`); return; }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function lane() { for (let j = queue.shift(); j; j = queue.shift()) await one(j); }
await Promise.all(Array.from({ length: LANES }, lane));

console.log(`\n${made} made, ${failed} failed · ≈ $${(made * USD_PER_CLIP).toFixed(2)}\n`);
console.log('manifests:');
manifests();
