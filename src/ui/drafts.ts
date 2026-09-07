/**
 * Drafts: the text the operator has typed and not yet sent.
 *
 * A reload — the dev server's, a deploy's, the operator's own — used to eat
 * whatever was sitting in the CAPCOM box, the agent composer or the command
 * line. Layouts came back (wm.ts keeps them in localStorage); the sentence
 * being written did not. This keeps every unsent field in `sessionStorage`
 * under a key stable per window and destination, so the same window opened
 * after a reload finds its text where it was, with the caret at the end.
 *
 * Why sessionStorage and not localStorage: a draft belongs to this tab's
 * conversation. Two tabs on the same console should not swap half-written
 * lines, and closing the tab is a fair way to throw a draft away.
 *
 * Writes are debounced (a keystroke is not a transaction), and anything
 * still pending is flushed on `pagehide`, so the last word typed before the
 * reload button is pressed lands too. Every storage access is guarded: a
 * private window or a locked-down browser gives a storage that throws, and
 * the console must type on regardless.
 *
 * The persistence itself is DOM-free — `createDrafts` takes the storage and
 * the timers — so test/drafts.test.ts can drive it without a browser.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The slice of a text field the drafts touch. A plain object will do in tests. */
export interface DraftField {
  value: string;
  addEventListener(type: 'input', fn: () => void): void;
  removeEventListener(type: 'input', fn: () => void): void;
  setSelectionRange?(start: number, end: number): void;
}

export interface DraftsIO {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export const DRAFT_PREFIX = 'orca.draft.';
/** Short enough that a reload right after the last keystroke still finds it. */
export const DRAFT_DEBOUNCE_MS = 150;

/** `capcom`, `capcom:task-17`, `agent:a1`, `command`: one key per destination. */
export function draftKey(scope: string, target?: string | null): string {
  return `${DRAFT_PREFIX}${scope}${target ? `:${target}` : ''}`;
}

export interface DraftBinding {
  /** Put the stored draft into the field if the field is empty. Caret at the end. */
  restore(): boolean;
  /** Persist the field's current value now — after a programmatic change, which fires no `input`. */
  save(): void;
  /** The line was sent: forget it. */
  clear(): void;
  /** The field now speaks to another destination (CAPCOM's task picker). */
  rekey(key: string): void;
  dispose(): void;
}

export interface Drafts {
  get(key: string): string;
  /** Debounced. An empty text removes the key. */
  set(key: string, text: string): void;
  /** Immediate; also cancels a pending write for that key. */
  clear(key: string): void;
  /** Write everything still pending. Called before a reload. */
  flush(): void;
  bind(field: DraftField, key: string): DraftBinding;
}

export function createDrafts(storage: StorageLike | null, io: DraftsIO, debounceMs = DRAFT_DEBOUNCE_MS): Drafts {
  const pending = new Map<string, { text: string; timer: number }>();

  const write = (key: string, text: string) => {
    if (!storage) return;
    try {
      if (text) storage.setItem(key, text);
      else storage.removeItem(key);
    } catch { /* storage refused: the draft lives in the field until it is sent */ }
  };

  const drafts: Drafts = {
    get(key) {
      const p = pending.get(key);
      if (p) return p.text;
      if (!storage) return '';
      try { return storage.getItem(key) ?? ''; } catch { return ''; }
    },
    set(key, text) {
      const p = pending.get(key);
      if (p) io.clear(p.timer);
      const timer = io.set(() => { pending.delete(key); write(key, text); }, debounceMs);
      pending.set(key, { text, timer });
    },
    clear(key) {
      const p = pending.get(key);
      if (p) { io.clear(p.timer); pending.delete(key); }
      write(key, '');
    },
    flush() {
      for (const [key, p] of pending) { io.clear(p.timer); write(key, p.text); }
      pending.clear();
    },
    bind(field, initialKey) {
      let key = initialKey;
      const onInput = () => drafts.set(key, field.value);
      field.addEventListener('input', onInput);
      return {
        restore() {
          if (field.value) return false;
          const text = drafts.get(key);
          if (!text) return false;
          field.value = text;
          try { field.setSelectionRange?.(text.length, text.length); } catch { /* not focusable yet */ }
          return true;
        },
        save() { drafts.set(key, field.value); },
        clear() { drafts.clear(key); },
        rekey(next) { key = next; },
        dispose() { field.removeEventListener('input', onInput); drafts.flush(); },
      };
    },
  };
  return drafts;
}

/** `sessionStorage`, or null where merely naming it throws. */
function sessionStore(): StorageLike | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** The console's drafts. Pending writes land on `pagehide`, before any reload. */
export const drafts: Drafts = createDrafts(sessionStore(), {
  set: (fn, ms) => (typeof window === 'undefined' ? 0 : window.setTimeout(fn, ms)),
  clear: (h) => { if (typeof window !== 'undefined') window.clearTimeout(h); },
});

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => drafts.flush());
}
