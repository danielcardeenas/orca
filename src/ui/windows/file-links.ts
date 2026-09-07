/**
 * One listener for every file link the console draws.
 *
 * `linkPaths` (paths.ts) marks a path as `<a class="ref ref--file" data-file>`
 * wherever agent text is rendered — a transcript, a CAPCOM reply, a feed
 * line, a rendered Markdown file. Rather than wiring a click handler after
 * every one of those rewrites, the console listens once, in the capture
 * phase, so the click never reaches whatever is underneath: the feed line
 * that would fly to the agent, the tile that would select it.
 *
 * Click opens the viewer; ⌘click (ctrl on a PC) opens a second window even
 * if that path is already up, which is how you compare two lines of the
 * same file.
 */

import type { Console } from '../console.ts';

export function bindFileLinks(root: HTMLElement, c: Console): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const a = target?.closest?.<HTMLElement>('a.ref--file');
    if (!a || !root.contains(a)) return;
    const path = a.dataset.file;
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    const scope = a.closest<HTMLElement>('[data-file-agent]');
    const line = a.dataset.line ? Number(a.dataset.line) : null;
    const col = a.dataset.col ? Number(a.dataset.col) : null;
    c.openFile({ path, line, col, agentId: scope?.dataset.fileAgent ?? null }, { fresh: e.metaKey || e.ctrlKey, at: { x: e.clientX, y: e.clientY } });
  };
  // Middle-click and drag-to-select must not navigate either: there is no href.
  const onAux = (e: MouseEvent) => { if ((e.target as HTMLElement | null)?.closest?.('a.ref--file')) { e.preventDefault(); e.stopPropagation(); } };
  root.addEventListener('click', onClick, true);
  root.addEventListener('auxclick', onAux, true);
  return () => { root.removeEventListener('click', onClick, true); root.removeEventListener('auxclick', onAux, true); };
}
