/**
 * Callsigns and squad names in CAPCOM's prose, as places on the field.
 *
 * CAPCOM answers "which agents did I launch" with a list of callsigns. A list
 * the operator has to retype into `/find` is a list that sends them away from
 * the conversation. So every callsign, agent id and squad name CAPCOM writes
 * becomes a way there: click flies the camera, ⌘-click also opens the window.
 *
 * Pure text in, HTML out, and it never looks inside a tag: `mdLite` has
 * already marked up bold, code and lists, and a callsign like `TD` must not
 * turn `<td>` into a link. Callsigns are two upper-case characters (see
 * collector/util.ts `ALPHABET`), matched exactly as the fleet spells them —
 * case and all — so "is", "on" and "at" in a sentence stay words; an
 * upper-case `UI` in prose that happens to be a callsign is a link, and
 * that is the acceptable side of the trade.
 */

import type { Agent } from '../../shared/types.ts';
import { squadsOf } from '../../shared/squads.ts';

export interface RefIndex {
  /** label → agent id. A callsign and the id itself both point at the agent. */
  agents: Map<string, string>;
  /** squad name → the project its members are in, when they agree on one. */
  squads: Map<string, string | null>;
}

const EMPTY: RefIndex = { agents: new Map(), squads: new Map() };

/**
 * What the fleet is called right now. Two agents sharing a callsign across
 * projects is a real thing; the live one wins, and among live ones the
 * newest, which is the one a reply about "what just went up" means.
 */
export function refIndex(agents: Iterable<Agent> | Record<string, Agent>): RefIndex {
  const list: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);
  if (!list.length) return EMPTY;
  const alive = (a: Agent) => a.state !== 'done' && a.state !== 'dead';
  const sorted = [...list].sort((a, b) => Number(alive(a)) - Number(alive(b)) || a.startedAt - b.startedAt);
  const byLabel = new Map<string, string>();
  // Later entries overwrite: the sort puts the one that should win last.
  for (const a of sorted) {
    if (a.role === 'capcom') continue;
    if (a.callsign) byLabel.set(a.callsign, a.id);
    byLabel.set(a.id, a.id);
    if (a.shortId) byLabel.set(a.shortId, a.id);
  }
  const squads = new Map<string, string | null>();
  for (const sq of squadsOf(list)) {
    const projects = new Set(sq.memberIds.map((id) => list.find((a) => a.id === id)?.projectId).filter(Boolean));
    squads.set(sq.name, projects.size === 1 ? [...projects][0]! : null);
  }
  return { agents: byLabel, squads };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Link every reference in `html`, leaving tags and attributes alone.
 *
 * Longer labels first so an id never loses to the two characters at its
 * start, and a boundary on both sides that treats `-` and `_` as part of a
 * word: `audit-01` is a squad, `audit-010` is not, and `K9-2` is nothing.
 */
export function linkRefs(html: string, refs: RefIndex): string {
  const labels = [...refs.agents.keys(), ...refs.squads.keys()].filter((l) => /^[A-Za-z0-9_-]+$/.test(l));
  if (!labels.length) return html;
  labels.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w-])(squad:)?(${labels.map(escapeRe).join('|')})(?![\\w-])`, 'g');
  // Inside a code block a callsign is code, and inside a link it is already
  // a link: both are left as they are.
  let quiet = 0;
  return html.split(/(<[^>]*>)/).map((part, i) => {
    if (i % 2 === 1) {
      if (/^<(?:pre|a)\b/i.test(part)) quiet++;
      else if (/^<\/(?:pre|a)\b/i.test(part)) quiet = Math.max(0, quiet - 1);
      return part;
    }
    if (quiet) return part;
    return part.replace(re, (whole: string, prefix: string | undefined, label: string) => {
      const squad = refs.squads.has(label) ? label : null;
      const agent = !squad || prefix ? refs.agents.get(label) : undefined;
      if (agent && !prefix) {
        return `<a class="ref ref--agent" data-go="${agent}" title="FLY THERE · ⌘CLICK OPENS">${label}</a>`;
      }
      if (squad !== null) {
        const p = refs.squads.get(squad);
        return `<a class="ref ref--squad" data-go-squad="${squad}"${p ? ` data-go-project="${p}"` : ''} title="FRAME THE SQUAD · ⌘CLICK OPENS">${whole}</a>`;
      }
      return whole;
    });
  }).join('');
}
