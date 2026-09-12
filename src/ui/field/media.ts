/**
 * Media in the field.
 *
 * An artifact the operator pulled out of its agent becomes a real surface in
 * the space: an image or a video as a textured quad next to the agent that
 * made it, HTML or text as a sandboxed DOM surface projected over the canvas.
 * Work appears where you are, instead of as a path in a log line.
 *
 * Una superficie sola no dice de quién es ni de cuándo, así que cada una lleva
 * dos cosas más, que no viven aquí del todo: un **pie** DOM con qué · quién ·
 * hace cuánto (`.srf-cap` bajo un cuadro, `.srf__who` en la barra de una
 * superficie DOM), y un **tirante** hasta la baldosa que la hizo, que dibuja
 * `field.ts` con `tether.ts` a partir de `rects()` — por eso `MediaRect` dice
 * si la superficie se está dibujando: un tirante a una superficie retirada
 * sería una línea a la nada.
 */

import * as THREE from 'three';
import type { Artifact } from '../../shared/types.ts';
import { ago, esc } from '../util.ts';
import { authedUrl } from '../net/client.ts';
import { MEDIA_W, opaqueLabel, surfaceIsOpaque, surfacePlays, surfaceShows } from './surface.ts';
import type { FieldCamera } from './camera.ts';

const MAX_MEDIA = 40;
/**
 * Ancho dibujado, en píxeles, a partir del cual una superficie lleva su pie.
 * Por debajo el pie sería más ancho que la imagen que describe; y a ese
 * tamaño la superficie ya es una mancha con un tirante, que es suficiente.
 */
const CAP_MIN_PX = 120;
/** Cada cuánto se reescribe el «hace N» de los pies, en milisegundos. */
const CAP_REFRESH_MS = 15_000;

export interface MediaRect {
  id: string; x: number; y: number; z: number; w: number; h: number;
  /** Se está dibujando este fotograma: en pantalla y con tamaño de imagen. El tirante sigue a esto. */
  shown: boolean;
}

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
  /** Se dibujó en el último `reproject`. */
  shown: boolean;
  mesh?: THREE.Mesh;
  frame?: THREE.Mesh;
  video?: HTMLVideoElement;
  el?: HTMLElement;
  /**
   * El pie: qué es, quién lo hizo y hace cuánto, en una línea bajo la
   * superficie. Un cuadro con textura no puede decir nada de eso por sí
   * mismo, y una imagen flotando sobre el campo sin las tres cosas es una
   * foto en el suelo. En una superficie DOM va dentro de su barra (`who`).
   */
  cap?: HTMLElement;
  who?: HTMLElement;
}

export function createMedia(
  scene: THREE.Scene,
  surfaces: HTMLElement,
  camera: FieldCamera,
  onClose: (id: string) => void,
  /** El indicativo de un agente, o null si el campo ya no lo conoce. */
  callsignOf: (agentId: string) => string | null = () => null,
): MediaHandle {
  const entries = new Map<string, Entry>();
  let capAt = 0;

  /** Quién y cuándo, como lo lee una persona: `CS-7 · 3M`. Sin agente, sólo el cuándo. */
  function whoWhen(a: Artifact, now: number): string {
    const cs = a.agentId ? callsignOf(a.agentId) : null;
    return cs ? `${cs} · ${ago(a.at, now)}` : ago(a.at, now);
  }
  function writeCaptions(now: number) {
    capAt = now;
    for (const e of entries.values()) {
      if (e.cap) e.cap.innerHTML = `<b>${esc(e.art.title)}</b> · ${esc(whoWhen(e.art, now))}`;
      if (e.who) e.who.textContent = whoWhen(e.art, now);
    }
  }
  const loader = new THREE.TextureLoader();
  // The frame sits a hair behind the picture, closer than the depth buffer
  // can tell apart from a few dozen units out. It never writes depth and is
  // drawn first (renderOrder), so the picture is painted over it and not
  // fought for pixel by pixel — the flicker that only zooming in used to stop.
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x2a2e38, depthWrite: false });

  function sizeOf(a: Artifact): { w: number; h: number } {
    // Una ficha opaca es una tarjeta con dos palabras: ni una foto ni una página.
    if (surfaceIsOpaque(a.kind)) return { w: MEDIA_W, h: MEDIA_W * 0.22 };
    const ratio = a.width && a.height ? a.height / a.width : (a.kind === 'html' || a.kind === 'text' ? 0.7 : 0.62);
    return { w: MEDIA_W, h: MEDIA_W * ratio };
  }

  function mount(a: Artifact) {
    const { w, h } = sizeOf(a);
    const p = a.placement!;
    const e: Entry = { art: a, x: p.x, y: p.y, z: p.z, w, h, shown: false };
    const url = authedUrl(a.url);
    if ((a.kind === 'image' || a.kind === 'video') && url) {
      let tex: THREE.Texture;
      if (a.kind === 'video') {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.loop = true; v.playsInline = true;
        v.crossOrigin = 'anonymous';
        // Quién reproduce es `reproject`, que es quien sabe si se está mirando.
        // Arrancar aquí dejaría decodificando a un vídeo fuera de cuadro hasta
        // el primer frame, y a uno que nunca entra en cuadro, para siempre.
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
      // El pie, DOM proyectado como los rótulos: a tamaño de letra fijo, no
      // escala con el zoom, y se retira antes que la imagen (`CAP_MIN_PX`).
      const cap = document.createElement('div');
      cap.className = 'srf-cap px px--tiny';
      cap.dataset.id = a.id;
      cap.hidden = true;
      surfaces.appendChild(cap);
      e.cap = cap;
    } else {
      const el = document.createElement('div');
      el.className = 'srf';
      el.dataset.id = a.id;
      el.innerHTML = `<div class="srf__bar"><span class="px px--tiny">${esc(a.title)}`
        + `<span class="srf__who" data-who></span></span>`
        + `<button class="srf__x" type="button" data-close>×</button></div>`;
      e.who = el.querySelector<HTMLElement>('[data-who]')!;
      if (a.kind === 'html' && url) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', '');
        f.src = url;
        f.title = a.title;
        el.appendChild(f);
      } else if (surfaceIsOpaque(a.kind)) {
        /*
         * Un `.zip` no tiene dentro nada que mirar, y bajarlo para pintarlo como
         * texto es lo que pone caracteres de reemplazo sobre el lienzo. Se dice
         * lo único que se puede decir con verdad: qué es y cuánto pesa.
         */
        const k = document.createElement('p');
        k.className = 'srf__opaque px';
        k.textContent = opaqueLabel(a.path, a.bytes);
        el.appendChild(k);
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
    e.cap?.remove();
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
      // Quién y cuándo, una vez por feed: un indicativo que llega, o un
      // artefacto reescrito, cambian el pie y no hay que esperar al reloj.
      writeCaptions(Date.now());
    },

    reproject() {
      const now = Date.now();
      // El «hace N» envejece solo: se reescribe cada quince segundos, que es
      // la resolución con la que `ago` cambia de palabra.
      if (now - capAt > CAP_REFRESH_MS) writeCaptions(now);
      for (const e of entries.values()) {
        const p = camera.project(e.x - e.w / 2, e.y + e.h / 2, e.z);
        const pxWide = e.w * camera.pxPerUnit(e.z);
        /*
         * Un cuadro que ya no es una imagen se retira, en vez de quedarse como
         * una mancha de color sobre la silueta de la flota (`surface.ts`). Y un
         * vídeo que nadie está mirando deja de decodificar: seguir subiendo un
         * fotograma por frame a la GPU desde fuera de cuadro cuesta un
         * decodificador de hardware, y de ésos hay cuatro.
         */
        if (e.mesh) {
          const shows = p.visible && surfaceShows(pxWide);
          e.shown = shows;
          e.mesh.visible = shows;
          if (e.frame) e.frame.visible = shows;
          if (e.video) {
            const play = surfacePlays(p.visible, pxWide);
            if (play && e.video.paused) void e.video.play().catch(() => { /* sigue en pausa */ });
            else if (!play && !e.video.paused) e.video.pause();
          }
          if (e.cap) {
            const capShows = shows && pxWide >= CAP_MIN_PX;
            e.cap.hidden = !capShows;
            if (capShows) {
              const q = camera.project(e.x - e.w / 2, e.y - e.h / 2, e.z);
              e.cap.style.transform = `translate3d(${q.x.toFixed(1)}px, ${(q.y + 3).toFixed(1)}px, 0)`;
              e.cap.style.maxWidth = `${Math.round(pxWide)}px`;
            }
          }
          continue;
        }
        if (!e.el) continue;
        if (!p.visible) { e.el.style.display = 'none'; e.shown = false; continue; }
        const scale = camera.pxPerUnit(e.z) / BASE;
        if (scale < 0.18) { e.el.style.display = 'none'; e.shown = false; continue; }
        e.shown = true;
        e.el.style.display = '';
        e.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
      }
    },

    rects() {
      const out: MediaRect[] = [];
      for (const e of entries.values()) out.push({ id: e.art.id, x: e.x, y: e.y, z: e.z, w: e.w, h: e.h, shown: e.shown });
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
