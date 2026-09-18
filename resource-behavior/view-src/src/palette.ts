/**
 * Colour for a person.
 *
 * The host's colour registry owns four domains — objectType, activity,
 * qualifier, artifactType — and resource is not one of them, so
 * `promenade.color('resource', …)` returns the neutral fallback for every
 * name and the whole network comes out grey. Rather than let that stand, this
 * assigns locally from the same Okabe-Ito palette the host uses, which is the
 * pattern the Dotted Chart already follows for the dimensions the host does
 * not own.
 *
 * Assignment is by name hash rather than by first appearance: colours then
 * survive a re-sort and a change of cut, and — because the Social Network
 * plugin hashes the same way — a person keeps the same colour moving from
 * their network to the organisational model built out of it. The cost is that
 * two names can collide; with a dozen colours and tens of people that is
 * certain anyway, and colour here is identity-at-a-glance, not a key.
 */

/** Okabe-Ito, colour-vision-deficiency safe, matching the host's own list. */
const PALETTE = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#8E6C8A', '#4C9F70',
  '#B07AA1', '#8C564B', '#7F7F7F', '#17919B',
];

const cache = new Map<string, string>();

export function resourceColor(name: string): string {
  const hit = cache.get(name);
  if (hit) return hit;
  // FNV-1a: cheap, and spreads adjacent names (`11169`, `11170`) across the
  // palette instead of giving them neighbouring entries.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const color = PALETTE[h % PALETTE.length];
  cache.set(name, color);
  return color;
}
