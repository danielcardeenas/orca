/** Pixel ORCA wordmark, reconstructed from the Offworld boot sequence. */

export const O = [
  '.####.',
  '##..##',
  '##..##',
  '##..##',
  '##..##',
  '##..##',
  '.####.',
];
export const R = [
  '#####.',
  '##..##',
  '##..##',
  '#####.',
  '##.##.',
  '##..##',
  '##..##',
];
export const C = [
  '.####.',
  '##....',
  '##....',
  '##....',
  '##....',
  '##....',
  '.####.',
];
export const A = [
  '.####.',
  '##..##',
  '##..##',
  '######',
  '##..##',
  '##..##',
  '##..##',
];

export type Letter = string[];

export function stackORCA(): string[] {
  const gap = '  ';
  const top = O.map((row, i) => row + gap + R[i]);
  const bot = C.map((row, i) => row + gap + A[i]);
  const w = top[0]!.length;
  return [...top, '.'.repeat(w), ...bot];
}

export function inlineORCA(): string[] {
  const g = '.';
  return O.map((row, i) => row + g + R[i] + g + C[i] + g + A[i]);
}

export function drawBits(
  ctx: CanvasRenderingContext2D,
  bits: string[],
  x: number,
  y: number,
  cell: number,
  color: string,
  gap = 0.12,
) {
  const s = cell * (1 - gap);
  ctx.fillStyle = color;
  for (let j = 0; j < bits.length; j++) {
    const row = bits[j]!;
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== '#') continue;
      const px = x + i * cell;
      const py = y + j * cell;
      ctx.fillRect(px, py, s, s);
    }
  }
}

/** Halftone square with ORCA punched out as a hole — the POST mark. */
export function drawDotted(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color = 'rgba(210,215,220,0.92)',
) {
  const n = 28;
  const step = size / n;
  const bits = stackORCA();
  const bh = bits.length;
  const bw = bits[0]!.length;
  const pad = 5;
  const usable = n - pad * 2;
  ctx.fillStyle = color;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i - pad) / usable;
      const v = (j - pad) / usable;
      let hole = false;
      if (u >= 0 && v >= 0 && u < 1 && v < 1) {
        const cx = Math.floor(u * bw);
        const cy = Math.floor(v * bh);
        hole = bits[cy]?.[cx] === '#';
      }
      if (hole) continue;
      const r = step * 0.28;
      ctx.beginPath();
      ctx.arc(x + (i + 0.5) * step, y + (j + 0.5) * step, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function sizeOf(bits: string[], cell: number) {
  return { w: bits[0]!.length * cell, h: bits.length * cell };
}
