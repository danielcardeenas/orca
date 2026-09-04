/**
 * The fleet scene — the ambient view.
 *
 * Not a chart with a third axis bolted on. The claim it makes is that a fleet
 * of agents has a shape you can read at a glance, from across a room, without
 * reading a single word:
 *
 *   project  -> a platform on the ground plane, outlined like an instrument
 *   agent    -> a ribbon standing on its platform
 *   working  -> the ribbon travels wide; amplitude scales with tokens/sec
 *   thinking -> it contracts and pulses from inside, barely moving
 *   blocked  -> it STOPS DEAD and goes amber. Stillness in a moving field is
 *               the loudest signal available, and it costs no colour budget.
 *   idle     -> a slow drift, almost flat
 *   dead     -> collapses to the platform, red, no motion
 *   cost     -> ribbon width. An expensive agent is visibly heavier.
 *   lineage  -> a line from a parent ribbon to each child it spawned
 *
 * The whole thing is lime wireframe on black, because it has to live under the
 * same scanlines and vignette as the rest of the console.
 */

import * as THREE from 'three';
import type { Agent, AgentState } from '../../shared/types.ts';
import { store } from '../store.ts';

const COLORS: Record<AgentState, number> = {
  booting: 0x6a8cff,
  thinking: 0x8fb8ff,
  working: 0xc0f94a,
  blocked: 0xf5a524,
  idle: 0x6e736c,
  done: 0x4a4e48,
  dead: 0xff2a12,
};

/* Ribbon vertex shader.
   v ranges 0 at the base to 1 at the tip. Displacement grows with height so
   the ribbon is planted on its platform and free at the top — the motion
   reads as a thing standing in a current, not a floating object. */
const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uAmp;      // travel width, from tokens/sec
  uniform float uSpeed;    // cycle rate
  uniform float uTwist;
  varying float vV;
  varying float vEdge;

  void main() {
    vV = uv.y;
    vEdge = abs(uv.x - 0.5) * 2.0;

    vec3 p = position;
    float h = uv.y;
    // Two waves at different rates so the loop never reads as a single sine.
    float w1 = sin(uTime * uSpeed + h * 3.1);
    float w2 = sin(uTime * uSpeed * 0.53 + h * 5.7 + 1.7);
    float sway = (w1 * 0.68 + w2 * 0.32) * uAmp;

    // Growth is straight up; the travel is lateral. Height never pumps.
    p.x += sway * h * h;
    p.z += cos(uTime * uSpeed * 0.77 + h * 4.2) * uAmp * 0.45 * h * h;
    // A slow twist keeps the flat quad from ever presenting as a flat quad.
    float t = uTwist * h;
    float c = cos(t), s = sin(t);
    p.xz = mat2(c, -s, s, c) * p.xz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uPulse;    // internal pulse, used while thinking
  uniform float uTime;
  uniform float uFade;     // 0..1 overall presence
  varying float vV;
  varying float vEdge;

  void main() {
    // Bright at the base, falling off toward the tip: the agent is anchored.
    float body = mix(1.0, 0.42, vV);
    // Hot edges give the ribbon a filament read under the scanlines.
    float edge = smoothstep(0.62, 1.0, vEdge) * 1.15;
    float pulse = 1.0 + uPulse * sin(uTime * 5.0 - vV * 9.0) * 0.5;
    float a = (body + edge) * pulse * uFade;
    gl_FragColor = vec4(uColor * (0.8 + edge * 0.9), clamp(a, 0.0, 1.0));
  }
`;

/**
 * Anillo de alarma en el suelo, bajo un agente bloqueado.
 *
 * El listón que se detiene ya es señal, pero la quietud sólo se lee si estás
 * mirando esa parte de la escena. Un anillo que late en el suelo se ve desde
 * cualquier ángulo y a cualquier distancia, que es la promesa entera de esta
 * vista: saber qué te necesita sin acercarte.
 */
const RING_GEO = new THREE.RingGeometry(0.55, 0.72, 48);
RING_GEO.rotateX(-Math.PI / 2);

interface Ribbon {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Presente sólo mientras el agente está bloqueado. */
  ring: THREE.Mesh | null;
  /** Current animated values, eased toward the targets each frame. */
  amp: number; ampTarget: number;
  speed: number; speedTarget: number;
  pulse: number; pulseTarget: number;
  fade: number; fadeTarget: number;
  color: THREE.Color; colorTarget: THREE.Color;
  height: number; heightTarget: number;
  state: AgentState;
}

export interface SceneHandle {
  setActive(on: boolean): void;
}

export function mountScene(el: HTMLElement): SceneHandle {
  el.innerHTML = `<canvas class="scene__canvas" data-canvas></canvas>
    <div class="scene__hint px px--tiny">DRAG TO ORBIT / SCROLL TO ZOOM / CLICK A RIBBON</div>
    <div class="scene__label" data-label hidden></div>`;

  const canvas = el.querySelector<HTMLCanvasElement>('[data-canvas]')!;
  const labelEl = el.querySelector<HTMLElement>('[data-label]')!;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    // No WebGL: the deck is a complete product on its own, so say so and stop.
    el.innerHTML = `<p class="scene__nogl px px--tiny">WEBGL UNAVAILABLE / USE DECK VIEW</p>`;
    return { setActive() { /* nothing to drive */ } };
  }
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0a0d, 0.016);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
  const target = new THREE.Vector3(0, 2.2, 0);

  /* Orbit state. Hand-rolled: OrbitControls is a separate import and this
     needs exactly three gestures. */
  let yaw = -0.5, pitch = 0.34, dist = 24;
  let yawV = 0, pitchV = 0;
  let dragging = false, lastX = 0, lastY = 0;
  let idleSpin = 0;

  /* ── Ground: the dot grid, matched to the radar's field ─────────── */
  {
    const cols = 46, rows = 46, step = 1.5;
    const pts: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        pts.push((i - cols / 2) * step, 0, (j - rows / 2) * step);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.PointsMaterial({
      color: 0x39404e, size: 0.085, sizeAttenuation: true,
      transparent: true, opacity: 0.9, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
  }

  /* ── Platforms and ribbons, keyed by id ─────────────────────────── */

  const platforms = new Map<string, THREE.Group>();
  const ribbons = new Map<string, Ribbon>();
  const lineageGroup = new THREE.Group();
  scene.add(lineageGroup);

  const RIBBON_GEO = new THREE.PlaneGeometry(1, 1, 3, 30);
  // Move the pivot to the base so scaling grows upward, never from the middle.
  RIBBON_GEO.translate(0, 0.5, 0);

  function platformFor(projectId: string): THREE.Group {
    let g = platforms.get(projectId);
    if (g) return g;

    g = new THREE.Group();
    const size = 4.2;

    // Outline, drawn as an instrument face rather than a filled slab.
    const half = size / 2;
    const ring = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, 0, -half),
      new THREE.Vector3(half, 0, half), new THREE.Vector3(-half, 0, half),
      new THREE.Vector3(-half, 0, -half),
    ]);
    const line = new THREE.Line(ring, new THREE.LineBasicMaterial({
      color: 0x4a5364, transparent: true, opacity: 0.95,
    }));
    g.add(line);

    // Corner ticks — the same gold/blue crosshair idea, in three dimensions.
    const tick = (x: number, z: number, color: number) => {
      const pts = [
        new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 0.45, z),
      ];
      const t = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      );
      g!.add(t);
    };
    tick(-half, -half, 0xc4a06a); tick(-half, half, 0xc4a06a);
    tick(half, -half, 0x6a8cff);  tick(half, half, 0x6a8cff);

    const label = makeLabel(store.world.projects[projectId]?.code ?? '--');
    label.position.set(0, 0.05, half + 0.55);
    g.add(label);
    g.userData.label = label;

    scene.add(g);
    platforms.set(projectId, g);
    return g;
  }

  function ribbonFor(agent: Agent): Ribbon {
    let r = ribbons.get(agent.id);
    if (r) return r;

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0 },
        uSpeed: { value: 1 },
        uTwist: { value: (Math.random() - 0.5) * 1.4 },
        uPulse: { value: 0 },
        uFade: { value: 0 },
        uColor: { value: new THREE.Color(COLORS[agent.state]) },
      },
    });
    const mesh = new THREE.Mesh(RIBBON_GEO, mat);
    mesh.userData.agentId = agent.id;
    scene.add(mesh);

    r = {
      mesh, mat,
      ring: null,
      amp: 0, ampTarget: 0,
      speed: 1, speedTarget: 1,
      pulse: 0, pulseTarget: 0,
      fade: 0, fadeTarget: 1,
      color: new THREE.Color(COLORS[agent.state]),
      colorTarget: new THREE.Color(COLORS[agent.state]),
      height: 0.4, heightTarget: 2,
      state: agent.state,
    };
    ribbons.set(agent.id, r);
    return r;
  }

  /* ── Layout ───────────────────────────────────────────────────────
     Projects on a phyllotaxis spiral so adding one never reshuffles the rest —
     the operator's spatial memory of where a project sits has to survive a new
     project appearing. */

  function layout() {
    const projects = store.activeProjects();
    const seenP = new Set<string>();

    projects.forEach((p, i) => {
      seenP.add(p.id);
      const g = platformFor(p.id);
      const a = i * 2.399963; // golden angle
      const rad = 4.6 * Math.sqrt(i + 0.6);
      g.position.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);

      const label = g.userData.label as THREE.Sprite | undefined;
      if (label && g.userData.code !== p.code) {
        g.userData.code = p.code;
        (label.material as THREE.SpriteMaterial).map?.dispose();
        (label.material as THREE.SpriteMaterial).map = makeLabelTexture(p.code);
        (label.material as THREE.SpriteMaterial).needsUpdate = true;
      }

      // Agents ring their platform, ordered so blocked ones face the camera's
      // default heading. Stable slots: an agent does not move once placed.
      const agents = store.agentsOf(p.id).filter((x) => x.state !== 'done');
      const n = Math.max(1, agents.length);
      agents.forEach((agent, j) => {
        const r = ribbonFor(agent);
        const ang = (j / n) * Math.PI * 2;
        const rr = n === 1 ? 0 : 1.35;
        r.mesh.position.set(
          g.position.x + Math.cos(ang) * rr,
          0,
          g.position.z + Math.sin(ang) * rr,
        );
        r.ring?.position.copy(r.mesh.position).setY(0.02);
      });
    });

    for (const [id, g] of platforms) {
      if (seenP.has(id)) continue;
      scene.remove(g);
      g.traverse((o) => {
        if (o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      });
      platforms.delete(id);
    }
  }

  /** Retarget every ribbon from current agent state. Cheap; runs on patches. */
  function retarget() {
    const seen = new Set<string>();
    for (const agent of Object.values(store.world.agents)) {
      if (agent.state === 'done') continue;
      seen.add(agent.id);
      const r = ribbonFor(agent);
      r.state = agent.state;
      r.colorTarget.setHex(COLORS[agent.state]);

      const tps = Math.min(80, agent.metrics.tokensPerSec);
      switch (agent.state) {
        case 'working':
          // Amplitude is the whole point: a fast agent is visibly frantic.
          r.ampTarget = 0.28 + (tps / 80) * 1.5;
          r.speedTarget = 0.9 + (tps / 80) * 2.4;
          r.pulseTarget = 0;
          break;
        case 'thinking':
          r.ampTarget = 0.12;
          r.speedTarget = 0.5;
          r.pulseTarget = 0.85; // pulses from inside instead of travelling
          break;
        case 'blocked':
          // Dead stop. Stillness inside a moving field is the alarm.
          r.ampTarget = 0;
          r.speedTarget = 0;
          r.pulseTarget = 0.5;
          break;
        case 'booting':
          r.ampTarget = 0.2; r.speedTarget = 1.6; r.pulseTarget = 0.3;
          break;
        case 'idle':
          r.ampTarget = 0.07; r.speedTarget = 0.28; r.pulseTarget = 0;
          break;
        case 'dead':
          r.ampTarget = 0; r.speedTarget = 0; r.pulseTarget = 0;
          break;
      }

      // Height reads uptime, width reads spend. Both grow straight, never pump.
      const mins = agent.uptimeMs / 60000;
      r.heightTarget = agent.state === 'dead' ? 0.35
        : 1.4 + Math.min(3.4, Math.log2(1 + mins) * 0.9);
      const w = 0.42 + Math.min(0.85, Math.sqrt(agent.metrics.costUSD) * 0.26);
      r.mesh.scale.x = w;
      r.fadeTarget = agent.state === 'dead' ? 0.5 : 1;

      const wantsRing = agent.state === 'blocked';
      if (wantsRing && !r.ring) {
        const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({
          color: 0xf5a524, transparent: true, opacity: 0.9,
          side: THREE.DoubleSide, depthWrite: false,
        }));
        ring.position.copy(r.mesh.position).setY(0.02);
        scene.add(ring);
        r.ring = ring;
      } else if (!wantsRing && r.ring) {
        scene.remove(r.ring);
        (r.ring.material as THREE.Material).dispose();
        r.ring = null;
      }
    }

    for (const [id, r] of ribbons) {
      if (seen.has(id)) continue;
      r.fadeTarget = 0;
      r.heightTarget = 0;
      // Removed on the frame its fade reaches zero, so it collapses first.
      if (r.fade < 0.02) {
        scene.remove(r.mesh);
        r.mat.dispose();
        if (r.ring) {
          scene.remove(r.ring);
          (r.ring.material as THREE.Material).dispose();
        }
        ribbons.delete(id);
      }
    }

    rebuildLineage();
  }

  /** Parent-to-child threads. Rebuilt wholesale; the count is small. */
  function rebuildLineage() {
    while (lineageGroup.children.length) {
      const c = lineageGroup.children.pop()!;
      if (c instanceof THREE.Line) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
    }
    for (const agent of Object.values(store.world.agents)) {
      if (!agent.parentId) continue;
      const child = ribbons.get(agent.id);
      const parent = ribbons.get(agent.parentId);
      if (!child || !parent) continue;
      // The thread leaves the parent high and lands on the child's base: a
      // handoff downward, which is what spawning a subagent actually is.
      const a = parent.mesh.position.clone().setY(parent.height * 0.8);
      const b = child.mesh.position.clone().setY(0.1);
      const mid = a.clone().lerp(b, 0.5).setY(Math.max(a.y, 1.2) + 0.6);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(18));
      lineageGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x3a4150, transparent: true, opacity: 0.5,
      })));
    }
  }

  /* ── Interaction ──────────────────────────────────────────────────── */

  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hovered: string | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (dragging) {
      yawV += (e.clientX - lastX) * 0.0045;
      pitchV += (e.clientY - lastY) * 0.0035;
      lastX = e.clientX; lastY = e.clientY;
      idleSpin = 0;
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.max(7, Math.min(70, dist + e.deltaY * 0.03));
  }, { passive: false });
  canvas.addEventListener('click', () => {
    if (hovered) {
      window.dispatchEvent(new CustomEvent('orca:open-agent', { detail: { id: hovered } }));
    }
  });

  /* ── Frame loop ───────────────────────────────────────────────────── */

  let active = false;
  let raf = 0;
  let last = performance.now();
  const clock = { t: 0 };

  function resize() {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock.t += dt;

    // Camera: momentum on drag, a very slow drift when left alone, so the
    // scene is never a still image but never demands attention either.
    yaw += yawV; pitch += pitchV;
    yawV *= 0.88; pitchV *= 0.88;
    if (!dragging) { idleSpin += dt; if (idleSpin > 4) yaw += dt * 0.018; }
    pitch = Math.max(0.06, Math.min(1.25, pitch));
    camera.position.set(
      target.x + Math.cos(yaw) * Math.cos(pitch) * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.sin(yaw) * Math.cos(pitch) * dist,
    );
    camera.lookAt(target);

    // Ease every ribbon toward its targets. Nothing snaps: a state change is
    // a transition you can watch, which is how the eye catches it.
    const k = 1 - Math.pow(0.001, dt);
    for (const r of ribbons.values()) {
      r.amp += (r.ampTarget - r.amp) * k;
      r.speed += (r.speedTarget - r.speed) * k;
      r.pulse += (r.pulseTarget - r.pulse) * k;
      r.fade += (r.fadeTarget - r.fade) * k;
      r.height += (r.heightTarget - r.height) * k;
      r.color.lerp(r.colorTarget, k);

      r.mesh.scale.y = Math.max(0.001, r.height);
      r.mat.uniforms.uTime!.value = clock.t;
      r.mat.uniforms.uAmp!.value = r.amp;
      r.mat.uniforms.uSpeed!.value = r.speed;
      r.mat.uniforms.uPulse!.value = r.pulse;
      r.mat.uniforms.uFade!.value = r.fade;
      (r.mat.uniforms.uColor!.value as THREE.Color).copy(r.color);
      // Ribbons always face the camera's heading so their travel stays visible.
      r.mesh.rotation.y = yaw + Math.PI / 2;

      if (r.ring) {
        // Un latido lento y amplio: se lee de lejos y no compite con el
        // movimiento de los agentes que sí están trabajando.
        const beat = 0.5 + 0.5 * Math.sin(clock.t * 2.1);
        r.ring.position.copy(r.mesh.position).setY(0.02);
        const sc = 1 + beat * 0.55;
        r.ring.scale.set(sc, 1, sc);
        (r.ring.material as THREE.MeshBasicMaterial).opacity = 0.28 + beat * 0.55;
      }
    }

    // Hover readout.
    ray.setFromCamera(ptr, camera);
    const meshes = Array.from(ribbons.values(), (r) => r.mesh);
    const hit = ray.intersectObjects(meshes, false)[0];
    const id = hit ? (hit.object.userData.agentId as string) : null;
    if (id !== hovered) {
      hovered = id;
      const a = id ? store.world.agents[id] : null;
      if (a) {
        const p = store.world.projects[a.projectId];
        labelEl.hidden = false;
        labelEl.innerHTML =
          `<span class="scene__call px">${a.callsign}</span>
           <span class="scene__ptxt px px--tiny">${p?.code ?? ''}</span>
           <span class="scene__title mono">${escHtml(a.title || 'UNTITLED')}</span>
           <span class="scene__st px px--tiny" data-s="${a.state}">${a.state.toUpperCase()}</span>`;
      } else {
        labelEl.hidden = true;
      }
      canvas.style.cursor = id ? 'none' : 'none';
    }
    if (hovered && hit) {
      const r = canvas.getBoundingClientRect();
      const v = hit.point.clone().project(camera);
      labelEl.style.left = `${((v.x + 1) / 2) * r.width}px`;
      labelEl.style.top = `${((-v.y + 1) / 2) * r.height}px`;
    }

    renderer.render(scene, camera);
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    if (on) {
      resize();
      layout();
      retarget();
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else {
      // A hidden WebGL canvas must not burn a core all day.
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  const ro = new ResizeObserver(() => { if (active) resize(); });
  ro.observe(el);

  store.on((e) => {
    if (!active) return;
    if (e.k === 'world' || e.k === 'projects') { layout(); retarget(); }
    else if (e.k === 'agents') { layout(); retarget(); }
  });

  return { setActive };
}

/* ── Sprite labels ────────────────────────────────────────────────── */

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 64);
  ctx.fillStyle = '#8b9088';
  ctx.font = '28px Tiny5, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '4px';
  ctx.fillText(text, 64, 32);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

function makeLabel(text: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: makeLabelTexture(text), transparent: true, depthWrite: false, opacity: 0.9,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(1.6, 0.8, 1);
  return s;
}

function escHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
