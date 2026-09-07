import { openSync, closeSync, fstatSync, readSync } from 'node:fs';

/** Bounded disk read, retaining complete JSONL records only. */
export function readJsonlTail(file: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, start + n);
      if (!count) break;
      n += count;
    }
    const lines = bytes.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    // An interrupted append can leave a partial final record.
    return lines.filter((line) => {
      if (!line.trim()) return false;
      try { JSON.parse(line); return true; } catch { return false; }
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  } finally { if (fd !== undefined) closeSync(fd); }
}
