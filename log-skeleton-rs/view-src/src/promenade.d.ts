/**
 * The host-injected sandboxed-view API — see
 * `app/src/ui/plugin-frame.html`'s `promenade` object for the real
 * implementation this mirrors. Declared here only so this package
 * type-checks standalone; it is never imported or bundled.
 */
export interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
}

export interface PromenadeApi {
  sql(text: string): Promise<{ numRows: number; columns: Record<string, unknown> }>;
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  /** Writes back into the host's own param state for this panel — how a
   * view that owns its controls (`views[].ownsControls`) persists a slider. */
  setParams(patch: Record<string, unknown>): void;
  artifact(): { id: string; name: string; type: string; tables: Record<string, string>; value: unknown };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
