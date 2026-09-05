/**
 * Fleet presets: the squads you launch more than once, written down.
 *
 * A preset is N briefs under a name — `audit`, `ship` — with at most one of
 * them marked `lead`. Launching it is `launch_squad` with the briefs filled
 * in: lead first, members hanging off it, a numbered squad label on all of
 * them. The console's `/launch` window and CAPCOM's `launch_squad` read the
 * SAME list, from the hub, so a preset written in the browser is one CAPCOM
 * can be told to launch by name, and vice versa.
 *
 * Lives in `shared/` because validation is the one thing both ends must agree
 * on exactly: a preset that half-parses spawns half a fleet, and there is no
 * undo for that. The hub is the only one that touches disk (`hub/fleets.ts`).
 */

import { MAX_SQUAD_NAME, squadName } from './squads.ts';

export interface PresetAgent {
  /** One line: what this agent is for. Becomes its title on the tile. */
  mission: string;
  /** The whole brief it wakes up with. */
  prompt: string;
  model?: string;
  runtime?: string;
  /**
   * This one leads the squad: it goes up first and the rest hang off it. At
   * most one per preset — two leaders is a preset that cannot be launched.
   */
  lead?: boolean;
}

export interface Preset {
  name: string;
  /** Project *code* (e.g. "AX"), not an id: a preset outlives a machine. */
  project?: string;
  /**
   * A fixed squad name for every launch of this preset. Left out — the usual
   * case — each launch takes the next `<preset>-NN` instead, so launching
   * `audit` twice gives you two squads and not one confused one.
   */
  squad?: string;
  agents: PresetAgent[];
}

/** The most agents one preset may carry. Kept in step with `launch_squad`. */
export const MAX_PRESET_AGENTS = 13;

/** A preset name: what `/launch <name>` and `launch_squad {preset}` match on. */
export const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

/**
 * A preset name reduced to something `SQUAD_RE` will take: lowercase, only
 * letters, digits, `-` and `_`, starting with a letter or a digit. This is the
 * base the hub numbers — `Payments migration` launches as `payments-migration-01`.
 */
export function squadStem(presetName: string): string {
  const s = presetName.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  // Room for the `-NN` the hub appends.
  return (s || 'fleet').slice(0, MAX_SQUAD_NAME - 3).replace(/-+$/, '') || 'fleet';
}

/**
 * One preset from untrusted JSON. Returns the preset, or the reason it refused
 * in one line — the console prints it in red, CAPCOM reads it.
 */
export function parsePreset(item: unknown): Preset | string {
  const p = item as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return 'A PRESET IS AN OBJECT';
  if (typeof p.name !== 'string' || !PRESET_NAME_RE.test(p.name.trim())) {
    return 'EVERY PRESET NEEDS A NAME: LETTERS, DIGITS, SPACE, _ . - · MAX 40';
  }
  const name = p.name.trim();
  if (!Array.isArray(p.agents) || !p.agents.length) return `"${name}" HAS NO AGENTS`;
  if (p.agents.length > MAX_PRESET_AGENTS) return `"${name}" · MAX ${MAX_PRESET_AGENTS} AGENTS`;
  const agents: PresetAgent[] = [];
  let leads = 0;
  for (const raw of p.agents) {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a.mission !== 'string' || typeof a.prompt !== 'string'
      || !a.mission.trim() || !a.prompt.trim()) {
      return `"${name}" · EVERY AGENT NEEDS A MISSION AND A PROMPT`;
    }
    const one: PresetAgent = { mission: a.mission.trim(), prompt: a.prompt };
    if (typeof a.model === 'string' && a.model) one.model = a.model;
    if (typeof a.runtime === 'string' && a.runtime) one.runtime = a.runtime;
    if (a.lead !== undefined && typeof a.lead !== 'boolean') return `"${name}" · LEAD IS TRUE OR FALSE`;
    if (a.lead === true) {
      // Two leaders is not a squad the launcher can put up: it would have to
      // pick one to parent the rest to, and picking silently is the bug.
      if (++leads > 1) return `"${name}" · ONLY ONE AGENT MAY LEAD`;
      one.lead = true;
    }
    agents.push(one);
  }
  const preset: Preset = { name, agents };
  if (typeof p.project === 'string' && p.project.trim()) preset.project = p.project.trim();
  if (p.squad !== undefined && p.squad !== null && p.squad !== '') {
    // A name that travels in an argv and lands on a tile: SQUAD_RE, or no.
    const sq = squadName(p.squad);
    if (!sq) return `"${name}" · SQUAD NAME: LETTERS, DIGITS, - OR _ · MAX ${MAX_SQUAD_NAME}`;
    preset.squad = sq;
  }
  return preset;
}

/**
 * A whole list from untrusted JSON text. All or nothing, and names unique:
 * two presets called `audit` is a `/launch audit` that picks one in silence.
 */
export function parsePresets(raw: string): Preset[] | string {
  let v: unknown;
  try { v = JSON.parse(raw); } catch (err) { return `NOT JSON · ${(err as Error).message}`; }
  return parsePresetList(v);
}

export function parsePresetList(v: unknown): Preset[] | string {
  if (!Array.isArray(v)) return 'EXPECTED A LIST OF PRESETS';
  const out: Preset[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const p = parsePreset(item);
    if (typeof p === 'string') return p;
    const key = p.name.toLowerCase();
    if (seen.has(key)) return `"${p.name}" APPEARS TWICE`;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The preset a name refers to, case-insensitively — that is how people type. */
export function findPreset(list: Preset[], name: string): Preset | undefined {
  const k = name.trim().toLowerCase();
  return list.find((p) => p.name.toLowerCase() === k);
}

/**
 * Two that earn their keep on day one. They are written the way a brief should
 * be written — what to do, what not to touch, how to report — because the first
 * preset an operator reads is the template for every one they write.
 */
export const SEED_PRESETS: Preset[] = [
  {
    name: 'audit',
    agents: [
      {
        lead: true,
        mission: 'Lead the audit and leave the test suite green without touching the public API.',
        prompt: 'You lead this audit. Run the full test suite and fix what fails; do not change any exported signature, and if a test is wrong, say so instead of editing it. Your two members will report on dependencies and docs. Consolidate the three findings into one report: what was broken, what each fix was, and the risk of every move you did not make.',
      },
      {
        mission: 'Find dependencies that are unused, duplicated or behind.',
        prompt: 'Audit the dependency manifest and the lockfile. List unused packages, duplicated versions, and anything more than one major behind. Do not upgrade anything: report, with the risk of each move.',
      },
      {
        mission: 'Make the docs describe what the code actually does.',
        prompt: 'Read the README and the docs directory against the current source. List every claim that is no longer true and fix the ones that are unambiguous. Do not invent features.',
      },
    ],
  },
  {
    name: 'ship',
    agents: [
      {
        lead: true,
        mission: 'Get the build clean and reproducible from a cold clone.',
        prompt: 'You lead this release. Build the project from scratch and fix whatever breaks on a machine with nothing cached. Your member drafts the release notes; read them against what you actually shipped and consolidate one answer: what changed, what needed a human, what is still open.',
      },
      {
        mission: 'Write the release notes from the commits, not from memory.',
        prompt: 'Read the commits since the last tag. Draft release notes grouped by what changed for a user. Flag anything that looks like a breaking change.',
      },
    ],
  },
];
