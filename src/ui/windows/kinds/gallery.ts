/**
 * The gallery: everything the fleet has made, in one grid.  (IDEAS B8)
 *
 * `field/media.ts` already projects an artifact into the field and
 * `windows/kinds/artifact.ts` already opens one; what was missing was the
 * index — the place where you see that six agents produced forty things while
 * you were reading one of them. Newest first, because recency is the only
 * ordering an operator ever asked for.
 *
 * ── WIRING (main.ts) ───────────────────────────────────────────────────
 *
 *   import { mountGallery } from './windows/kinds/gallery.ts';
 *   wm.register('gallery', (ctx) => mountGallery(ctx, c));
 *
 *   // on the Console object, next to openFeed/openFleet:
 *   openGallery(): void {
 *     wm.open({ kind: 'gallery', key: 'gallery', callsign: 'GALLERY' });
 *   }
 *   // console.ts: openGallery(): void;
 *   // command.ts: { name: 'gallery', help: 'everything the fleet has made' }
 *   //             case 'gallery': c.openGallery(); break;
 *
 * ── DROP FORMAT (field) ────────────────────────────────────────────────
 *
 * A thumbnail is an HTML5 drag source. On `dragstart` it sets:
 *
 *   dataTransfer.setData('text/orca-artifact', artifactId)
 *   dataTransfer.setData('text/plain', artifactId)   // fallback for stray drops
 *   dataTransfer.effectAllowed = 'copy'
 *
 * `field/field.ts` already takes it from there: its root listens for a drop
 * carrying that type and calls `FieldHandle.dropArtifactAt(id, clientX,
 * clientY)`, which unprojects onto the z=0.05 plane. Nothing to wire here.
 * The PLACE button is the keyboard-and-mouse equivalent and goes through
 * `c.placeArtifact(id)`, which puts the artifact beside its own agent.
 */

import type { Artifact } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { authedUrl } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, esc } from '../../util.ts';
import { slabFlash } from '../fx.ts';
import { longPress } from '../../hud/longpress.ts';

/** The drag payload type. The field reads this exact string. */
export const ARTIFACT_DND = 'text/orca-artifact';

export function mountGallery(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  let project = '';   // '' = every project
  /*
   * '' = every agent. Puede venir puesto: el contador de la estantería de una
   * baldosa («+36») abre esta ventana ya filtrada por ese agente, que es lo que
   * hace que el lienzo pueda decir «hizo cuarenta» sin enseñar cuarenta.
   */
  let agent = ctx.win.spec.params?.agentId ?? '';
  let newestFirst = true;
  let sig = '';

  body.innerHTML = `
    <div class="gal__bar" data-bar></div>
    <div class="win__scroll scroll"><div class="thumbs thumbs--gal" data-grid></div></div>
  `;
  const bar = body.querySelector<HTMLElement>('[data-bar]')!;
  const grid = body.querySelector<HTMLElement>('[data-grid]')!;
  // Mantener pulsada una miniatura es su clic derecho.
  longPress(grid, { allow: (t) => !!t.closest('.thumb') });

  function all(): Artifact[] {
    return Object.values(store.world.artifacts ?? {});
  }

  function shown(): Artifact[] {
    const list = all().filter((x) =>
      (!project || x.projectId === project) && (!agent || x.agentId === agent));
    // One ordering, one toggle. Sorting by anything else is a report, not a wall.
    return list.sort((a, b) => (newestFirst ? b.at - a.at : a.at - b.at));
  }

  function render() {
    const list = shown();
    const total = all().length;
    ctx.setCallsign(`GALLERY · ${total}`);
    ctx.setTitle(list.length === total ? '' : `${list.length} SHOWN`);

    // Cheap identity: rebuild only when the set, the filters or the media move.
    const s = [
      project, agent, newestFirst, total,
      list.map((x) => `${x.id}${x.url ? '1' : '0'}${x.placement ? 'p' : ''}`).join(','),
    ].join('|');
    if (s === sig) return;
    sig = s;

    /* ── Filters: only the projects and agents that actually made something ── */
    const projects = [...new Set(all().map((x) => x.projectId))]
      .map((id) => store.world.projects[id])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => a.code.localeCompare(b.code));
    const agents = [...new Set(all()
      .filter((x) => !project || x.projectId === project)
      .map((x) => x.agentId))]
      .map((id) => store.world.agents[id])
      .filter((a): a is NonNullable<typeof a> => !!a)
      .sort((a, b) => a.callsign.localeCompare(b.callsign));

    bar.innerHTML = `
      <div class="chips">
        <button class="chip ${project ? '' : 'is-on'}" type="button" data-pj="">ALL<small>${total}</small></button>
        ${projects.map((p) => `<button class="chip ${project === p.id ? 'is-on' : ''}" type="button" data-pj="${esc(p.id)}">${esc(p.code)}<small>${all().filter((x) => x.projectId === p.id).length}</small></button>`).join('')}
      </div>
      ${agents.length > 1 ? `<div class="chips">
        <button class="chip ${agent ? '' : 'is-on'}" type="button" data-ag="">ANY AGENT</button>
        ${agents.map((a) => `<button class="chip ${agent === a.id ? 'is-on' : ''}" type="button" data-ag="${esc(a.id)}" style="--chip-state:var(--st-${esc(a.state)})">${esc(a.callsign)}</button>`).join('')}
      </div>` : ''}
      <button class="chip gal__sort" type="button" data-sort>${newestFirst ? 'NEWEST FIRST' : 'OLDEST FIRST'}</button>
    `;

    if (!list.length) {
      grid.innerHTML = `<p class="px px--tiny gal__empty">${total ? 'NOTHING MATCHES THAT FILTER.' : 'NOTHING MADE YET. AN ARTIFACT APPEARS WHEN AN AGENT WRITES A FILE IT MEANT YOU TO SEE.'}</p>`;
    } else {
      grid.innerHTML = list.map((x) => {
        const url = authedUrl(x.url);
        const a = store.world.agents[x.agentId];
        const p = store.world.projects[x.projectId];
        const media = x.kind === 'image' && url ? `<img src="${esc(url)}" alt="" loading="lazy" draggable="false" />`
          : x.kind === 'video' && url ? `<video src="${esc(url)}" muted playsinline preload="metadata"></video>`
          : `<span class="thumb__k">${esc(x.kind)}</span>`;
        return `<figure class="thumb thumb--gal ${x.placement ? 'is-placed' : ''}" draggable="true"
            data-art="${esc(x.id)}" title="${esc(x.title)} · ${esc(x.path)}">
          ${media}
          <span class="thumb__who px">${esc(a?.callsign ?? '??')}${p ? ` · ${esc(p.code)}` : ''} · ${ago(x.at)}</span>
          <span class="thumb__t">${esc(x.title)}</span>
          <button class="thumb__place slab-btn slab-btn--sm${x.placement ? '' : ' slab-btn--ghost'}" type="button" data-place="${esc(x.id)}" data-key="p">${x.placement ? 'PLACED' : 'PLACE'}</button>
        </figure>`;
      }).join('');
    }

    bar.querySelectorAll<HTMLElement>('[data-pj]').forEach((b) => b.addEventListener('click', () => {
      project = b.dataset.pj!; agent = ''; sig = ''; render();
    }));
    bar.querySelectorAll<HTMLElement>('[data-ag]').forEach((b) => b.addEventListener('click', () => {
      agent = b.dataset.ag!; sig = ''; render();
    }));
    bar.querySelector('[data-sort]')!.addEventListener('click', () => { newestFirst = !newestFirst; sig = ''; render(); });

    grid.querySelectorAll<HTMLElement>('.thumb--gal').forEach((fig) => {
      const id = fig.dataset.art!;
      fig.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-place]')) return;
        c.openArtifact(id, { x: e.clientX, y: e.clientY });
      });
      fig.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        c.menu({ kind: 'artifact', id }, { x: e.clientX, y: e.clientY });
      });
      fig.addEventListener('dragstart', (e) => {
        const dt = (e as DragEvent).dataTransfer;
        if (!dt) return;
        dt.setData(ARTIFACT_DND, id);
        dt.setData('text/plain', id); // a stray drop elsewhere pastes the id, not nothing
        dt.effectAllowed = 'copy';
        fig.classList.add('is-dragging');
      });
      fig.addEventListener('dragend', () => fig.classList.remove('is-dragging'));
    });
    grid.querySelectorAll<HTMLElement>('[data-place]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      slabFlash(b);
      c.placeArtifact(b.dataset.place!);
    }));
  }

  const off = store.on((e) => {
    if (e.k === 'world' || e.k === 'artifacts' || e.k === 'agents' || e.k === 'projects') render();
  });
  // Only the `ago` stamps age; a slow tick is enough for them.
  const tick = window.setInterval(() => { sig = ''; render(); }, 30_000);
  render();
  return { dispose() { off(); clearInterval(tick); } };
}
