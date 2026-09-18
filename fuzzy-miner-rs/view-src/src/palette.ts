/**
 * The Fuzzy Miner's own colour language, kept because it *is* the notation:
 * a reader who knows the original recognises a square blue activity and a
 * green octagonal cluster at a glance. Six steps, lighter to darker, indexed
 * by significance — same as ProM's, and as the Python reference's.
 */
export const ACTIVITY_COLORS = ['#c4ecf2', '#a9e8f2', '#6bd9ec', '#54d6ea', '#0cb6d1', '#0cb6d1'];
export const CLUSTER_COLORS = ['#92efd0', '#79e5c1', '#4bedb7', '#27e8a7', '#0adb95', '#0adb95'];

export function shade(palette: string[], significance: number): string {
  const i = Math.min(palette.length - 1, Math.max(0, Math.floor(significance * 5)));
  return palette[i];
}

/**
 * Ink that stays readable on those fixed fills in either theme — the node
 * background is the notation and does not follow the theme, so its text
 * cannot either.
 */
export const ON_FILL = '#0b2b33';
export const ON_FILL_DIM = '#3d6670';

/** ProM's pen width: 1–5, from the pair's mean of significance and correlation. */
export function penWidth(significance: number, correlation: number): number {
  return Math.max(1, Math.ceil(((significance + correlation) * 5) / 2));
}

/**
 * Continuous interpolation across a palette's steps, for a heatmap cell —
 * the same six-step language the node/cluster fills use, smoothed into a
 * ramp instead of the six discrete buckets `shade()` picks between.
 */
export function heatColor(palette: string[], t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  return mixHex(palette[i], palette[i + 1], frac);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bch})`;
}
