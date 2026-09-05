/**
 * The field camera.
 *
 * It faces the plane. X/Y pan, Z dolly, and an optional pitch that tilts the
 * view to show the fleet's depth. Panning and zooming are direct — a canvas
 * that lags the hand feels broken — and flights and the tilt are eased,
 * because those are the app moving, not the operator.
 */

import * as THREE from 'three';
import { clamp } from '../util.ts';
import { REDUCE } from '../motion.ts';

export const Z_MIN = 1.4;
export const Z_MAX = 420;
export const FOV = 30;
export const TILT_MAX = 0.62;

export interface CamState { x: number; y: number; z: number; pitch: number }

export class FieldCamera {
  readonly three = new THREE.PerspectiveCamera(FOV, 1, 0.05, 2000);
  /** Where the camera is now. */
  readonly cam: CamState = { x: 0, y: 0, z: 24, pitch: 0 };
  /** Where it is going. */
  readonly target: CamState = { x: 0, y: 0, z: 24, pitch: 0 };

  private w = 1;
  private h = 1;
  private reduce = REDUCE.value;
  private tmp = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.three.aspect = this.w / this.h;
    this.three.updateProjectionMatrix();
  }

  /** Advance the easing. Returns true while anything is still moving. */
  step(dt: number): boolean {
    const c = this.cam, t = this.target;
    if (this.reduce) {
      c.x = t.x; c.y = t.y; c.z = t.z; c.pitch = t.pitch;
    } else {
      const k = 1 - Math.pow(0.0012, dt);
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.z += (t.z - c.z) * k;
      c.pitch += (t.pitch - c.pitch) * k;
    }
    // Tilt swings the eye down and back so the look point stays put.
    const px = c.x;
    const py = c.y - Math.sin(c.pitch) * c.z;
    const pz = Math.cos(c.pitch) * c.z;
    this.three.position.set(px, py, pz);
    this.three.lookAt(c.x, c.y, 0);
    const moving = Math.abs(t.x - c.x) + Math.abs(t.y - c.y) + Math.abs(t.z - c.z) + Math.abs(t.pitch - c.pitch) > 0.0005;
    return moving;
  }

  /** World units per screen pixel on the plane at depth `zPlane`. */
  worldPerPixel(zPlane = 0): number {
    const d = Math.max(0.05, this.cam.z * Math.cos(this.cam.pitch) - zPlane);
    return (2 * Math.tan((FOV * Math.PI) / 360) * d) / this.h;
  }

  /** Pixels per world unit at the plane. The labels tier on this. */
  pxPerUnit(zPlane = 0): number {
    return 1 / this.worldPerPixel(zPlane);
  }

  /** The point on the plane z=`zPlane` under a canvas pixel. */
  screenToWorld(px: number, py: number, zPlane = 0): { x: number; y: number } {
    this.ndc.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.three);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (Math.abs(d.z) < 1e-6) return { x: this.cam.x, y: this.cam.y };
    const t = (zPlane - o.z) / d.z;
    return { x: o.x + d.x * t, y: o.y + d.y * t };
  }

  /** Canvas pixel of a world point, plus whether it is in front of the eye. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = this.tmp.set(x, y, z).project(this.three);
    return {
      x: ((v.x + 1) / 2) * this.w,
      y: ((-v.y + 1) / 2) * this.h,
      visible: v.z < 1 && Math.abs(v.x) < 1.6 && Math.abs(v.y) < 1.6,
    };
  }

  /** Direct pan by a pixel delta, at the plane. */
  panPx(dx: number, dy: number) {
    const per = this.worldPerPixel();
    this.target.x -= dx * per;
    this.target.y += dy * per;
    this.cam.x = this.target.x;
    this.cam.y = this.target.y;
  }

  /** Dolly toward a canvas pixel so the point under the cursor stays put. */
  zoomAt(px: number, py: number, factor: number) {
    const before = this.screenToWorld(px, py);
    this.target.z = clamp(this.target.z * factor, Z_MIN, Z_MAX);
    this.cam.z = this.target.z;
    this.step(0);
    const after = this.screenToWorld(px, py);
    this.target.x += before.x - after.x;
    this.target.y += before.y - after.y;
    this.cam.x = this.target.x;
    this.cam.y = this.target.y;
  }

  flyTo(x: number, y: number, z: number) {
    this.target.x = x; this.target.y = y; this.target.z = clamp(z, Z_MIN, Z_MAX);
  }

  frame(b: { minX: number; minY: number; maxX: number; maxY: number }, pad = 1.25) {
    const w = Math.max(2, b.maxX - b.minX), h = Math.max(2, b.maxY - b.minY);
    const aspect = this.w / this.h;
    const need = Math.max(h, w / aspect) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.flyTo((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, need * pad + 1.5);
  }

  setTilt(on: boolean) { this.target.pitch = on ? TILT_MAX : 0; }
  tilted(): boolean { return this.target.pitch > 0.01; }

  get width() { return this.w; }
  get height() { return this.h; }
}
