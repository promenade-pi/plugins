/**
 * Station labels and callouts, as DOM projected over the canvas.
 *
 * DOM rather than 3D text for two reasons. The frame's CSP is
 * `default-src 'none'`, so there is no font file to load and a 3D text label
 * would have to be drawn from geometry; and a label that scales and skews with
 * the terrain is exactly what makes an oblique 3D chart unreadable. These pills
 * stay upright, stay the same size at every camera distance, and are ordinary
 * selectable text.
 *
 * Placement runs inside the render loop (see `Projector` in `Scene.tsx`) and
 * writes `style.transform` on nodes React already created. Nothing here calls
 * `setState` per frame: sixty reconciler passes a second to move some text is
 * how a smooth scene becomes a stuttering one.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';

import type { ProjectionSink } from './Scene';

export type LabelKind =
  | 'station'
  | 'summit'
  | 'callout-queue'
  | 'callout-rework'
  /** The elevation axis' numbers and its caption: plain text, no pill. */
  | 'tick'
  | 'caption';

export interface LabelItem {
  id: string;
  text: string;
  /** Second line, e.g. the metric value under an activity name. */
  detail?: string;
  kind: LabelKind;
  /** Higher wins a collision. */
  priority: number;
  /**
   * Screen-space offsets from the projected anchor, in CSS pixels, best first.
   *
   * A list rather than one position: on a dense map the first choice is often
   * already taken, and a callout that simply vanishes is worse than the same
   * callout on the other side of its peak. Each candidate is tried in turn and
   * the first that does not collide wins.
   */
  offsets: Array<[number, number]>;
  /** Draw a leader line from the anchor to the pill. */
  leader?: boolean;
  activity?: string;
}

export interface LabelHandle {
  place: ProjectionSink;
}

interface Placed {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: Placed, b: Placed): boolean {
  return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
}

/** A screen rectangle labels must not be placed over. */
export interface Obstacle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const Labels = forwardRef<LabelHandle, {
  items: LabelItem[];
  onPick: (activity: string) => void;
  onHover: (activity: string | null) => void;
}>(function Labels({ items, onPick, onHover }, ref) {
  /**
   * The view's own chrome, measured rather than declared.
   *
   * The toolbar, inspector and legend are laid out by CSS at sizes that depend
   * on content and viewport, so hard-coding their boxes here would go stale
   * the first time a panel grew a row. Reading them back is exact, and it
   * costs three `getBoundingClientRect` calls a quarter-second - the results
   * are cached because the placement pass itself runs every frame.
   */
  const chrome = useRef<{ at: number; boxes: Obstacle[] }>({ at: 0, boxes: [] });
  const obstaclesNow = (): Obstacle[] => {
    const now = performance.now();
    if (now - chrome.current.at < 250) return chrome.current.boxes;
    const boxes: Obstacle[] = [];
    for (const selector of ['.ft-toolbar', '.ft-panel', '.ft-legend']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({ left: rect.left - 4, top: rect.top - 4, right: rect.right + 4, bottom: rect.bottom + 4 });
    }
    chrome.current = { at: now, boxes };
    return boxes;
  };

  const nodes = useRef(new Map<string, HTMLDivElement>());
  const leaders = useRef(new Map<string, SVGPathElement>());
  const ordered = useMemo(() => [...items].sort((a, b) => b.priority - a.priority), [items]);

  /**
   * The offset each label last settled on, kept across frames.
   *
   * OrbitControls' damping never quite comes to a dead stop - its residual
   * velocity decays toward zero but a `useFrame` loop keeps calling
   * `controls.update()` regardless, so the projected anchors drift by
   * sub-pixel amounts essentially forever, even with the mouse doing nothing.
   * A label sitting exactly on a collision boundary can flip its winning
   * candidate from one such frame to the next, and because every label after
   * it in priority order is placed against whatever the earlier ones just
   * claimed, one flip cascades into the whole shared layout visibly
   * reshuffling - which reads as every label jittering at once, not just the
   * one near the boundary. Preferring each label's own last position, and
   * only abandoning it once it genuinely stops fitting, removes the
   * degenerate case a fresh from-scratch scan can flip on every frame.
   */
  const lastOffset = useRef(new Map<string, [number, number]>());

  useImperativeHandle(ref, () => ({
    place(projected, size) {
      const byId = new Map(projected.map((p) => [p.id, p]));
      const placed: Placed[] = obstaclesNow().map((box) => ({ ...box }));

      for (const item of ordered) {
        const node = nodes.current.get(item.id);
        const leader = leaders.current.get(item.id);
        if (!node) continue;
        const point = byId.get(item.id);
        // `depth` past 1 is behind the far plane, i.e. behind the camera.
        if (!point || point.depth > 1) {
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          if (leader) leader.style.opacity = '0';
          continue;
        }

        const width = node.offsetWidth;
        const height = node.offsetHeight;

        const place = (offset: [number, number]) => {
          // Keep a label that has drifted off-panel just inside it rather than
          // dropping it: the station is still on screen and still clickable.
          const x = Math.max(
            width / 2 + 4, Math.min(size.width - width / 2 - 4, point.x + offset[0])
          );
          const y = Math.max(
            height / 2 + 4, Math.min(size.height - height / 2 - 4, point.y + offset[1])
          );
          const box: Placed = {
            left: x - width / 2, right: x + width / 2,
            top: y - height / 2, bottom: y + height / 2,
          };
          return { x, y, box, offset };
        };

        let chosen: ReturnType<typeof place> | null = null;
        let fallback: ReturnType<typeof place> | null = null;

        const sticky = lastOffset.current.get(item.id);
        if (sticky) {
          const candidate = place(sticky);
          if (!placed.some((other) => overlaps(candidate.box, other))) chosen = candidate;
        }

        if (!chosen) {
          for (const offset of item.offsets) {
            const candidate = place(offset);
            fallback ??= candidate;
            if (!placed.some((other) => overlaps(candidate.box, other))) {
              chosen = candidate;
              break;
            }
          }
        }

        // A label with nowhere to go is dropped, except a callout: that is the
        // one thing on the map somebody decided was worth pointing at, so it is
        // drawn over whatever it lands on. A dropped station name comes back on
        // hover, and its ring is on the surface either way.
        if (!chosen && item.kind !== 'callout-queue' && item.kind !== 'callout-rework') {
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          if (leader) leader.style.opacity = '0';
          lastOffset.current.delete(item.id);
          continue;
        }
        const settled = chosen ?? fallback!;
        lastOffset.current.set(item.id, settled.offset);
        const { x, y } = settled;
        placed.push(settled.box);

        node.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        node.style.opacity = '1';
        node.style.pointerEvents = item.activity ? 'auto' : 'none';

        if (leader && item.leader) {
          // An elbow rather than a straight line: it reads as a technical
          // callout and it never runs along the pill's own edge, which a
          // diagonal at a shallow angle does.
          const rightward = settled.offset[0] > 0;
          const endX = x + (rightward ? -width / 2 - 2 : width / 2 + 2);
          const midX = (point.x + endX) / 2;
          leader.setAttribute(
            'd',
            `M ${point.x.toFixed(1)} ${point.y.toFixed(1)} L ${midX.toFixed(1)} ${point.y.toFixed(1)} ` +
            `L ${endX.toFixed(1)} ${y.toFixed(1)} L ${(endX + (rightward ? 2 : -2)).toFixed(1)} ${y.toFixed(1)}`
          );
          leader.style.opacity = '0.85';
        }
      }
    },
  }), [ordered]);

  return (
    <>
      <svg className="ft-leaders" aria-hidden>
        {ordered.filter((item) => item.leader).map((item) => (
          <path
            key={item.id}
            ref={(node) => {
              if (node) leaders.current.set(item.id, node);
              else leaders.current.delete(item.id);
            }}
            className={`ft-leader ft-leader-${item.kind}`}
          />
        ))}
      </svg>
      <div className="ft-labels">
        {ordered.map((item) => (
          <div
            key={item.id}
            ref={(node) => {
              if (node) nodes.current.set(item.id, node);
              else nodes.current.delete(item.id);
            }}
            className={`ft-label ft-label-${item.kind}`}
            data-label-id={item.id}
            style={{ opacity: 0 }}
            onClick={() => item.activity && onPick(item.activity)}
            onMouseOver={() => item.activity && onHover(item.activity)}
            onMouseOut={() => item.activity && onHover(null)}
            role={item.activity ? 'button' : undefined}
            tabIndex={item.activity ? 0 : undefined}
            onKeyDown={(event) => {
              if (item.activity && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onPick(item.activity);
              }
            }}
          >
            <span className="ft-label-text">{item.text}</span>
            {item.detail && <span className="ft-label-detail">{item.detail}</span>}
          </div>
        ))}
      </div>
    </>
  );
});
