import { useEffect, useState } from 'react';

/**
 * Host events, latched at module scope.
 *
 * The host sends a panel's initial state — `resize`, `theme`, `params` — the
 * moment `ready()` is called, and `ready()` runs on the line after
 * `render()`. A React effect does not: it runs after the browser has painted,
 * which is comfortably after those messages have already arrived and been
 * dropped on the floor for want of a handler.
 *
 * That is a whole class of bug rather than one bug, and it bit twice here: a
 * reloaded run came back to the intro screen with the participant's answers
 * still on disk, and the editor never learned how wide it was and stayed in
 * two columns inside a 190px pane. Both looked like logic errors and neither
 * was.
 *
 * So subscription happens once, at import time, before the component tree
 * exists; the latest value is kept; and hooks read the latch. No arrival order
 * can lose anything.
 */

function latch<T>(event: 'params' | 'resize', initial: T) {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  (promenade.on as (e: string, fn: (v: unknown) => void) => void)(event, (value) => {
    current = (value ?? initial) as T;
    for (const listener of listeners) listener(current);
  });
  return {
    get: () => current,
    subscribe(fn: (value: T) => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

const params = latch<Record<string, unknown>>('params', {});
const size = latch<{ w: number; h: number }>('resize', { w: 0, h: 0 });

function useLatch<T>(source: { get: () => T; subscribe: (fn: (v: T) => void) => () => void }): T {
  const [value, setValue] = useState(source.get);
  useEffect(() => {
    // Re-read on mount as well: a message that landed between import and here
    // is already latched and would otherwise still be missed.
    setValue(source.get());
    return source.subscribe(setValue);
  }, [source]);
  return value;
}

/** The host-owned view parameters for this panel. */
export function useHostParams(): Record<string, unknown> {
  return useLatch(params);
}

/**
 * The panel's size. `w` is 0 until the host has measured it — treat that as
 * "not known yet" rather than "zero wide", or a panel flashes its narrow
 * layout on every open.
 */
export function useHostSize(): { w: number; h: number } {
  return useLatch(size);
}
