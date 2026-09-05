/**
 * MUSIC — a record player bolted to the console.
 *
 * The operator works with something on. This window holds the sources they
 * chose, one at a time, and gets out of the way: an embed from Bandcamp or
 * Spotify, a list of the others, and a line to paste a new one into. It is
 * the only window that is not about the fleet, which is exactly why it stays
 * as quiet as the rest of the instrument.
 *
 * Two players, because those are the two the owner uses:
 *
 *   BANDCAMP  https://bandcamp.com/EmbeddedPlayer/v=2/album=<id>/…
 *             There is no API, public or otherwise: the player is driven from
 *             inside its own frame, and the album id is the only thing this
 *             console needs to know. A `fetch` of an album page to read that
 *             id is blocked by CORS in every browser — Bandcamp sends no
 *             `Access-Control-Allow-Origin` — so the window tries, and when it
 *             fails it says so and takes the id (or a Share → Embed url) by
 *             hand instead of guessing.
 *   SPOTIFY   https://open.spotify.com/embed/<track|album|playlist>/<id>
 *             Any `open.spotify.com` link is folded into its `/embed/` form,
 *             including the `/intl-es/` ones the app copies. Titles come from
 *             the oEmbed endpoint, which does send CORS headers.
 *
 * ── Why these two frames carry no `sandbox` ──────────────────────────
 *
 * `artifact.ts` runs agent-made HTML under `sandbox=""`, and must: that page
 * is output, nobody vouched for it, and it has no business reaching anything.
 * These frames are the opposite case. The operator typed the origin in
 * themselves, there are exactly two of them and both are pinned by prefix in
 * `safeEmbed()`; and both players are script-driven with their own storage and
 * (Spotify) EME, so `sandbox=""` — no scripts, no same-origin, no media keys —
 * would leave two dead rectangles. `allow="autoplay; encrypted-media"` is the
 * smallest grant that lets them work. Nothing here is ever built from a string
 * an agent wrote: a source only becomes an `src` after `safeEmbed()` has
 * matched it against those two prefixes, on the way in and on the way back out
 * of localStorage.
 *
 * ── Starting the record from outside its frame ───────────────────────
 *
 * Spotify publishes an iFrame API (`open.spotify.com/embed/iframe-api/v1`):
 * one script, same origin as the embed, that builds the frame itself and
 * hands back a controller with `play`, `pause`, `loadUri`. That is the only
 * way this window can put a record on without a hand inside the player, and
 * it is what the AUTOPLAY setting rides on. The frame the API builds carries
 * `allow="autoplay; …"` of its own, and the console's user activation flows
 * into it — so `play()` works from the operator's first click or key on, and
 * never before: a browser plays no sound for a page nobody has touched, and
 * this window does not pretend otherwise. When the script cannot be fetched
 * (offline, blocked) the frame falls back to the plain embed and the ▶ is the
 * operator's, as it was.
 *
 * Bandcamp has nothing of the kind — no parameter, no message; `test/` probed
 * both — so a Bandcamp record is only ever started by its own ▶. With
 * AUTOPLAY on, the window opens on the glass where that button is, instead of
 * folded, and says why.
 *
 * ── Folding keeps the music on ───────────────────────────────────────
 *
 * `wm.minimize` only adds `is-min`, which is `display: none`. Chromium keeps a
 * hidden frame's document and its media running — the window folds into the
 * tray and the record does not stop. `×` is the stop button: `close()` removes
 * the element, the frame dies with it, and `dispose()` says so out loud.
 *
 * ── Storage ──────────────────────────────────────────────────────────
 *
 *   orca.music.v1         MusicSource[]  the sources, in the operator's order
 *   orca.music.active.v1  string         the id of the one on the platter
 *
 * ── Wiring (main.ts — not this file's to change) ─────────────────────
 *
 *   import { mountMusic } from './windows/kinds/music.ts';
 *   wm.register('music', (ctx) => mountMusic(ctx, c));
 *   c.openMusic = () => wm.open({ kind: 'music', key: 'music', callsign: 'MUSIC' });
 *
 * ── Signatures ───────────────────────────────────────────────────────
 *
 *   interface MusicSource { id, kind, url, title, embed }
 *   mountMusic(ctx: WinCtx, c: Console): { dispose(): void }
 *   resolveSource(input: string): Promise<Resolved>   // exported for tests
 *   safeEmbed(url: string): string | null             // exported for tests
 *   MUSIC_KEY, MUSIC_ACTIVE_KEY: string
 */

import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { esc } from '../../util.ts';
import { slabBusy, slabFlash } from '../fx.ts';
import { getPref } from '../../prefs.ts';

export const MUSIC_KEY = 'orca.music.v1';
export const MUSIC_ACTIVE_KEY = 'orca.music.active.v1';

export interface MusicSource {
  /** Local id. Not the platform's — two windows must never fight over one. */
  id: string;
  kind: 'bandcamp' | 'spotify';
  /** The page a human would open. What the mono line shows. */
  url: string;
  /** What the operator reads. Spotify's comes from oEmbed, Bandcamp's from the slug. */
  title: string;
  /** The frame's `src`. Always one of the two pinned prefixes. */
  embed: string;
}

/** The two origins this window will put in a frame, and nothing else. */
const BC_EMBED = 'https://bandcamp.com/EmbeddedPlayer/';
const SP_EMBED = 'https://open.spotify.com/embed/';
/** Spotify's own controller script. Same origin as the embed it drives. */
const SP_API = 'https://open.spotify.com/embed/iframe-api/v1';
/** How long to wait for that script before the plain embed takes over. */
const SP_API_TIMEOUT = 8_000;

/* ── The slice of Spotify's iFrame API this window uses ───────────── */

interface SpotifyController {
  loadUri(uri: string): void;
  play(): void;
  pause(): void;
  destroy(): void;
  addListener(name: 'ready' | 'playback_update', cb: (e?: { data?: { isPaused?: boolean } }) => void): void;
}
interface SpotifyIframeApi {
  createController(
    host: HTMLElement,
    opts: { uri: string; width?: string | number; height?: string | number },
    cb: (ctl: SpotifyController) => void,
  ): void;
}
declare global {
  interface Window { onSpotifyIframeApiReady?: (api: SpotifyIframeApi) => void }
}

let spApi: Promise<SpotifyIframeApi> | null = null;
/**
 * The API script, fetched once per page. It announces itself through a global
 * callback, so the first caller sets that up and every later one shares the
 * promise. A script that never arrives rejects after `SP_API_TIMEOUT`, and the
 * caller falls back to the plain embed; the rejection is cached, because a
 * blocked origin does not unblock itself between records.
 */
function spotifyApi(): Promise<SpotifyIframeApi> {
  if (spApi) return spApi;
  spApi = new Promise<SpotifyIframeApi>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('spotify api timeout')), SP_API_TIMEOUT);
    window.onSpotifyIframeApiReady = (api) => { clearTimeout(timer); resolve(api); };
    const sc = document.createElement('script');
    sc.src = SP_API;
    sc.async = true;
    sc.onerror = () => { clearTimeout(timer); reject(new Error('spotify api unreachable')); };
    document.head.appendChild(sc);
  });
  return spApi;
}

/** `https://open.spotify.com/embed/track/ID` → `spotify:track:ID`. Null for anything else. */
export function spotifyUri(embed: string): string | null {
  if (!embed.startsWith(SP_EMBED)) return null;
  const m = /^\/embed\/([a-z]+)\/([A-Za-z0-9]+)/.exec(new URL(embed).pathname);
  return m && SP_TYPES.includes(m[1]!) ? `spotify:${m[1]}:${m[2]}` : null;
}

/** The record on the platter, read off storage: what `main.ts` opens the window for. */
export function activeMusic(): MusicSource | null {
  const list = load();
  let active = '';
  try { active = localStorage.getItem(MUSIC_ACTIVE_KEY) ?? ''; } catch { /* fine */ }
  return list.find((s) => s.id === active) ?? list[0] ?? null;
}

/** What each player needs to draw itself. Bandcamp large + tracklist, Spotify's own. */
const HEIGHT: Record<MusicSource['kind'], number> = { bandcamp: 470, spotify: 352 };

/** Spotify link shapes that have an `/embed/` twin. */
const SP_TYPES = ['track', 'album', 'playlist', 'artist', 'episode', 'show'];

/**
 * The player as the console wants it: the bezel behind it, the lime in front,
 * the tracklist on, artwork small so the list is the bigger half.
 */
function bandcampEmbed(what: 'album' | 'track', id: string): string {
  return `${BC_EMBED}v=2/${what}=${id}/size=large/bgcol=0b0a0d/linkcol=c0f94a/tracklist=true/artwork=small/transparent=true/`;
}

/**
 * The gate every `src` passes, on the way in from a paste and on the way back
 * out of localStorage. A stored list is not trusted input: it is one
 * `localStorage.setItem` away from anything.
 */
export function safeEmbed(url: string): string | null {
  const u = url.trim();
  if (u.startsWith(BC_EMBED) || u.startsWith(SP_EMBED)) {
    try { new URL(u); return u; } catch { return null; }
  }
  return null;
}

/** `skal-ghost` → `skal ghost`. A slug is a title with the spaces taken out. */
function humanize(slug: string): string {
  return decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mkId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ── Reading a pasted line ────────────────────────────────────────── */

export type Resolved =
  | { ok: true; src: MusicSource }
  | { ok: false; why: string };

/**
 * Spotify's oEmbed is the one title lookup that works from a browser: it sends
 * `Access-Control-Allow-Origin: *`. A failure is not an error — the source is
 * still good, it just keeps the name the url gave it.
 */
async function spotifyTitle(pageUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}`);
    if (!r.ok) return null;
    const j = await r.json() as { title?: string };
    return typeof j.title === 'string' && j.title ? j.title : null;
  } catch { return null; }
}

/**
 * Bandcamp's album page carries its id in two places — the `bc-page-properties`
 * meta and the `EmbeddedPlayer` link. Both are behind CORS, so this almost
 * always throws; it is here for the day it does not, and for anyone running
 * the console behind a proxy that adds the header.
 */
async function bandcampId(pageUrl: string): Promise<{ what: 'album' | 'track'; id: string } | null> {
  try {
    const r = await fetch(pageUrl, { mode: 'cors' });
    if (!r.ok) return null;
    const html = await r.text();
    const embed = html.match(/(?:EmbeddedPlayer\/[^"']*?)(album|track)=(\d+)/);
    if (embed?.[1] && embed[2]) return { what: embed[1] === 'track' ? 'track' : 'album', id: embed[2] };
    const a = html.match(/"item_type"\s*:\s*"([at])"[^}]{0,400}?"item_id"\s*:\s*(\d+)/);
    if (a?.[1] && a[2]) return { what: a[1] === 't' ? 'track' : 'album', id: a[2] };
    const b = html.match(/"item_id"\s*:\s*(\d+)[^}]{0,400}?"item_type"\s*:\s*"([at])"/);
    if (b?.[1] && b[2]) return { what: b[2] === 't' ? 'track' : 'album', id: b[1] };
    return null;
  } catch { return null; }
}

/**
 * Everything the operator might paste, in one function.
 *
 *   a bandcamp EmbeddedPlayer url   used as it is, rebuilt in the console's palette
 *   a bandcamp album/track page     fetched for its id; CORS usually says no
 *   `4161047896` or `album=4161…`   the id on its own, the way out of that no
 *   an open.spotify.com link        folded to /embed/, `/intl-xx/` and `?si=` dropped
 *   `spotify:track:<id>`            the app's own copy format
 */
export async function resolveSource(input: string): Promise<Resolved> {
  const raw = input.trim();
  if (!raw) return { ok: false, why: 'nothing pasted' };

  /* An id on its own, or the `album=…` half of an embed line. */
  const bare = raw.match(/^(?:(album|track)=)?(\d{5,})$/);
  if (bare?.[2]) {
    const what: 'album' | 'track' = bare[1] === 'track' ? 'track' : 'album';
    const id = bare[2];
    return { ok: true, src: {
      id: mkId(), kind: 'bandcamp', url: `https://bandcamp.com/${what}/${id}`,
      title: `bandcamp ${what} ${id}`, embed: bandcampEmbed(what, id),
    } };
  }

  /* `spotify:track:37i9…` — what the desktop app puts on the clipboard. */
  const uri = raw.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/);
  if (uri?.[1] && uri[2] && SP_TYPES.includes(uri[1])) {
    const type = uri[1], id = uri[2];
    const page = `https://open.spotify.com/${type}/${id}`;
    return { ok: true, src: {
      id: mkId(), kind: 'spotify', url: page,
      title: await spotifyTitle(page) ?? `spotify ${type}`,
      embed: `${SP_EMBED}${type}/${id}`,
    } };
  }

  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, why: 'that is not a link, an id, or a spotify uri' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'https links only' };

  /* Bandcamp, already an embed: keep the ids, take back the colours. */
  if (raw.startsWith(BC_EMBED) || /bandcamp\.com\/EmbeddedPlayer/.test(raw)) {
    const m = raw.match(/\b(album|track)=(\d+)/);
    if (!m?.[1] || !m[2]) return { ok: false, why: 'that embed carries no album= or track= id' };
    const what: 'album' | 'track' = m[1] === 'track' ? 'track' : 'album';
    const id = m[2];
    return { ok: true, src: {
      id: mkId(), kind: 'bandcamp', url: `https://bandcamp.com/${what}/${id}`,
      title: `bandcamp ${what} ${id}`, embed: bandcampEmbed(what, id),
    } };
  }

  /* Bandcamp, a page a human would read. */
  if (u.hostname.endsWith('bandcamp.com')) {
    const seg = u.pathname.split('/').filter(Boolean);
    const what = seg[0] === 'track' ? 'track' : seg[0] === 'album' ? 'album' : null;
    if (!what) return { ok: false, why: 'a bandcamp album or track page, please' };
    const artist = u.hostname.replace(/\.bandcamp\.com$/, '');
    const title = `${artist} · ${humanize(seg[1] ?? what)}`;
    const found = await bandcampId(u.toString());
    if (!found) {
      // Goes through `textContent`, never `innerHTML`: escaping it here would
      // only put `&amp;` in front of the operator.
      return { ok: false, why: `bandcamp will not let a browser read "${seg[1] ?? what}" — open the album, SHARE / EMBED THIS ALBUM, and paste that url, or paste the album id on its own` };
    }
    return { ok: true, src: {
      id: mkId(), kind: 'bandcamp', url: u.toString(), title,
      embed: bandcampEmbed(found.what, found.id),
    } };
  }

  /* Spotify, in any of the shapes the web player hands out. */
  if (u.hostname === 'open.spotify.com' || u.hostname === 'play.spotify.com') {
    const seg = u.pathname.split('/').filter(Boolean).filter((s) => !/^intl-[a-z-]+$/i.test(s));
    const i = seg.findIndex((s) => SP_TYPES.includes(s));
    const type = i < 0 ? '' : seg[i] ?? '';
    const id = (i < 0 ? '' : seg[i + 1] ?? '').replace(/[^A-Za-z0-9]/g, '');
    if (!type) return { ok: false, why: 'a spotify track, album or playlist link, please' };
    if (!id) return { ok: false, why: 'that spotify link has no id in it' };
    const page = `https://open.spotify.com/${type}/${id}`;
    return { ok: true, src: {
      id: mkId(), kind: 'spotify', url: page,
      title: await spotifyTitle(page) ?? `spotify ${type}`,
      embed: `${SP_EMBED}${type}/${id}`,
    } };
  }

  return { ok: false, why: 'bandcamp or spotify. nothing else has a player worth embedding' };
}

/* ── What the window starts with ──────────────────────────────────── */

/** The owner's two, so the window is never an empty box with a form in it. */
function seed(): MusicSource[] {
  return [
    {
      id: 'seed-12k-skal-ghost', kind: 'bandcamp',
      url: 'https://12kmusic.bandcamp.com/album/skal-ghost',
      title: '12kmusic · skal ghost',
      embed: bandcampEmbed('album', '4161047896'),
    },
    {
      id: 'seed-sp-1y3ckX', kind: 'spotify',
      url: 'https://open.spotify.com/track/1y3ckXklqD7CboWfGBrWJy',
      title: 'spotify track',
      embed: `${SP_EMBED}track/1y3ckXklqD7CboWfGBrWJy`,
    },
  ];
}

/** A stored list is input like any other: every field is checked, bad rows drop. */
function load(): MusicSource[] {
  try {
    const raw = localStorage.getItem(MUSIC_KEY);
    if (!raw) return seed();
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return seed();
    const clean = list.flatMap((r): MusicSource[] => {
      const s = r as Partial<MusicSource>;
      const embed = typeof s.embed === 'string' ? safeEmbed(s.embed) : null;
      if (!embed || (s.kind !== 'bandcamp' && s.kind !== 'spotify')) return [];
      return [{
        id: typeof s.id === 'string' && s.id ? s.id : mkId(),
        kind: s.kind,
        url: typeof s.url === 'string' ? s.url : embed,
        title: typeof s.title === 'string' && s.title ? s.title : s.kind,
        embed,
      }];
    });
    return clean;
  } catch { return seed(); }
}

function save(list: MusicSource[], active: string) {
  try {
    localStorage.setItem(MUSIC_KEY, JSON.stringify(list));
    localStorage.setItem(MUSIC_ACTIVE_KEY, active);
  } catch { /* private mode: the session still plays, it just forgets */ }
}

/* ── The window ───────────────────────────────────────────────────── */

export function mountMusic(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  let list = load();
  let active = (() => {
    try { return localStorage.getItem(MUSIC_ACTIVE_KEY) ?? ''; } catch { return ''; }
  })();
  if (!list.some((s) => s.id === active)) active = list[0]?.id ?? '';

  body.innerHTML = `
    <div class="win__scroll scroll" data-scroll>
      <div class="mus__deck" data-deck><div class="mus__well" data-well></div></div>
      <div class="mus__list" data-list></div>
    </div>
    <div class="mus__add">
      <input class="input mono" type="text" data-in spellcheck="false" autocomplete="off"
             placeholder="paste a bandcamp or spotify link" aria-label="source" />
      <button class="slab-btn" type="button" data-add data-key="a">ADD</button>
    </div>
    <p class="mus__note px px--tiny" data-note hidden></p>
  `;

  const deck = body.querySelector<HTMLElement>('[data-deck]')!;
  const listEl = body.querySelector<HTMLElement>('[data-list]')!;
  const input = body.querySelector<HTMLInputElement>('[data-in]')!;
  const addBtn = body.querySelector<HTMLButtonElement>('[data-add]')!;
  const note = body.querySelector<HTMLElement>('[data-note]')!;

  /* The frame is built once and never rebuilt: swapping a source changes its
     `src`, so the window is not torn down and the tray keeps its record on.
     The border lives on the well around it, never on the frame: Spotify's
     embed changes layout at exactly 352px of viewport, and a 1px border on a
     `border-box` iframe leaves it 350 and draws the short card in a tall box. */
  const well = body.querySelector<HTMLElement>('[data-well]')!;
  const frame = document.createElement('iframe');
  frame.className = 'mus__frame';
  frame.title = 'music';
  frame.setAttribute('allow', 'autoplay; encrypted-media');
  frame.setAttribute('loading', 'eager');
  well.appendChild(frame);

  /*
   * Spotify's frame is the API's to build, so it gets a host of its own next
   * to the plain frame. Only one of the two shows at a time; the other is
   * hidden, not removed, so switching records back and forth does not rebuild
   * a player. `spCtl` is the controller once the API has answered, `spWant`
   * the record it should be on, `spPlay` whether it should be playing.
   */
  const spHost = document.createElement('div');
  spHost.className = 'mus__sp';
  spHost.hidden = true;
  well.appendChild(spHost);
  let spCtl: SpotifyController | null = null;
  let spWant: string | null = null;
  let spPlay = false;
  let spPending = false;
  let spFallback = false;
  /** What the controller last reported. Read by the test hook, nothing else. */
  let spPlaying = false;

  function spShow(on: boolean) {
    spHost.hidden = !on;
    frame.hidden = on;
  }
  /** Get the controller building, once. Loses gracefully to the plain embed. */
  function spEnsure(uri: string) {
    if (spCtl || spPending || spFallback) return;
    spPending = true;
    spotifyApi().then((api) => {
      if (gone) return;
      const mount = document.createElement('div');
      spHost.replaceChildren(mount);
      api.createController(mount, { uri, width: '100%', height: HEIGHT.spotify }, (ctl) => {
        if (gone) { ctl.destroy(); return; }
        spCtl = ctl;
        spPending = false;
        spHost.querySelector('iframe')?.classList.add('mus__frame');
        ctl.addListener('ready', () => { if (spPlay) ctl.play(); });
        ctl.addListener('playback_update', (e) => { spPlaying = e?.data?.isPaused === false; });
        if (spWant && spWant !== uri) ctl.loadUri(spWant);
        if (spPlay) ctl.play();
      });
    }).catch(() => {
      if (gone) return;
      // No API: the plain embed, and the ▶ is the operator's.
      spPending = false;
      spFallback = true;
      const s = list.find((x) => x.id === active);
      if (s?.kind === 'spotify') { spShow(false); if (frame.src !== s.embed) frame.src = s.embed; }
    });
  }

  const empty = document.createElement('p');
  empty.className = 'mus__empty px px--tiny';
  empty.textContent = 'NOTHING ON THE PLATTER. PASTE A LINK.';
  deck.appendChild(empty);

  function say(why: string | null) {
    note.hidden = !why;
    note.textContent = why ?? '';
  }

  /** Put a source in the frame. Same source twice does nothing — a re-`src` would restart it. */
  function play(id: string) {
    const s = list.find((x) => x.id === id) ?? null;
    const src = s ? safeEmbed(s.embed) : null;
    active = s && src ? s.id : '';
    say(null);
    empty.hidden = !!src;
    well.hidden = !src;
    if (s && src) {
      well.style.setProperty('--mus-h', `${HEIGHT[s.kind]}px`);
      const uri = s.kind === 'spotify' && !spFallback ? spotifyUri(src) : null;
      if (uri) {
        // Spotify, through the API: the plain frame steps aside and stops.
        if (frame.src) frame.removeAttribute('src');
        spShow(true);
        if (spWant !== uri) { spWant = uri; spCtl?.loadUri(uri); }
        if (spCtl && spPlay) spCtl.play();
        spEnsure(uri);
      } else {
        // Bandcamp (or Spotify without its API): the plain frame. A Spotify
        // record still on the platter is paused, not left playing unseen.
        spCtl?.pause();
        spShow(false);
        if (frame.src !== src) frame.src = src;
      }
      ctx.setTitle(s.title);
    } else {
      if (frame.src) frame.removeAttribute('src');
      spCtl?.pause();
      spShow(false);
      ctx.setTitle('');
    }
    paint();
    save(list, active);
  }

  /*
   * Start the record on the platter, as far as anyone can from out here. A
   * Spotify record plays on the operator's first click or key — at once when
   * the page has already been touched — and a Bandcamp one is announced,
   * because nothing outside its frame can press its ▶.
   */
  let armed: (() => void) | null = null;
  function disarm() {
    if (!armed) return;
    window.removeEventListener('pointerdown', armed, { capture: true });
    window.removeEventListener('keydown', armed, { capture: true });
    armed = null;
  }
  function start() {
    const s = list.find((x) => x.id === active);
    if (!s) return;
    if (s.kind !== 'spotify' || spFallback) {
      say(`${s.kind === 'bandcamp' ? 'BANDCAMP' : 'THIS PLAYER'} ONLY STARTS FROM ITS OWN ▶ · AUTOPLAY WORKS WITH SPOTIFY`);
      return;
    }
    say(null);
    const go = () => {
      disarm();
      spPlay = true;
      if (spCtl) spCtl.play();
      c.note(`music on: ${s.title}`);
    };
    const touched = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false;
    if (touched) { go(); return; }
    disarm();
    armed = go;
    window.addEventListener('pointerdown', go, { capture: true, once: true });
    window.addEventListener('keydown', go, { capture: true, once: true });
    say('SPOTIFY STARTS ON YOUR FIRST CLICK OR KEY');
  }

  function paint() {
    if (!list.length) {
      listEl.innerHTML = `<p class="mus__empty px px--tiny">NO SOURCES.</p>`;
      return;
    }
    listEl.innerHTML = list.map((s) => `
      <div class="mus__row ${s.id === active ? 'is-on' : ''}" data-row="${esc(s.id)}">
        <button class="mus__play" type="button" data-play="${esc(s.id)}"
                title="PUT IT ON" aria-label="play ${esc(s.title)}">▶</button>
        <div class="mus__what">
          <b class="px">${esc(s.title)}</b>
          <span class="mono mus__url" title="${esc(s.url)}">${esc(s.url)}</span>
        </div>
        <span class="px px--tiny mus__kind">${esc(s.kind)}</span>
        <button class="mus__drop" type="button" data-drop="${esc(s.id)}"
                title="TAKE IT OFF THE LIST" aria-label="remove ${esc(s.title)}">✕</button>
      </div>`).join('');

    // The ▶ on a row is a hand on the record: with AUTOPLAY on it starts too.
    listEl.querySelectorAll<HTMLElement>('[data-play]').forEach((b) =>
      b.addEventListener('click', () => { play(b.dataset.play!); if (getPref('musicAutoplay')) start(); }));
    listEl.querySelectorAll<HTMLElement>('[data-drop]').forEach((b) =>
      b.addEventListener('click', () => drop(b.dataset.drop!)));
  }

  function drop(id: string) {
    const s = list.find((x) => x.id === id);
    list = list.filter((x) => x.id !== id);
    if (active === id) play(list[0]?.id ?? '');
    else { paint(); save(list, active); }
    if (s) c.note(`music dropped ${s.title}`);
  }

  let adding = false;
  async function add() {
    if (adding) return;
    const raw = input.value;
    if (!raw.trim()) return;
    adding = true;
    addBtn.disabled = true;
    // §6.2: ink for a frame, then the band while the url is resolved. A
    // disabled slab loses its colour, so the band is what says "still going".
    slabFlash(addBtn);
    const busy = slabBusy(addBtn);
    say(null);
    try {
      const r = await resolveSource(raw);
      if (!r.ok) { say(r.why); return; }
      const dupe = list.find((s) => s.embed === r.src.embed);
      if (dupe) { say('already on the list'); play(dupe.id); return; }
      list = [...list, r.src];
      input.value = '';
      play(r.src.id);
      c.note(`music added ${r.src.title}`);
    } finally {
      busy();
      adding = false;
      addBtn.disabled = false;
    }
  }

  addBtn.addEventListener('click', () => void add());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void add(); }
    // The command line takes every stray key in the console; this field is a
    // field, and its Escape belongs to whoever is typing in it.
    e.stopPropagation();
  });

  /**
   * Spotify titles are seeded from the url and corrected here: one oEmbed per
   * spotify source on mount, cheap and cached, so a list restored from storage
   * stops saying `spotify track`. Bandcamp has no such endpoint; its titles
   * are the slug, and the slug is what the operator wrote in the first place.
   */
  let gone = false;
  void (async () => {
    let touched = false;
    for (const s of list) {
      if (s.kind !== 'spotify') continue;
      const t = await spotifyTitle(s.url);
      if (gone) return;
      if (t && t !== s.title) { s.title = t; touched = true; }
    }
    if (touched) { paint(); save(list, active); if (active) ctx.setTitle(list.find((x) => x.id === active)?.title ?? ''); }
  })();

  play(active);
  if (getPref('musicAutoplay')) start();

  return {
    start,
    state: () => ({ active, kind: list.find((x) => x.id === active)?.kind ?? null, playing: spPlaying, armed: !!armed, fallback: spFallback }),
    dispose() {
      gone = true;
      disarm();
      spCtl?.destroy();
      spCtl = null;
      // The frame goes with the element, and so does the sound. Say it, or the
      // operator hunts for a mute that was never there.
      if (active) c.note('music stopped');
    },
  };
}
