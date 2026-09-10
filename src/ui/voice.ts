/**
 * Voice: what CAPCOM's answer sounds like when the operator spoke to it.
 *
 * Talking into the console is one more way to type: the line goes down the
 * same `say` the composer uses and CAPCOM never knows it was spoken. What
 * changes is the way back. A reply is paragraphs, tool calls, paths and code
 * fences; read aloud in full it is a minute of noise. So CAPCOM is not asked
 * to be brief — an instruction it would forget — and nothing here summarises
 * with a model. The console decides, with rules:
 *
 *  - only a reply to something the operator **spoke** is spoken back. A typed
 *    line gets a typed answer, as before;
 *  - only once the turn is over — CAPCOM idle, or blocked on a question —
 *    so half a sentence is never read while the rest is still arriving;
 *  - what is read is the **conclusion**: the text after the last tool step,
 *    stripped of markdown, fences and URLs, with paths cut to their file name;
 *  - and only its first sentences, up to `SPOKEN_MAX` characters. The whole
 *    reply is in the window, where it always was.
 *
 * Nothing here touches the DOM or the microphone (`hud/voice.ts` does), so
 * every rule above is a thing a test can hold.
 */

import type { AgentState } from '../shared/types.ts';
import type { TalkGroup } from './windows/talk.ts';

/** How much of a reply is read aloud. About two sentences. */
export const SPOKEN_MAX = 220;

/** A line the operator spoke, and when. Matched against the transcript later. */
export interface Dictation { text: string; at: number }

/** The transcript can date the prompt a little before the console sent it. */
const SLACK_MS = 60_000;

/** The turn is over: nobody is typing into the transcript any more. */
const TURN_OVER: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'blocked']);

/**
 * Markdown to something a voice can read. Fences go entirely — nobody wants
 * a diff read aloud — URLs go, links keep their text, paths keep their file
 * name, and the markers (`#`, `*`, backticks, list bullets) fall away.
 */
export function readable(md: string): string {
  let t = md.replace(/```[\s\S]*?```/g, ' ');
  // Links keep their words before bare URLs go, or the link loses its bracket.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/\*+/g, '');
  // `src/ui/main.ts:361` → `main.ts`. A slash is a path; a lone word is not.
  t = t.replace(/(^|[\s(])(?:[\w.-]+\/)+([\w-]+(?:\.[\w-]+)*)(?::\d+)*(?=[\s,;)]|\.?$|\.\s)/gm, '$1$2');
  return t.replace(/\s+/g, ' ').trim();
}

/** The first sentences of `md` that fit in `max`, or the first one cut at a word. */
export function spokenLine(md: string, max = SPOKEN_MAX): string {
  const t = readable(md);
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?…])\s+(?=\S)/);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const first = sentences[0]!;
  const space = first.lastIndexOf(' ', max - 1);
  return `${first.slice(0, space > max / 2 ? space : max - 1).trimEnd()}…`;
}

/* ── Which voice ─────────────────────────────────────────────────── */

/** As much of a `SpeechSynthesisVoice` as choosing one needs. */
export interface VoiceLike { name: string; lang: string; default?: boolean; localService?: boolean }

/**
 * Apple ships these next to the real ones — Eddy, Flo, Grandma, Bubbles,
 * Zarvox — and a browser lists them first, in alphabetical order, ahead of
 * Paulina or Samantha. `say` never picks one on its own; neither does this.
 */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'eddy', 'flo', 'fred', 'good news',
  'grandma', 'grandpa', 'jester', 'junior', 'kathy', 'organ', 'ralph', 'reed', 'rocko', 'sandy', 'shelley',
  'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
]);

export function novelty(v: VoiceLike): boolean {
  return NOVELTY.has(v.name.split(' (')[0]!.trim().toLowerCase());
}

const tag = (l: string) => l.replace('_', '-').toLowerCase();

/** `Mónica (mejorada)` and `Mónica (Enhanced)` are both Mónica. */
export const baseName = (name: string) => name.split(' (')[0]!.trim();

/**
 * Apple ships a plain and a downloaded, better take of the same voice, and
 * lists both — `Mónica` and `Mónica (mejorada)` — under the word for
 * "enhanced" in the system's own language. No list of those words: the
 * better take is the one with a suffix, when a plain sibling is there too.
 */
function better<V extends VoiceLike>(v: V, all: readonly V[]): boolean {
  return v.name !== baseName(v.name) && all.some((o) => o !== v && o.name === baseName(v.name));
}

/**
 * The voice to read with: the one the operator picked by name — the exact
 * name, or the best take of that name, so `Mónica` finds `Mónica (mejorada)`
 * — or else what `say` would use: the system voice for the exact language,
 * a real one, its enhanced take over the plain one, the local one over a
 * remote one. Same language family as a last resort, and null when nothing
 * fits, in which case the utterance's own `lang` decides.
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], lang: string, preferred = ''): V | null {
  const rank = (v: V) => (better(v, voices) ? 4 : 0) + (v.default ? 2 : 0) + (v.localService ? 1 : 0);
  const best = (list: V[]) => list.slice().sort((a, b) => rank(b) - rank(a))[0] ?? null;
  if (preferred) {
    // A full name is that take; a bare name is the best take of that voice.
    const exact = preferred === baseName(preferred) ? null : voices.find((v) => v.name === preferred) ?? null;
    const named = exact ?? best(voices.filter((v) => baseName(v.name) === baseName(preferred)));
    if (named) return named;
  }
  const want = tag(lang);
  const base = want.split('-')[0]!;
  const real = voices.filter((v) => !novelty(v));
  return best(real.filter((v) => tag(v.lang) === want))
    ?? best(real.filter((v) => tag(v.lang).startsWith(`${base}-`) || tag(v.lang) === base))
    ?? null;
}

/** Same line, allowing for the whitespace a transcript may fold. */
function same(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** Was this prompt one of the lines the operator spoke? */
function spoken(prompt: TalkGroup, asked: readonly Dictation[]): boolean {
  return asked.some((d) => prompt.at >= d.at - SLACK_MS
    && (prompt.role === 'human' ? same(prompt.text, d.text) : prompt.text.includes(d.text.trim())));
}

/** The conclusion of a reply: every paragraph after the last tool step. */
export function conclusion(reply: TalkGroup): string {
  let lastStep = -1;
  reply.parts.forEach((p, i) => { if (p.kind === 'step') lastStep = i; });
  return reply.parts.slice(lastStep + 1)
    .flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    .join('\n\n');
}

/**
 * The reply to read aloud now, if there is one: the last exchange is a spoken
 * prompt and CAPCOM's finished answer to it, and it has not been read yet.
 * `said` is the caller's — the console marks a reply once it starts speaking.
 */
export function pickReply(
  groups: readonly TalkGroup[],
  state: AgentState | null | undefined,
  asked: readonly Dictation[],
  said: ReadonlySet<string>,
): { groupId: string; text: string } | null {
  if (!state || !TURN_OVER.has(state) || !asked.length) return null;
  const reply = groups[groups.length - 1];
  const prompt = groups[groups.length - 2];
  if (!reply || reply.role !== 'capcom' || said.has(reply.id)) return null;
  if (!prompt || (prompt.role !== 'human' && prompt.role !== 'mission')) return null;
  if (!spoken(prompt, asked)) return null;
  const text = spokenLine(conclusion(reply));
  return text ? { groupId: reply.id, text } : null;
}
