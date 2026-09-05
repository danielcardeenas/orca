/**
 * Fleet presets on disk: `~/.orca/fleets/<name>.json`, one file per preset.
 *
 * One file each and not one list, because a preset is something a person
 * edits by hand, checks into a dotfiles repo, or sends to a colleague — and a
 * `git diff` of one squad's briefs should not carry every other squad along.
 * The hub is the only writer; the console and CAPCOM read and replace the
 * list through it, so there is one copy and it is not in a browser.
 *
 * The seed presets are written the first time the directory is found empty,
 * and never again: a preset deleted on purpose stays deleted.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePreset, SEED_PRESETS, type Preset } from '../shared/fleets.ts';
import { ORCA_DIR } from './auth.ts';

export const FLEETS_DIR = join(ORCA_DIR, 'fleets');

/** Filename for a preset: the name, made safe for a filesystem, plus .json. */
export function presetFile(name: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${stem || 'preset'}.json`;
}

export class FleetStore {
  readonly dir: string;

  constructor(dir: string = FLEETS_DIR) {
    this.dir = dir;
  }

  /**
   * Every preset on disk, by name. A file that does not parse is skipped and
   * reported in `broken`, never thrown: one bad file must not take the
   * launch window down with it.
   */
  read(): { presets: Preset[]; broken: { file: string; why: string }[] } {
    this.seedIfEmpty();
    const presets: Preset[] = [];
    const broken: { file: string; why: string }[] = [];
    let files: string[] = [];
    try { files = readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
    const seen = new Set<string>();
    for (const file of files) {
      let parsed: Preset | string;
      try {
        parsed = parsePreset(JSON.parse(readFileSync(join(this.dir, file), 'utf8')));
      } catch (err) {
        parsed = `NOT JSON · ${err instanceof Error ? err.message : String(err)}`;
      }
      if (typeof parsed === 'string') { broken.push({ file, why: parsed }); continue; }
      const key = parsed.name.toLowerCase();
      if (seen.has(key)) { broken.push({ file, why: `"${parsed.name}" IS ALREADY DEFINED IN ANOTHER FILE` }); continue; }
      seen.add(key);
      presets.push(parsed);
    }
    return { presets, broken };
  }

  list(): Preset[] {
    return this.read().presets;
  }

  /**
   * Make the directory hold exactly this list: files for these, and no file
   * for a preset that is not in it. That is what saving the JSON editor means
   * — the text IS the list — and it is what lets a preset be deleted at all.
   * Broken files are left alone: they were not in the list the operator saw.
   */
  replaceAll(list: Preset[]): void {
    mkdirSync(this.dir, { recursive: true });
    const keep = new Set(list.map((p) => presetFile(p.name)));
    const { presets: current } = this.read();
    for (const p of current) {
      const f = presetFile(p.name);
      if (!keep.has(f)) rmSync(join(this.dir, f), { force: true });
    }
    for (const p of list) this.write(p);
  }

  write(p: Preset): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, presetFile(p.name)), JSON.stringify(p, null, 2) + '\n');
  }

  private seedIfEmpty(): void {
    if (existsSync(this.dir)) {
      try { if (readdirSync(this.dir).some((f) => f.endsWith('.json'))) return; } catch { return; }
    }
    mkdirSync(this.dir, { recursive: true });
    for (const p of SEED_PRESETS) this.write(p);
  }
}
