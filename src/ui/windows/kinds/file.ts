/**
 * A file on disk, looked at where you are.
 *
 * An agent writes a path (see ../paths.ts); this is what opens when the
 * operator clicks it. The hub serves the bytes from `/api/file` (hub/files.ts
 * decides what it will and will not serve) and this window shows them the
 * way the file wants to be seen:
 *
 *   image      fit to the window, 1:1, zoom in and out
 *   text/code  line numbers, highlighted when the language is known, and the
 *              line the agent pointed at scrolled into view and marked
 *   markdown   rendered, with its own paths linked; SOURCE shows the text
 *   html       a sandboxed frame — the hub also sends CSP sandbox, so a page
 *              an agent wrote cannot script against the console
 *   pdf        the browser's own viewer, in a frame
 *   audio/video native controls
 *
 * The header carries the whole path; COPY puts it on the clipboard and RAW
 * opens the bytes in a browser tab. There is no "reveal in Finder": the
 * console may be on a phone and the file on a machine across the world, and
 * nothing in ORCA can open a desktop app there.
 */

import { store } from '../../store.ts';
import { authedUrl, hub } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { esc } from '../../util.ts';
import { slabFlash } from '../fx.ts';
import { highlight, mdLite } from '../markdown.ts';
import { baseName, dirName, fileKind, languageOf, linkPaths } from '../paths.ts';

/** Past this, a text file is shown truncated: the browser, not the hub, is the limit. */
const MAX_TEXT_CHARS = 2_000_000;
/** Line height of the code view, px. CSS agrees (`--file-lh`). */
const LINE_H = 18;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The 403 bodies the hub sends (`hub/files.ts`, `REFUSAL`), as the line the
 * operator reads — and whether ALLOW can do anything about it.
 *
 * A copy, not an import: this module is bundled for the browser and
 * `hub/files.ts` drags `node:fs` behind it. `test/file-browser.shots.ts`
 * imports the original and checks against the live hub that both halves still
 * say the same thing.
 */
const REFUSALS: Array<{ body: string; line: string; allow: boolean }> = [
  {
    body: 'ruta privada excluida',
    allow: false,
    line: 'NOT SERVED BY POLICY · a private folder or a credential name · no ALLOW opens it',
  },
  {
    body: 'fuera de las raíces de proyecto conocidas',
    allow: true,
    line: 'OUTSIDE THE PROJECT ROOTS · the hub serves known projects, the agents\' scratchpad and folders you allow',
  },
  {
    body: 'la ruta apunta fuera de las raíces (symlink)',
    allow: false,
    line: 'OUTSIDE THE PROJECT ROOTS · a symlink pointing out of them · allowing this folder would not move where it points',
  },
];

/**
 * What the hub said when it refused, and whether to offer ALLOW.
 *
 * Every 403 used to print one fixed line — "outside the project roots" — and
 * then offer the button. For a path vetoed by policy the line was false and
 * the button could never work: `files:allow` goes through the very check that
 * just said no (`hub/file-roots.ts`). That cost a red shot a diagnosis. The
 * reason has always travelled in the body; this reads it.
 */
export function refusalOf(status: number, body: string): { line: string; allow: boolean } {
  const said = body.trim();
  switch (status) {
    case 401: return { line: 'NOT AUTHORISED · the console has no token for this hub', allow: false };
    case 403: {
      const known = REFUSALS.find((r) => r.body === said);
      // A 403 we do not know: show what it said and keep offering ALLOW, which
      // is what the console did before it could tell them apart.
      return known ? { line: known.line, allow: known.allow }
        : { line: said ? `NOT SERVED · ${said}` : 'NOT SERVED · the hub refused this path', allow: true };
    }
    case 404: return { line: 'NOT FOUND · not on the hub\'s machine, or not a file', allow: false };
    case 413: return { line: `TOO BIG · ${said || 'above the hub\'s limit'}`, allow: false };
    default: return { line: `HTTP ${status}${said ? ` · ${said}` : ''}`, allow: false };
  }
}

/** The line alone, which is all the folder browser needs (files.ts). */
export function refusal(status: number, body: string): string {
  return refusalOf(status, body).line;
}

export function mountFile(ctx: WinCtx, _c: Console) {
  const params = ctx.win.spec.params ?? {};
  const path = params.path ?? '';
  const line = params.line ? Number(params.line) : null;
  const kind = fileKind(path);
  const url = authedUrl(`/api/file?path=${encodeURIComponent(path)}`)!;
  const body = ctx.body;
  body.classList.add('file-workspace');
  ctx.setTitle(baseName(path));
  ctx.setCallsign(params.project ?? kind.toUpperCase().slice(0, 4), params.project ? kind.toUpperCase() : undefined);

  body.innerHTML = `
    <div class="file__bar">
      <span class="file__path mono" title="${esc(path)}">${line !== null ? `<span class="file__at">:${line}${params.col ? `:${esc(params.col)}` : ''}</span>` : ''}<b>${esc(baseName(path))}</b><span class="file__dir">${esc(dirName(path))}/</span></span>
      <div class="row">
        <span class="px px--tiny" data-meta>${esc(kind.toUpperCase())}</span>
        <button class="btn" type="button" data-copy data-key="c" title="Copy the full path">COPY</button>
        <button class="btn" type="button" data-raw data-key="r" title="The bytes, in a browser tab">RAW</button>
      </div>
    </div>
    <div class="file__tools row" data-tools hidden></div>
    <div class="file__view" data-view><p class="px px--tiny file__msg">LOADING…</p></div>
  `;
  const view = body.querySelector<HTMLElement>('[data-view]')!;
  const tools = body.querySelector<HTMLElement>('[data-tools]')!;
  const meta = body.querySelector<HTMLElement>('[data-meta]')!;
  let disposed = false;

  const copyBtn = body.querySelector<HTMLElement>('[data-copy]')!;
  copyBtn.addEventListener('click', () => {
    slabFlash(copyBtn);
    navigator.clipboard?.writeText(path).then(() => _c.note(`copied ${path}`)).catch(() => _c.note('the browser refused the clipboard', 'warn'));
  });
  body.querySelector('[data-raw]')!.addEventListener('click', () => window.open(url, '_blank', 'noopener'));

  const fail = (status: number, text: string) => {
    const why = refusalOf(status, text);
    view.innerHTML = `<p class="px px--tiny file__msg is-warn">${esc(why.line)}</p>`;
    meta.textContent = `HTTP ${status}`;
    if (!why.allow || !store.linkUp) return;
    // This 403 is a folder the hub does not know, not a file it will never
    // show. One press names the folder; the hub remembers it (file-roots.ts).
    const allow = document.createElement('button');
    allow.className = 'slab-btn slab-btn--sm slab-btn--fit';
    allow.type = 'button';
    allow.textContent = `ALLOW ${dirName(path)}`;
    allow.title = 'Let the hub serve this folder, now and after a restart';
    view.appendChild(allow);
    allow.addEventListener('click', async () => {
      slabFlash(allow);
      allow.disabled = true;
      try {
        const out = await hub.cmd({ k: 'files:allow', path }) as { root: string; added: boolean } | undefined;
        _c.note(out?.added === false ? `${out.root} was already allowed` : `the hub now serves ${out?.root ?? dirName(path)}`);
        if (!disposed) void load();
      } catch (err) {
        _c.note(`not allowed · ${(err as Error).message}`, 'warn');
        allow.disabled = false;
      }
    });
  };

  function setMeta(size: number | null, extra = '') {
    meta.textContent = [kind.toUpperCase(), size !== null ? bytes(size) : '', extra].filter(Boolean).join(' · ');
  }

  /* ── image: width, fit, 1:1, zoom ──────────────────────────────── */
  /**
   * WIDTH is the default: the image takes the window's width and the rest
   * scrolls, the way a page does. A tall screenshot or a long comparison is
   * readable as it arrives, without zooming in or pulling the window taller.
   * FIT letterboxes the whole thing into view; 1:1 and the zoom steps scroll.
   * Click toggles between WIDTH and 1:1.
   */
  function showImage(size: number | null) {
    view.innerHTML = `<div class="file__img is-width" data-pan><img src="${esc(url)}" alt="${esc(baseName(path))}" draggable="false" /></div>`;
    const pan = view.querySelector<HTMLElement>('[data-pan]')!;
    const img = pan.querySelector('img')!;
    let scale: number | 'width' | 'fit' = 'width';
    const apply = () => {
      pan.classList.toggle('is-width', scale === 'width');
      pan.classList.toggle('is-fit', scale === 'fit');
      img.style.width = typeof scale === 'number' ? `${img.naturalWidth * scale}px` : '';
      img.style.height = typeof scale === 'number' ? `${img.naturalHeight * scale}px` : '';
      tools.querySelector('[data-zoom-width]')?.classList.toggle('is-on', scale === 'width');
      tools.querySelector('[data-zoom-fit]')?.classList.toggle('is-on', scale === 'fit');
      tools.querySelector('[data-zoom-1]')?.classList.toggle('is-on', scale === 1);
      setMeta(size, `${img.naturalWidth}×${img.naturalHeight} · ${typeof scale === 'number' ? `${Math.round(scale * 100)}%` : scale.toUpperCase()}`);
    };
    tools.hidden = false;
    tools.innerHTML = `
      <button class="chip is-on" type="button" data-zoom-width data-key="w">WIDTH</button>
      <button class="chip" type="button" data-zoom-fit data-key="f">FIT</button>
      <button class="chip" type="button" data-zoom-1 data-key="1">1:1</button>
      <button class="chip" type="button" data-zoom-out data-key="-">−</button>
      <button class="chip" type="button" data-zoom-in data-key="=">+</button>`;
    // A zoom step starts from what is on screen: the rendered scale, whatever mode set it.
    const shown = () => typeof scale === 'number' ? scale : img.clientWidth / Math.max(1, img.naturalWidth);
    const zoomBy = (k: number) => { scale = Math.min(16, Math.max(0.05, shown() * k)); apply(); };
    tools.querySelector('[data-zoom-width]')!.addEventListener('click', () => { scale = 'width'; apply(); });
    tools.querySelector('[data-zoom-fit]')!.addEventListener('click', () => { scale = 'fit'; apply(); });
    tools.querySelector('[data-zoom-1]')!.addEventListener('click', () => { scale = 1; apply(); });
    tools.querySelector('[data-zoom-in]')!.addEventListener('click', () => zoomBy(1.25));
    tools.querySelector('[data-zoom-out]')!.addEventListener('click', () => zoomBy(0.8));
    img.addEventListener('click', () => { scale = scale === 1 ? 'width' : 1; apply(); });
    // A pinch over the image is the image's. The window forwards a pinch on
    // its housing to the field (wm.ts), so without stopping it here one
    // gesture would zoom both the picture and the canvas under it.
    pan.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); e.stopPropagation();
      zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
    img.addEventListener('load', apply);
    img.addEventListener('error', () => fail(0, 'the image did not load'));
  }

  /* ── text and code ─────────────────────────────────────────────── */
  function showText(text: string, size: number) {
    const cut = text.length > MAX_TEXT_CHARS;
    const shown = cut ? text.slice(0, MAX_TEXT_CHARS) : text;
    const lines = shown.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const lang = languageOf(path);
    const code = highlight(shown, lang) ?? esc(shown);
    const gutter = lines.map((_, i) => i + 1).join('\n');
    view.innerHTML = `<div class="file__code" data-code>
      <pre class="file__gutter mono" aria-hidden="true">${gutter}</pre>
      <pre class="file__src mono"><code class="hljs">${code}</code></pre>
      ${line !== null && line >= 1 && line <= lines.length ? `<i class="file__mark" style="top:${(line - 1) * LINE_H}px"></i>` : ''}
    </div>${cut ? `<p class="px px--tiny file__msg is-warn">SHOWING THE FIRST ${bytes(MAX_TEXT_CHARS)} · RAW HAS THE REST</p>` : ''}`;
    setMeta(size, `${lines.length} LINES${lang ? ` · ${lang.toUpperCase()}` : ''}`);
    tools.hidden = false;
    tools.innerHTML = `<button class="chip" type="button" data-wrap data-key="w">WRAP</button>`;
    const codeEl = view.querySelector<HTMLElement>('[data-code]')!;
    tools.querySelector('[data-wrap]')!.addEventListener('click', (e) => {
      const on = codeEl.classList.toggle('is-wrap');
      (e.currentTarget as HTMLElement).classList.toggle('is-on', on);
      // Wrapped lines break the gutter's arithmetic; hide it rather than lie.
    });
    if (line !== null) requestAnimationFrame(() => { codeEl.scrollTop = Math.max(0, (line - 1) * LINE_H - codeEl.clientHeight / 2 + LINE_H / 2); });
  }

  /* ── markdown: rendered, or the source ─────────────────────────── */
  function showMarkdown(text: string, size: number) {
    let mode: 'rendered' | 'source' = 'rendered';
    const draw = () => {
      if (mode === 'source') { showText(text, size); tools.insertAdjacentHTML('afterbegin', `<button class="chip" type="button" data-mode data-key="m">RENDERED</button>`); }
      else {
        view.innerHTML = `<div class="file__md talk__text mono">${linkPaths(mdLite(text.slice(0, MAX_TEXT_CHARS)), { root: dirName(path) })}</div>`;
        setMeta(size, 'RENDERED');
        tools.hidden = false;
        tools.innerHTML = `<button class="chip" type="button" data-mode data-key="m">SOURCE</button>`;
      }
      tools.querySelector('[data-mode]')!.addEventListener('click', () => { mode = mode === 'source' ? 'rendered' : 'source'; draw(); });
    };
    draw();
  }

  async function load() {
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'html') {
      // The browser fetches the bytes itself; a HEAD first says whether it may.
      let head: Response;
      try { head = await fetch(url, { method: 'HEAD' }); } catch { if (!disposed) fail(0, 'the hub did not answer'); return; }
      if (disposed) return;
      if (!head.ok) { fail(head.status, (await fetch(url).then((r) => r.text()).catch(() => '')).slice(0, 200)); return; }
      const size = Number(head.headers.get('x-orca-file-size') ?? head.headers.get('content-length') ?? '');
      const known = Number.isFinite(size) && size > 0 ? size : null;
      setMeta(known);
      if (kind === 'image') showImage(known);
      else if (kind === 'video') view.innerHTML = `<video class="file__media" src="${esc(url)}" controls playsinline></video>`;
      else if (kind === 'audio') view.innerHTML = `<div class="file__audio"><audio src="${esc(url)}" controls></audio></div>`;
      else if (kind === 'html') view.innerHTML = `<iframe class="file__frame" sandbox="" src="${esc(url)}" title="${esc(baseName(path))}"></iframe>`;
      else view.innerHTML = `<iframe class="file__frame is-pdf" src="${esc(url)}" title="${esc(baseName(path))}"></iframe>`;
      return;
    }
    let res: Response;
    try { res = await fetch(url); } catch { if (!disposed) fail(0, 'the hub did not answer'); return; }
    if (disposed) return;
    if (!res.ok) { fail(res.status, (await res.text().catch(() => '')).slice(0, 200)); return; }
    const buf = await res.arrayBuffer();
    if (disposed) return;
    const size = buf.byteLength;
    const probe = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192));
    if (probe.includes(0)) {
      view.innerHTML = `<p class="px px--tiny file__msg">BINARY · ${esc(bytes(size))} · RAW DOWNLOADS IT</p>`;
      setMeta(size, 'BINARY');
      return;
    }
    const text = new TextDecoder('utf-8').decode(buf);
    if (kind === 'markdown') showMarkdown(text, size);
    else showText(text, size);
  }

  void load();

  return {
    dispose() { disposed = true; },
    state: () => ({ path, line }),
  };
}

/** The project code of an agent, for the viewer's header. */
export function projectCodeOf(agentId: string | null | undefined): string | undefined {
  if (!agentId) return undefined;
  const a = store.knownAgent(agentId);
  return a ? store.world.projects[a.projectId]?.code : undefined;
}
