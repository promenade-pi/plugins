/**
 * Platform names, shaft durations and the depth axis, as DOM projected over
 * the canvas.
 *
 * DOM rather than 3D text for two reasons. The frame's CSP is
 * `default-src 'none'`, so there is no font file to load and a 3D label would
 * have to be drawn from geometry; and a label that scales and skews with the
 * diagram is exactly what makes an oblique 3D drawing unreadable. These stay
 * upright, stay the same size at every camera distance, and are ordinary
 * selectable text.
 *
 * Placement runs inside the render loop (see `Projector` in `Scene.tsx`) and
 * writes `style.transform` on nodes React already created. Nothing here calls
 * `setState` per frame: sixty reconciler passes a second to move some text is
 * how a smooth scene becomes a stuttering one.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';

import type { ProjectionSink } from './Scene';

export type LabelKind = 'platform' | 'shaft' | 'tick' | 'band' | 'caption';

export interface LabelItem {
  id: string;
  text: string;
  detail?: string;
  kind: LabelKind;
  /** Higher wins a collision. */
  priority: number;
  /** Screen-space offsets from the anchor, in CSS pixels, best first. */
  offsets: Array<[number, number]>;
  /** Swatch colour, for a shaft chip that belongs to one route. */
  color?: string;
  /** What clicking it selects. */
  platform?: string;
  objectType?: string;
}

export interface LabelHandle {
  place: ProjectionSink;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
}

export const Labels = forwardRef<
  LabelHandle,
  {
    items: LabelItem[];
    onPick: (platform: string) => void;
    onHover: (platform: string | null) => void;
  }
>(function Labels({ items, onPick, onHover }, ref) {
  const nodes = useRef(new Map<string, HTMLDivElement>());

  /**
   * The view's own chrome, measured rather than declared.
   *
   * The toolbar, legend and inspector are laid out by CSS at sizes that depend
   * on content and viewport, so hard-coding their boxes here would go stale
   * the first time one grew a row. Reading them back is exact, and it costs
   * three `getBoundingClientRect` calls a quarter-second — the results are
   * cached because the placement pass itself runs every frame.
   */
  const chrome = useRef<{ at: number; boxes: Box[] }>({ at: 0, boxes: [] });
  const obstaclesNow = (): Box[] => {
    const now = performance.now();
    if (now - chrome.current.at > 250) {
      chrome.current = {
        at: now,
        boxes: Array.from(document.querySelectorAll('[data-ms-chrome]')).map((element) => {
          const rect = (element as HTMLElement).getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }),
      };
    }
    return chrome.current.boxes;
  };

  const ordered = useMemo(() => [...items].sort((a, b) => b.priority - a.priority), [items]);

  useImperativeHandle(ref, () => ({
    place(projected, size) {
      const at = new Map(projected.map((p) => [p.id, p]));
      const taken: Box[] = obstaclesNow().slice();
      for (const item of ordered) {
        const node = nodes.current.get(item.id);
        if (!node) continue;
        const point = at.get(item.id);
        if (!point || !point.visible) {
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          continue;
        }
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        let placed: Box | null = null;
        let chosen: [number, number] = item.offsets[0] ?? [0, 0];
        for (const offset of item.offsets) {
          const left = point.x + offset[0] - width / 2;
          const top = point.y + offset[1] - height / 2;
          const box = { left, top, right: left + width, bottom: top + height };
          if (
            box.left < 2 || box.top < 2 ||
            box.right > size.width - 2 || box.bottom > size.height - 2
          ) {
            continue;
          }
          if (taken.some((other) => overlaps(box, other))) continue;
          placed = box;
          chosen = offset;
          break;
        }
        if (!placed) {
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          continue;
        }
        taken.push(placed);
        node.style.opacity = '1';
        node.style.pointerEvents = item.platform ? 'auto' : 'none';
        node.style.transform = `translate3d(${Math.round(point.x + chosen[0])}px, ${Math.round(
          point.y + chosen[1]
        )}px, 0) translate(-50%, -50%)`;
      }
    },
  }));

  return (
    <div className="ms-labels">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(node) => {
            if (node) nodes.current.set(item.id, node);
            else nodes.current.delete(item.id);
          }}
          className={`ms-label is-${item.kind}`}
          style={item.color ? ({ ['--ms-swatch' as string]: item.color }) : undefined}
          onClick={() => item.platform && onPick(item.platform)}
          onPointerEnter={() => item.platform && onHover(item.platform)}
          onPointerLeave={() => item.platform && onHover(null)}
        >
          {item.kind === 'shaft' && <span className="ms-lift" aria-hidden="true" />}
          <span className="ms-label-text">{item.text}</span>
          {item.detail && <span className="ms-label-detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  );
});
