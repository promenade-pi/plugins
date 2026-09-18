import { createRoot } from 'react-dom/client';
import { Component, useEffect, useState, type ReactNode } from 'react';

/**
 * A run leaves an envelope in the result store; a reload leaves the bare
 * payload. Normalising both here is what keeps a view working after the page
 * is refreshed — see the host's own `payloadOf`.
 */
export function payloadOf<T>(value: unknown, looksRight: (v: any) => boolean): T | null {
  let v: any = value;
  for (let depth = 0; depth < 4 && v && typeof v === 'object' && 'result' in v; depth++) v = v.result;
  if (v && typeof v === 'object' && !looksRight(v) && v.value) v = v.value;
  return v && typeof v === 'object' && looksRight(v) ? (v as T) : null;
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
 * The host's params for this panel.
 *
 * Registering the listener at module scope matters: the host sends the first
 * params message before React's effects run, and a listener attached inside an
 * effect misses it — see `project_promenade_survey_plugin`'s note on exactly
 * this.
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
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ color: theme['text-dim'] ?? '#697386', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

/**
 * Catches what `bootView`'s try/catch cannot.
 *
 * `root.render()` returns before React has rendered anything, so an exception
 * thrown *during* the render lands outside the try block — and React's answer
 * to an uncaught render error is to unmount the tree, leaving a blank white
 * panel. Inside a sandboxed frame that is the end of the story: the frame's
 * console is not the host's, the error reaches no log anyone is reading, and
 * the panel simply shows nothing. This turns that into a message on the panel.
 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Notice
        title="This view could not draw this artifact"
        body={`${error.message}\n\nThe artifact itself is unharmed — this is a fault in the view.`}
      />
    );
  }
}

/**
 * Shared entry point for both views this plugin ships.
 *
 * Anything thrown while starting up would otherwise leave an empty white panel
 * with no clue in it — the frame's console is not the host's, so a crash inside
 * the sandbox is genuinely invisible.
 */
export function bootView<T>(
  looksRight: (v: any) => boolean,
  render: (payload: T) => React.ReactElement,
  missing: { title: string; body: string },
) {
  const root = createRoot(document.getElementById('root')!);
  try {
    const artifact = promenade.artifact();
    const payload = payloadOf<T>(artifact?.value, looksRight);
    root.render(<Boundary>{payload ? render(payload) : <Notice {...missing} />}</Boundary>);
  } catch (e: any) {
    root.render(<Notice title="This view could not start" body={String(e?.message ?? e)} />);
  }
  try { promenade.ready(); } catch { /* the host may not be listening yet */ }
}
