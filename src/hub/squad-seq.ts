/**
 * Squad names, numbered by the hub.
 *
 * `launch_squad` takes a base name — "audit" — and every launch of it must
 * come out distinct: `audit-01`, `audit-02`. Two squads called `audit-01` on
 * one fleet are ONE squad as far as `squadsOf()` is concerned, and a message
 * to `squad:audit-01` would wake both. The console keeps its own counter in
 * localStorage for the `/launch` window; this one is the hub's, because a
 * name handed out over MCP has to survive the browser being closed.
 *
 * Two sources, and the larger wins:
 *
 *  - `squads.json` next to the hub's other files: what this hub has handed out.
 *  - the squad labels currently on the fleet: what is actually in use, which
 *    matters the first time a hub with an empty counter meets a fleet whose
 *    agents already carry `audit-03` from a console launch.
 *
 * A read-modify-write per launch, synchronous. Launches are rare and the file
 * is a few dozen bytes; a cache here would only be one more thing to get out
 * of step with the disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MAX_SQUAD_NAME, SQUAD_RE } from '../shared/squads.ts';

/** Where the hub records the names it has handed out, inside its store dir. */
export const SQUAD_SEQ_FILE = 'squads.json';

/** Two digits — `audit-01`. Past 99 the suffix simply grows. */
const SUFFIX_WIDTH = 2;

/** `<base>-NN` → `[base, NN]`, or null when the name carries no number. */
function split(name: string): { base: string; n: number } | null {
  const m = /^(.*)-(\d+)$/.exec(name);
  if (!m) return null;
  return { base: m[1]!, n: Number(m[2]) };
}

function readCounts(file: string): Record<string, number> {
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    // A corrupt counter file must not stop a launch: the fleet's own labels
    // still protect against a collision with anything alive.
    return {};
  }
}

/**
 * The next free `<base>-NN`, recorded so the one after is different.
 *
 * `inUse` is every squad label on the fleet right now, dead agents included
 * while the hub still holds them. The base must already be a valid squad name
 * short enough to take the suffix; the caller validates, this throws.
 */
export function nextSquadName(file: string, base: string, inUse: Iterable<string | null>): string {
  const room = MAX_SQUAD_NAME - (SUFFIX_WIDTH + 1);
  if (!SQUAD_RE.test(base) || base.length > room) {
    throw new Error(`squad base name "${base}" is not a name a suffix fits on (max ${room} chars)`);
  }

  const counts = readCounts(file);
  let last = counts[base] ?? 0;
  for (const label of inUse) {
    if (!label) continue;
    const s = split(label);
    if (s && s.base === base && s.n > last) last = s.n;
  }

  const n = last + 1;
  counts[base] = n;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(counts, null, 2) + '\n');
  return `${base}-${String(n).padStart(SUFFIX_WIDTH, '0')}`;
}
