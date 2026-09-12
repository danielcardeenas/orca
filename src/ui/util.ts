/** Small helpers shared by the field, the windows and the HUD. */

import type { Agent, AgentState } from '../shared/types.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** CSS token per state. The shader has its own copy of the same hexes. */
export const STATE_VAR: Record<AgentState, string> = {
  booting: 'var(--st-booting)',
  thinking: 'var(--st-thinking)',
  working: 'var(--st-working)',
  blocked: 'var(--st-blocked)',
  idle: 'var(--st-idle)',
  done: 'var(--st-done)',
  dead: 'var(--st-dead)',
};

export const STATE_HEX: Record<AgentState, number> = {
  booting: 0x6a8cff,
  thinking: 0x8fb8ff,
  working: 0xc0f94a,
  blocked: 0xf5a524,
  idle: 0x6e736c,
  done: 0x4a4e48,
  dead: 0xff2a12,
};

/** A peer wait is stalled but not yours: blue, never amber. */
export function stateVar(a: Agent): string {
  if (a.state === 'blocked' && a.block?.kind === 'peer') return STATE_VAR.thinking;
  return STATE_VAR[a.state];
}

/** What a tile says its state is, in the operator's words. */
export function stateWord(a: Agent): string {
  if (a.state === 'blocked') {
    if (a.block?.kind === 'peer') return `WAITING ON ${a.block.waitingOn ?? 'PEER'}`;
    return 'NEEDS YOU';
  }
  return a.state.toUpperCase();
}

/**
 * Which CLI is driving this agent. The collector fills `runtime` once it
 * speaks more than Claude Code; until then every agent is `claude`.
 */
export function runtimeOf(a: Agent): string {
  const r = (a as { runtime?: string }).runtime;
  return (r && r.length ? r : 'claude').toLowerCase();
}

export const RUNTIME_CODE: Record<string, string> = {
  claude: 'CL', codex: 'CX', grok: 'GK', gemini: 'GM', aider: 'AI', opencode: 'OC',
};
export function runtimeCode(a: Agent): string {
  const r = runtimeOf(a);
  return RUNTIME_CODE[r] ?? r.slice(0, 2).toUpperCase();
}

/**
 * Markdown, out. An agent's last word arrives as it typed it — `**bold**`,
 * a `## heading`, a `- ` list, a [link](url), `code` — and in a tile every one
 * of those marks is a glyph that means nothing. Only the marks go: the words
 * stay in order. Whitespace collapses to one space.
 */
export function plain(s: string | null | undefined): string {
  let t = String(s ?? '');
  if (!t) return '';
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');                 // [text](url) → text
  t = t.replace(/(^|\s)(#{1,6}|>+)\s+/g, '$1');                       // headings, quotes
  t = t.replace(/^([-*]|\d+[.)])\s+/, '');                            // a list marker opening the line
  t = t.replace(/([.:;!?])\s+[-*]\s+(?=\S)/g, '$1 ');                 // …and one opening a sentence
  t = t.replace(/`{1,3}([^`]+)`{1,3}/g, '$1');                         // code spans
  // Emphasis only at word boundaries: `**bold**` goes, `snake_case` stays.
  t = t.replace(/(^|[\s("'])(\*\*|__|~~|\*|_)(?=\S)(.+?\S)\2(?=$|[\s)"'.,;:!?])/g, '$1$3');
  t = t.replace(/(^|\s)[*_~]{2,}(?=\s|$)/g, '$1');                     // orphan marks
  t = t.replace(/\s*\|\s*/g, ' · ');                                  // table bars
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Does this title read as an instruction rather than a name? The collector
 * falls back to the first prompt when a session has no `ai-title`, so half a
 * spawned squad is titled `Eres el agente A en una prueba corta de saludo…`.
 * A sentence that long, or one that opens by telling the agent who it is, is
 * the brief — not what to call it.
 */
export function promptish(title: string): boolean {
  const t = title.trim();
  if (t.length >= 56) return true;
  return /^(eres|sos|eres el|you are|you're|act as|actúa como|tu (misión|tarea|trabajo) es|your (mission|task|job) is)\b/i.test(t);
}

/**
 * La segunda línea de un detalle: lo que se escribió aparte del título, o
 * nada cuando resulta ser el título otra vez.
 *
 * Un detalle que se abre para leer el título entero y debajo repite la misma
 * frase no ha dicho nada dos veces: ha dicho una vez y ha gastado el sitio de
 * la otra. Pasa de verdad —una misión toma su nombre de la primera línea del
 * operador, y una propuesta cuyo resumen cabía en el titular lo repite— así
 * que la comparación ignora lo que no distingue dos frases: espacios de más,
 * mayúsculas y el punto final.
 */
export function besidesTitle(title: string, text: string): string {
  const body = text.trim();
  if (!body) return '';
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[.·]+$/, '').trim().toLocaleLowerCase();
  return norm(body) === norm(title) ? '' : body;
}

/** A session id standing in for a title: eight hex or decimal digits and nothing else. */
export function bareId(title: string): boolean {
  return /^[0-9a-f]{6,12}$/i.test(title.trim());
}

/**
 * What to call an agent, in one line.
 *
 * The title when it is a name. When it is the brief, or a bare session id,
 * and the mission is a shorter thing to say, the mission — `Escribir
 * saludo/saludo.log` over `Eres el agente A en una prueba corta…`. With
 * nothing better, the title anyway: a redundant fact beats a hole.
 */
export function nameOf(a: Pick<Agent, 'title' | 'mission'>): string {
  const title = plain(a.title);
  const mission = plain(a.mission);
  if (!title) return mission;
  if (!mission || mission === title) return title;
  if (bareId(title)) return mission;
  if (promptish(title) && mission.length < title.length) return mission;
  return title;
}

export function money(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}S`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}M`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}H`;
  return `${Math.round(h / 24)}D`;
}
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}S`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}M ${s % 60}S`;
  return `${Math.floor(m / 60)}H ${m % 60}M`;
}
export function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const HEXCHARS = '0123456789ABCDEF';
/** The comp's tele line: scrambled hex that keeps changing. */
export function hexNoise(groups = 6): string {
  let out = '';
  for (let g = 0; g < groups; g++) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) out += HEXCHARS[Math.floor(Math.random() * 16)];
    out += ' ';
  }
  return out.trim();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t = 0;
  return ((...a: Parameters<T>) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  }) as T;
}
