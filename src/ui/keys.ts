/**
 * Who owns a key: the field, a window, or the text the operator is typing.
 *
 * Every global key listener in the console asks the same question first —
 * "is the operator writing into something?" — and for a while each asked it
 * with its own inline check, each slightly different (one forgot `<select>`,
 * one forgot contentEditable, one listened on `keyup` and never asked at
 * all). That last one was a tick on every space bar inside a CAPCOM message.
 * One answer, here, and every listener uses it.
 *
 * Nothing in this file touches the DOM: the checks read only `tagName` and
 * `isContentEditable` off whatever target they are handed, so the unit
 * suite can drive them without a browser.
 */

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** The shape of an event target the checks below care about. */
export interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** Is this target something the operator types into? */
export function editable(t: EventTarget | EditableLike | null | undefined): boolean {
  if (!t) return false;
  const el = t as EditableLike;
  if (el.isContentEditable) return true;
  return typeof el.tagName === 'string' && EDITABLE_TAGS.has(el.tagName.toUpperCase());
}

/** Is the operator typing — did this key land in an editable target? */
export function typing(e: { target: EventTarget | null }): boolean {
  return editable(e.target);
}

/**
 * A key held down as a mode — space is FOCUS while it is pressed — has two
 * halves that must agree. `keydown` may refuse to engage (typing, a repeat,
 * nothing to focus), and then `keyup` must not release what never engaged,
 * or it plays the "off" sound at the end of every word. The hold remembers
 * whether the down half engaged so the up half only fires when it did.
 */
export interface KeyHold {
  /** The key went down. Returns true when the hold should engage. */
  down(e: { key: string; repeat?: boolean; target: EventTarget | null }, engage: () => boolean): boolean;
  /** The key came up. Returns true when a held mode is being released. */
  up(e: { key: string }): boolean;
  /** Focus left the page, a window blurred: drop the hold silently. */
  cancel(): boolean;
  /** Is the key currently held as a mode? */
  held(): boolean;
}

/**
 * `whileTyping` lets a hold engage inside an editable target. Space cannot:
 * it is a letter there. A chord with a modifier — ⌥V is TALK — is not, and
 * the operator holding it with the CAPCOM composer focused (the window
 * focuses it on open) is the ordinary case, not the exception.
 */
export function keyHold(key: string, opts: { whileTyping?: boolean } = {}): KeyHold {
  let on = false;
  return {
    down(e, engage) {
      if (e.key !== key) return false;
      if (!opts.whileTyping && typing(e)) return false;
      if (e.repeat || on) return false;
      on = engage();
      return on;
    },
    up(e) {
      if (e.key !== key || !on) return false;
      on = false;
      return true;
    },
    cancel() {
      const was = on;
      on = false;
      return was;
    },
    held: () => on,
  };
}
