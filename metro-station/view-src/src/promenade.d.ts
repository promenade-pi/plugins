/**
 * The host-injected sandboxed-view API — see `app/src/ui/plugin-frame.html`'s
 * `promenade` object for the real implementation this mirrors. Declared here
 * only so this package type-checks standalone; it is never imported or
 * bundled.
 */
export interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
  parts?: Record<string, string>;
}

export interface SqlResult {
  numRows: number;
  columns: Record<string, ArrayLike<unknown>>;
}

export interface ArtifactHandle {
  id: string;
  name: string;
  type: string;
  tables: Record<string, string>;
  value: unknown;
  semantics?: unknown;
}

export interface PromenadeApi {
  sql(text: string): Promise<SqlResult>;
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  setParams(patch: Record<string, unknown>): void;
  artifact(): ArtifactHandle;
  theme(): Record<string, string>;
  cachedState(): Promise<unknown>;
  setCachedState(value: unknown): void;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
