import type { TemporalRelation } from './types';

export type MarkerShape = 'triangle' | 'tee' | 'circle';

/** Mirrors `totem.py`'s `tr_to_arrow`: P (parallel, the always-true fallback)
 * draws a plain arrowhead, D/I (dependent/initiating) draw a tee/circle, and
 * their inverses (Di/Ii) draw nothing — the forward reading on the *other*
 * end of the same edge already carries that information. */
export function trToShape(tr: TemporalRelation | null): MarkerShape | null {
  if (tr === 'P') return 'triangle';
  if (tr === 'D') return 'tee';
  if (tr === 'I') return 'circle';
  return null; // Ii, Di, and no relation at all
}

function safeColorId(color: string): string {
  return color.replace(/[^a-zA-Z0-9]/g, '_');
}

export function markerId(shape: MarkerShape, color: string): string {
  return `totem-marker-${shape}-${safeColorId(color)}`;
}

/** One `<marker>` def per (shape, color) pair actually used, referenced by
 * id from each edge's `markerStart`/`markerEnd` — SVG markers can't inherit
 * `stroke`/`fill` from the referencing path portably, so each distinct
 * color needs its own marker element. Rendered once, high in the tree, and
 * reused by every edge that needs that combination. */
export function MarkerDefs({ combos }: { combos: Array<{ shape: MarkerShape; color: string }> }) {
  const seen = new Set<string>();
  const unique = combos.filter((c) => {
    const key = `${c.shape}:${c.color}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {unique.map(({ shape, color }) => {
          const id = markerId(shape, color);
          if (shape === 'triangle') {
            return (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="8.5" refY="5"
                markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={color} />
              </marker>
            );
          }
          if (shape === 'tee') {
            return (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="7" refY="5"
                markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M7,0.5 L7,9.5" stroke={color} strokeWidth="1.8" />
              </marker>
            );
          }
          return (
            <marker key={id} id={id} viewBox="0 0 10 10" refX="7" refY="5"
              markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <circle cx="7" cy="5" r="2.6" fill="white" stroke={color} strokeWidth="1.4" />
            </marker>
          );
        })}
      </defs>
    </svg>
  );
}
