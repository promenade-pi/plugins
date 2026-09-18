/**
 * The two palettes, and the small amount of arithmetic that turns payload
 * numbers into drawn quantities.
 *
 * `daylight` is the scheme a published station atlas is printed in: an
 * off-white ground, white platforms with a grey rim, pale grey trackbed, and
 * colour reserved entirely for the routes. That reservation is the point —
 * depth already carries elapsed time, so if the furniture were coloured too
 * there would be nothing left for the object types to be.
 */
/**
 * Spacing between two parallel routes in one bundle, in plan units.
 *
 * Mirrors `LINE_PITCH` in the Rust kernel, which is what actually offsets the
 * centre lines; the view only needs it to know how wide it may draw them.
 */
export const LINE_PITCH = 0.075;

export interface Scheme {
  background: string;
  ink: string;
  inkSoft: string;
  platformTop: string;
  platformSide: string;
  platformRim: string;
  slabTop: string;
  slabSide: string;
  grid: string;
  gridStrong: string;
  stair: string;
  shaftGlass: string;
  shaftEdge: string;
  pin: string;
  /** The lift car's own frame, and the panel at its back. */
  carShell: string;
  carPanel: string;
  /** The arrival flash, blended additively. */
  flash: string;
  skyTop: string;
  skyBottom: string;
  shadowOpacity: number;
  glassOpacity: number;
}

export const SCHEMES: Record<'daylight' | 'night', Scheme> = {
  daylight: {
    background: '#f6f6f3',
    ink: '#16181c',
    inkSoft: '#71767f',
    platformTop: '#ffffff',
    platformSide: '#dcdcd6',
    platformRim: '#9d9d95',
    slabTop: '#ececE8',
    slabSide: '#cbcbc5',
    grid: '#cfcfc8',
    gridStrong: '#a3a39a',
    stair: '#d9d9d3',
    shaftGlass: '#ffd9a0',
    shaftEdge: '#c9a25e',
    pin: '#1c6ee0',
    carShell: '#f0a01c',
    carPanel: '#fdfaf3',
    flash: '#ffd08a',
    skyTop: '#ffffff',
    skyBottom: '#f6f6f3',
    shadowOpacity: 0.2,
    glassOpacity: 0.3,
  },
  night: {
    background: '#0d1015',
    ink: '#eaeef4',
    inkSoft: '#9aa4b2',
    platformTop: '#2a303c',
    platformSide: '#1a1f28',
    platformRim: '#4d5666',
    slabTop: '#1d232d',
    slabSide: '#12171e',
    grid: '#212832',
    gridStrong: '#3b4453',
    stair: '#2b323d',
    shaftGlass: '#ffca7a',
    shaftEdge: '#d9a55f',
    pin: '#5aa2ff',
    carShell: '#e8961a',
    carPanel: '#f3ede1',
    flash: '#ffd9a0',
    skyTop: '#1a2130',
    skyBottom: '#0d1015',
    shadowOpacity: 0.34,
    glassOpacity: 0.24,
  },
};

/** Half the drawn width of one route, in plan units. */
/**
 * Half the drawn width of one route, in plan units.
 *
 * Capped at `MAX_HALF_WIDTH`, which is a hair under half the spacing the
 * kernel reserves between two parallel routes. Past that the busiest route in
 * a bundle would be drawn wider than its own track and lap over its
 * neighbour's — an overlap the kernel's own invariants cannot see, because
 * they are checked against the centre lines the kernel emits, not against how
 * wide the view later decides to draw them.
 */
const MAX_HALF_WIDTH = (LINE_PITCH / 2) * 0.92;

export function lineHalfWidth(freq: number, busiest: number, uniform: boolean): number {
  if (uniform) return Math.min(MAX_HALF_WIDTH, 0.022);
  // A square root, not a proportion: a route ten times as busy as its
  // neighbour is not drawn ten times as wide, or the neighbour disappears.
  const share = Math.sqrt(Math.max(0, freq) / Math.max(1, busiest));
  return Math.min(MAX_HALF_WIDTH, 0.016 + 0.026 * share);
}

/** How far the trackbed sticks out past the routes riding on it. */
export const SLAB_MARGIN = 0.019;
/** Thickness of the trackbed slab. */
export const SLAB_DEPTH = 0.032;
/** How far a coloured route floats over its own trackbed. */
export const LINE_LIFT = 0.009;
/** Height of a platform disc. */
export const PLATFORM_DEPTH = 0.075;
/** A 45° corner cut, in plan units. */
export const CHAMFER = 0.085;

/**
 * How a descent is drawn, by how far it actually falls.
 *
 * Three tiers rather than two, because the alternative is a diagram in which
 * every single hand-off sprouts furniture. Below `ramp` a descent is just a
 * slope in the trackbed and reads as one continuous run; a lift shaft is
 * reserved for the drops the diagram exists to point at.
 *
 * Stairs and ramps share a path shape — the track slopes down over a run —
 * and differ only in whether that run is dressed as a flight of steps. Only a
 * shaft breaks the track into two levels with a vertical stretch between, and
 * it can afford to because it is long enough that the two levels are plainly
 * two levels.
 */
export function descentKind(drop: number, floor: number, elevators: boolean): 'ramp' | 'stairs' | 'shaft' {
  if (!elevators) return 'ramp';
  const share = Math.abs(drop) / Math.max(1e-6, Math.abs(floor));
  if (share < 0.055) return 'ramp';
  if (share < 0.19) return 'stairs';
  return 'shaft';
}
