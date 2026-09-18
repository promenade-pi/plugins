import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { OrgModelPayload } from './types';

/**
 * A run leaves an envelope in the result store; a reload leaves the bare
 * payload. Normalising both here is what keeps the view working after the
 * page is refreshed — see the host's own `payloadOf`.
 */
export function payloadOf(value: unknown): OrgModelPayload | null {
  let v: any = value;
  for (let depth = 0; depth < 4 && v && typeof v === 'object' && 'result' in v; depth++) v = v.result;
  if (v && typeof v === 'object' && !Array.isArray(v.roles) && v.value) v = v.value;
  return v && Array.isArray(v?.roles) ? (v as OrgModelPayload) : null;
}

export function useTheme(): Record<string, string> {
  const [theme, setTheme] = useState<Record<string, string>>(() => {
    try { return promenade.theme(); } catch { return {}; }
  });
  useEffect(() => {
    try { promenade.on('theme', (p) => setTheme(p.theme)); } catch { /* host not listening */ }
  }, []);
  return theme;
}

/**
 * The panel's own size.
 *
 * A layout needs real pixels, and the frame's first paint can happen before
 * the host has sized it — so this starts from whatever the document says and
 * then follows the host's resize events, which is the only signal that
 * arrives reliably in a hidden or freshly-opened panel.
 */
export function useSize(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({
    w: Math.max(320, document.documentElement.clientWidth || 800),
    h: Math.max(240, document.documentElement.clientHeight || 600),
  }));
  useEffect(() => {
    const apply = (s: { w: number; h: number }) =>
      setSize({ w: Math.max(320, s.w), h: Math.max(240, s.h) });
    try { promenade.on('resize', apply); } catch { /* host not listening */ }
    const onWindow = () => apply({
      w: document.documentElement.clientWidth, h: document.documentElement.clientHeight,
    });
    window.addEventListener('resize', onWindow);
    return () => window.removeEventListener('resize', onWindow);
  }, []);
  return size;
}

/**
 * The host's params for this panel.
 *
 * Seeded from `promenade.artifact()`-time state and then updated by the
 * host's `params` event. Registering the listener outside an effect matters:
 * the host sends the first params message before React's effects run, and a
 * listener attached in an effect misses it.
 */
const initialParams: Record<string, unknown> = {};
let paramListeners: Array<(p: Record<string, unknown>) => void> = [];
try {
  promenade.on('params', (p) => {
    Object.assign(initialParams, p);
    for (const fn of paramListeners) fn({ ...initialParams });
  });
} catch { /* host not listening */ }

export function useParams<T extends object>(defaults: T): T {
  const [params, setParams] = useState<Record<string, unknown>>({ ...initialParams });
  useEffect(() => {
    const fn = (p: Record<string, unknown>) => setParams(p);
    paramListeners.push(fn);
    setParams({ ...initialParams });
    return () => { paramListeners = paramListeners.filter((x) => x !== fn); };
  }, []);
  const merged = { ...defaults } as Record<string, unknown>;
  for (const [k, v] of Object.entries(params)) if (v !== undefined) merged[k] = v;
  return merged as T;
}

/** Whatever went wrong, said on the panel rather than left blank. */
export function Notice({ title, body }: { title: string; body: string }) {
  const theme = (() => { try { return promenade.theme(); } catch { return {} as Record<string, string>; } })();
  try { promenade.ready(); } catch { /* the host may not be listening yet */ }
  return (
    <div style={{
      width: '100%', height: '100%', background: theme.bg ?? '#fff', color: theme.text ?? '#1c2027',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
      font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{ maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ color: theme['text-dim'] ?? '#697386', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

/**
 * Entry point for the view this plugin ships.
 *
 * Anything thrown while starting up would otherwise leave an empty white
 * panel with no clue in it — the frame's console is not the host's, so a
 * crash inside the sandbox is genuinely invisible.
 */
export function bootView(render: (payload: OrgModelPayload) => React.ReactElement) {
  const root = createRoot(document.getElementById('root')!);
  try {
    const artifact = promenade.artifact();
    const payload = payloadOf(artifact?.value);
    root.render(
      payload
        ? render(payload)
        : <Notice title="No computed model" body={
            'This Organizational Model has no result in memory — a derived artifact '
            + 'is recomputed rather than stored, so a reloaded session has to run the '
            + 'miner again before this view can draw anything.'
          } />
    );
  } catch (err) {
    console.error('[org-model] view failed to start', err);
    root.render(<Notice title="This view failed to start" body={String((err as Error)?.message ?? err)} />);
  }
}
