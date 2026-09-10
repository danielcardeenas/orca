/**
 * Una caja de mensaje sola, con el arrastre cableado, para test/attach-dom.test.ts.
 * La subida es falsa: apunta lo que recibe y contesta con una ruta de mentira.
 */
import { bindAttach, guardStrayDrops } from '../src/ui/windows/attach.ts';

export const host = document.createElement('div');
host.className = 'ceo__in';
host.innerHTML = '<textarea class="input" rows="2" aria-label="Message agent"></textarea><button type="button">SEND</button>';
document.body.appendChild(host);
export const box = host.querySelector('textarea')!;

export const uploads: string[] = [];
export const notes: string[] = [];
export let inputs = 0;
box.addEventListener('input', () => { inputs++; });

export const unbind = bindAttach(box, {
  key: 'orca.draft.agent:fx',
  upload: async (f) => {
    if (f.name === 'fail.bin') throw new Error('Files must be 64 MB or smaller.');
    uploads.push(f.name);
    return { path: `/up/${f.name}` };
  },
  note: (t) => { notes.push(t); },
});
export const unguard = guardStrayDrops();

function transfer(names: string[]): DataTransfer {
  const dt = new DataTransfer();
  for (const n of names) dt.items.add(new File(['x'], n, { type: n.endsWith('.png') ? 'image/png' : 'application/pdf' }));
  return dt;
}

export function fire(target: EventTarget, type: string, names: string[]): boolean {
  const e = new DragEvent(type, { dataTransfer: transfer(names), bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

export function paste(names: string[]): boolean {
  const e = new ClipboardEvent('paste', { clipboardData: transfer(names), bubbles: true, cancelable: true });
  box.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Espera a que la subida falsa termine y la ruta esté en la caja. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50 && host.classList.contains('is-uploading'); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
}
