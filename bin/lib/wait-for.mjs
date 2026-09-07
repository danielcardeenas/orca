import { mkdirSync, watch } from 'node:fs';

// Subscribe before checking: a reply arriving during setup must not be missed.
// The slow reconciliation also covers filesystems that drop watch events.
export function waitFor(directory, read, timeoutMs) {
  return new Promise((resolve, reject) => {
    let watcher;
    let poll;
    let deadline;
    let finished = false;
    const finish = (value, error) => {
      if (finished) return;
      finished = true;
      watcher?.close();
      clearInterval(poll);
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const check = () => {
      try {
        const value = read();
        if (value) finish(value);
      } catch (error) { finish(null, error); }
    };
    try {
      mkdirSync(directory, { recursive: true });
      watcher = watch(directory, check);
      watcher.on('error', () => { watcher.close(); });
    } catch { /* Reconcile when filesystem notifications are unavailable. */ }
    poll = setInterval(check, 5000);
    deadline = setTimeout(() => { check(); finish(null); }, Math.max(0, timeoutMs));
    check();
  });
}
