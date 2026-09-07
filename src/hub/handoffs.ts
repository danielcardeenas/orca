import fs from 'node:fs';
import path from 'node:path';
import { parseHandoff, type CapcomHandoff } from '../shared/handoff.ts';

/** Rare control events. Append before publishing; replay is idempotent. */
export class HandoffStore {
  private events = new Map<string, CapcomHandoff>();
  private file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'capcom-handoffs.jsonl');
    let source: string;
    try { source = fs.readFileSync(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; return; }
    for (const line of source.split('\n')) {
      try { const h = parseHandoff(JSON.parse(line)); if (h) this.events.set(h.id, h); } catch { /* tolerate a torn final line */ }
    }
  }
  all(): CapcomHandoff[] { return [...this.events.values()].sort((a, b) => a.at - b.at); }
  add(raw: unknown): CapcomHandoff | null {
    const h = parseHandoff(raw);
    if (!h || this.events.has(h.id)) return null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // Leading newline isolates a partial write left by a previous process.
    fs.appendFileSync(this.file, `\n${JSON.stringify(h)}\n`, { mode: 0o600 });
    this.events.set(h.id, h);
    return h;
  }
}
