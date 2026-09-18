/**
 * The host-injected sandboxed-view API — see
 * `app/src/ui/plugin-frame.html`'s `promenade` object for the real
 * implementation this mirrors. Declared here only so this package
 * type-checks standalone; it is never imported or bundled. Copied from
 * `plugins/ocpn-flow-view/src/promenade.d.ts` — keep in sync by hand.
 */
export interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
}

export interface PromenadeApi {
  sql(text: string): Promise<{ numRows: number; columns: Record<string, unknown> }>;
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  artifact(): {
    id: string; name: string; type: string; tables: Record<string, string>; value: unknown;
    /** Only on a run-bound live preview (manifest `livePreview: true`): the
     * panel was opened for an action that has not finished, so `value` is
     * the run's seed, not this artifact type's payload. */
    runState?: 'running' | 'done' | 'error';
  };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  /** Live-preview progress: `fraction` is null when genuinely indefinite. */
  on(event: 'liveRunState', fn: (s: { state: 'running' | 'done' | 'error'; message: string; fraction: number | null }) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
