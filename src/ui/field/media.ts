/**
 * Media in the field.
 *
 * An artifact the operator pulled out of its agent becomes a real surface in
 * the space: an image or a video as a textured quad next to the agent that
 * made it, HTML or text as a sandboxed DOM surface projected over the canvas.
 * Work appears where you are, instead of as a path in a log line.
 */

import * as THREE from 'three';
import type { Artifact } from '../../shared/types.ts';
import { esc } from '../util.ts';
import { authedUrl } from '../net/client.ts';
import type { FieldCamera } from './camera.ts';

export const MEDIA_W = 2.4;
const MAX_MEDIA = 40;

export interface MediaRect { id: string; x: number; y: number; z: number; w: number; h: number }

export interface MediaHandle {
  update(artifacts: Artifact[]): void;
  /** Called every frame so DOM surfaces track the camera. */
  reproject(): void;
  rects(): MediaRect[];
  /** Live drag: move a surface without waiting for the store. */
  nudge(id: string, x: number, y: number): void;
  dispose(): void;
}

interface Entry {
  art: Artifact;
  x: number; y: number; z: number;
  w: number; h: number;
  mesh?: THREE.Mesh;
  frame?: THREE.Mesh;
  video?: HTMLVideoElement;
  el?: HTMLElement;
}

export function createMedia(
  scene: THREE.Scene,
  surfaces: HTMLElement,
  camera: FieldCamera,
  onClose: (id: string) => void,
): MediaHandle {
  const entries = new Map<string, Entry>();
  const loader = new THREE.TextureLoader();
  // The frame sits a hair behind the picture, closer than the depth buffer
  // can tell apart from a few dozen units out. It never writes depth and is
  // drawn first (renderOrder), so the picture is painted over it and not
  // fought for pixel by pixel — the flicker that only zooming in used to stop.
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x2a2e38, depthWrite: false });

  function sizeOf(a: Artifact): { w: number; h: number } {
    const ratio = a.width && a.height ? a.height / a.width : (a.kind === 'html' || a.kind === 'text' ? 0.7 : 0.62);
    return { w: MEDIA_W, h: MEDIA_W * ratio };
  }

  function mount(a: Artifact) {
    const { w, h } = sizeOf(a);
    const p = a.placement!;
    const e: Entry = { art: a, x: p.x, y: p.y, z: p.z, w, h };
    const url = authedUrl(a.url);
    if ((a.kind === 'image' || a.kind === 'video') && url) {
      let tex: THREE.Texture;
      if (a.kind === 'video') {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.crossOrigin = 'anonymous';
        void v.play().catch(() => { /* autoplay may need a gesture; the quad stays black until then */ });
        tex = new THREE.VideoTexture(v);
        e.video = v;
      } else {
        tex = loader.load(url, (t) => {
          // Once the real dimensions are known, keep the quad's ratio honest.
          const img = t.image as { width?: number; height?: number };
          if (img?.width && img?.height && e.mesh) {
            const nh = MEDIA_W * (img.height / img.width);
            e.h = nh;
            e.mesh.scale.set(MEDIA_W, nh, 1);
            e.frame?.scale.set(MEDIA_W + 0.08, nh + 0.08, 1);
          }
        });
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.scale.set(w, h, 1);
      mesh.position.set(e.x, e.y, e.z);
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), frameMat);
      frame.scale.set(w + 0.08, h + 0.08, 1);
      frame.position.set(e.x, e.y, e.z - 0.004);
      frame.renderOrder = 0;
      mesh.renderOrder = 1;
      scene.add(frame, mesh);
      e.mesh = mesh; e.frame = frame;
    } else {
      const el = document.createElement('div');
      el.className = 'srf';
      el.dataset.id = a.id;
      el.innerHTML = `<div class="srf__bar"><span class="px px--tiny">${esc(a.title)}</span>`
        + `<button class="srf__x" type="button" data-close>×</button></div>`;
      if (a.kind === 'html' && url) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', '');
        f.src = url;
        f.title = a.title;
        el.appendChild(f);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'mono';
        pre.textContent = '…';
        el.appendChild(pre);
        if (url) {
          fetch(url).then((r) => r.text()).then((t) => { pre.textContent = t.slice(0, 20_000); })
            .catch(() => { pre.textContent = 'could not load'; });
        }
      }
      el.querySelector('[data-close]')!.addEventListener('click', (ev) => { ev.stopPropagation(); onClose(a.id); });
      // Base size in CSS px at 1 world unit = BASE px; scaled per frame.
      el.style.width = `${Math.round(w * BASE)}px`;
      el.style.height = `${Math.round(h * BASE)}px`;
      surfaces.appendChild(el);
      e.el = el;
    }
    entries.set(a.id, e);
  }

  function unmount(e: Entry) {
    if (e.mesh) {
      scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      const m = e.mesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
    if (e.frame) { scene.remove(e.frame); e.frame.geometry.dispose(); }
    if (e.video) { e.video.pause(); e.video.src = ''; }
    e.el?.remove();
  }

  /** CSS px per world unit at which a surface reads 1:1 — reading distance. */
  const BASE = 260;

  return {
    update(artifacts) {
      const want = new Map<string, Artifact>();
      for (const a of artifacts) if (a.placement) want.set(a.id, a);
      for (const [id, e] of entries) {
        const a = want.get(id);
        if (!a || a.url !== e.art.url || a.kind !== e.art.kind) { unmount(e); entries.delete(id); }
      }
      let n = entries.size;
      for (const a of want.values()) {
        const e = entries.get(a.id);
        if (e) {
          e.art = a;
          const p = a.placement!;
          e.x = p.x; e.y = p.y; e.z = p.z;
          e.mesh?.position.set(p.x, p.y, p.z);
          e.frame?.position.set(p.x, p.y, p.z - 0.004);
          continue;
        }
        if (n >= MAX_MEDIA) break;
        mount(a);
        n++;
      }
    },

    reproject() {
      for (const e of entries.values()) {
        if (!e.el) continue;
        const p = camera.project(e.x - e.w / 2, e.y + e.h / 2, e.z);
        if (!p.visible) { e.el.style.display = 'none'; continue; }
        const scale = camera.pxPerUnit(e.z) / BASE;
        if (scale < 0.18) { e.el.style.display = 'none'; continue; }
        e.el.style.display = '';
        e.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
      }
    },

    rects() {
      const out: MediaRect[] = [];
      for (const e of entries.values()) out.push({ id: e.art.id, x: e.x, y: e.y, z: e.z, w: e.w, h: e.h });
      return out;
    },

    nudge(id, x, y) {
      const e = entries.get(id);
      if (!e) return;
      e.x = x; e.y = y;
      e.mesh?.position.set(x, y, e.z);
      e.frame?.position.set(x, y, e.z - 0.004);
    },

    dispose() {
      for (const e of entries.values()) unmount(e);
      entries.clear();
      frameMat.dispose();
    },
  };
}
