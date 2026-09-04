/** Deep-space radar. Circles sit on the origin; outer rings are sitting arcs; beams from the hub. */

export type RadarHandle = {
  draw: (t: number) => void;
  resize: () => void;
};

const LIME = '#c0f94a';
const LIME_LINE = 'rgba(173,246,120,0.95)';

export function createRadar(canvas: HTMLCanvasElement): RadarHandle {
  const ctx = canvas.getContext('2d')!;
  let w = 1, h = 1, dpr = 1;

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (t: number) => {
    ctx.clearRect(0, 0, w, h);
    const p = Math.max(0, Math.min(1, t));
    const cx = w * 0.5;
    const baseY = h * 0.86;
    const maxR = Math.min(w * 0.48, h * 0.78);

    const stem = easeOut(clamp((p - 0.00) / 0.18));
    const bar = easeOut(clamp((p - 0.08) / 0.18));
    const ticks = easeOut(clamp((p - 0.16) / 0.12));
    const c1 = easeOut(clamp((p - 0.20) / 0.16));
    const c2 = easeOut(clamp((p - 0.30) / 0.16));
    const c3 = easeOut(clamp((p - 0.40) / 0.16));
    const beams = easeOut(clamp((p - 0.26) / 0.22));
    const outer = easeOut(clamp((p - 0.48) / 0.22));
    const dots = easeOut(clamp((p - 0.10) / 0.18));
    const blip = clamp((p - 0.52) / 0.08);

    if (dots > 0) {
      ctx.globalAlpha = 0.5 * dots;
      ctx.fillStyle = 'rgba(160,170,165,0.55)';
      const cols = 17, rows = 9;
      const gx0 = w * 0.12, gx1 = w * 0.88;
      const gy0 = h * 0.08, gy1 = h * 0.78;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = gx0 + (i / (cols - 1)) * (gx1 - gx0);
          const y = gy0 + (j / (rows - 1)) * (gy1 - gy0);
          ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.strokeStyle = LIME_LINE;
    ctx.fillStyle = LIME;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(192,249,74,0.5)';
    ctx.shadowBlur = 10;
    ctx.lineCap = 'round';

    /* sitting circle: rests on the origin, full ring */
    const sit = (r: number, a: number, full = true) => {
      if (a <= 0 || r < 4) return;
      ctx.globalAlpha = a;
      ctx.beginPath();
      if (full) ctx.arc(cx, baseY - r, r, 0, Math.PI * 2);
      else ctx.arc(cx, baseY - r, r, Math.PI * 0.08, Math.PI - Math.PI * 0.08);
      ctx.stroke();
    };
    sit(maxR * 0.14 * Math.max(c1, 0.2), c1);
    sit(maxR * 0.32 * c2, c2);
    sit(maxR * 0.52 * c3, c3);
    /* larger sitting arcs that run off the sides */
    if (outer > 0) {
      ctx.lineWidth = 1.6;
      sit(maxR * 0.72 * outer, outer * 0.75, false);
      sit(maxR * 0.92 * outer, outer * 0.45, false);
    }

    /* diagonal beams from the hub */
    if (beams > 0) {
      ctx.globalAlpha = 0.92 * beams;
      ctx.lineWidth = 2;
      const reach = maxR * 1.02 * beams;
      const ang = Math.PI * 0.32;
      ctx.beginPath();
      ctx.moveTo(cx, baseY);
      ctx.lineTo(cx - Math.cos(ang) * reach, baseY - Math.sin(ang) * reach);
      ctx.moveTo(cx, baseY);
      ctx.lineTo(cx + Math.cos(ang) * reach, baseY - Math.sin(ang) * reach);
      ctx.stroke();
    }

    /* vertical stem */
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(cx, baseY);
    ctx.lineTo(cx, baseY - maxR * 0.94 * stem);
    ctx.stroke();

    /* baseline */
    const half = w * 0.38 * bar;
    ctx.beginPath();
    ctx.moveTo(cx - half, baseY);
    ctx.lineTo(cx + half, baseY);
    ctx.stroke();

    /* origin ring */
    ctx.beginPath();
    ctx.arc(cx, baseY, 10 * Math.max(stem, 0.25), 0, Math.PI * 2);
    ctx.stroke();

    if (ticks > 0) {
      ctx.globalAlpha = ticks;
      const xs = [-0.92, -0.38, 0.38, 0.92];
      const ts = 8;
      for (const u of xs) {
        const x = cx + half * u;
        ctx.fillRect(x - ts / 2, baseY - ts / 2, ts, ts);
      }
    }

    if (blip > 0) {
      const pulse = 0.65 + 0.35 * Math.sin(p * 22);
      ctx.globalAlpha = blip * pulse;
      ctx.shadowColor = 'rgba(255,40,30,0.9)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ff2a1a';
      const bx = cx - maxR * 0.22;
      const by = baseY - maxR * 0.58;
      ctx.fillRect(bx - 5, by - 5, 10, 10);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  };

  resize();
  return { draw, resize };
}

function clamp(n: number) { return Math.max(0, Math.min(1, n)); }
function easeOut(n: number) { return 1 - Math.pow(1 - clamp(n), 3); }
