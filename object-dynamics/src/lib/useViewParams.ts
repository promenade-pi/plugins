import { useEffect, useRef, useState } from 'react';

/**
 * Controlled view state, round-tripped through the host's own params object
 * (see `ViewDef.ownsControls` in `host/views/registry.ts`) — this is the
 * mechanism every Object Dynamics view uses instead of local-only React
 * state, so that:
 *
 * - the panel's current selections persist into a SavedView exactly like a
 *   host-rendered control's values would;
 * - reopening a saved Object Dynamics view restores the same activity,
 *   object type, attributes, mode, etc. it was showing;
 * - nothing here is a new state framework — `promenade.setParams` /
 *   `on('params')` already exists for every sandboxed view.
 *
 * Updates apply optimistically (so a click or keystroke never waits on a
 * round trip) and are also pushed to the host, which echoes the merged
 * object back — the echo is applied too, so an external change (e.g. a
 * SavedView reopened with different stored params) still wins.
 */
export function useViewParams<T extends object>(defaults: T): [T, (patch: Partial<T>) => void] {
  const [params, setLocalParams] = useState<T>(defaults);
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    promenade.on('params', (p) => {
      setLocalParams((prev) => ({ ...defaultsRef.current, ...prev, ...(p as Partial<T>) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setParams = (patch: Partial<T>) => {
    setLocalParams((prev) => ({ ...prev, ...patch }));
    promenade.setParams(patch as Record<string, unknown>);
  };

  return [params, setParams];
}
