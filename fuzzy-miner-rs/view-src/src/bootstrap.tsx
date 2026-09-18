import { createRoot } from 'react-dom/client';
import type { FuzzyModelPayload } from './types';

/**
 * A run leaves an envelope in the result store; a reload leaves the bare
 * payload. Normalising both here is what keeps every view working after the
 * page is refreshed.
 */
export function payloadOf(value: unknown): FuzzyModelPayload {
  const v = value as any;
  if (v && typeof v === 'object' && !Array.isArray(v.activities) && v.value) return v.value as FuzzyModelPayload;
  return v as FuzzyModelPayload;
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
      <div style={{ maxWidth: 380, textAlign: 'center' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ color: theme['text-dim'] ?? '#697386', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

/**
 * Shared entry point for every sandboxed view this plugin ships.
 *
 * Anything thrown while starting up would otherwise leave an empty white
 * panel with no clue in it — the frame's own console is not the host's, so a
 * crash inside the sandbox is genuinely invisible. Put the message on the
 * panel instead, in both failure modes: no computed model at all (a derived
 * artifact is recomputed rather than stored, so a reloaded session has
 * nothing until Fuzzy Miner runs again), and an outright exception.
 */
export function bootView(render: (payload: FuzzyModelPayload) => React.ReactElement) {
  const root = createRoot(document.getElementById('root')!);
  try {
    const artifact = promenade.artifact();
    const payload = payloadOf(artifact?.value);
    const usable = !!payload && Array.isArray(payload.activities) && payload.activities.length > 0;
    root.render(
      usable
        ? render(payload)
        : <Notice title="No computed model" body={
            'This Fuzzy Model has no result in memory — a derived artifact is ' +
            'recomputed rather than stored, so a reloaded session has to run ' +
            'Fuzzy Miner again before this view can draw anything.'
          } />
    );
  } catch (err) {
    console.error('[fuzzy-miner] view failed to start', err);
    root.render(<Notice title="This view failed to start" body={String((err as Error)?.message ?? err)} />);
  }
}
