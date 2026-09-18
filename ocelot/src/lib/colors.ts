/**
 * The type-graph palette, ported from Ocelot: object types are colored by
 * their *index* in the declared type list (not a hash of the name), so the
 * same log always renders the same colors run to run, and reordering the
 * declared types would shift them — matching the source tool exactly.
 */
const PALETTE: Array<{ bg: string; border: string; icon: string }> = [
  { bg: '#ede9fe', border: '#c4b5fd', icon: '#7c3aed' },
  { bg: '#fef3e2', border: '#fcd9a8', icon: '#c2660a' },
  { bg: '#dcfce7', border: '#a7e3bc', icon: '#15803d' },
  { bg: '#fce7f3', border: '#f5b8db', icon: '#be185d' },
  { bg: '#dbeafe', border: '#a8c8f5', icon: '#1d4ed8' },
  { bg: '#fef9c3', border: '#fde68a', icon: '#a16207' },
  { bg: '#fee2e2', border: '#fca5a5', icon: '#b91c1c' },
  { bg: '#e0f2fe', border: '#a5d8f0', icon: '#0369a1' },
];

export function typeColorOf(index: number) {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Declared attribute type -> badge color, matching Ocelot's TypeBadge. */
const ATTR_TYPE_COLORS: Record<string, string> = {
  string: '#2563eb',
  integer: '#15803d',
  float: '#7c3aed',
  boolean: '#b45309',
  time: '#0f766e',
};
const ATTR_TYPE_FALLBACK = '#8a7a63';

export function attrTypeColor(type: string): string {
  return ATTR_TYPE_COLORS[type] ?? ATTR_TYPE_FALLBACK;
}

/** Event-type nodes are always this one neutral tan/brown, never palette-indexed. */
export const EVENT_TYPE_COLOR = { bg: '#f3ede4', border: '#e3d5c0', icon: '#8b5e3c' };
