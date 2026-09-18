/**
 * The host-injected sandboxed-view API — mirrors `app/src/ui/plugin-frame.html`'s
 * `promenade` object. Declared here only so this package type-checks standalone;
 * never imported or bundled.
 */
export interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
}

/** `running` while the producing action is still executing; absent once the
 * panel is bound to a finished artifact. */
export type RunState = 'running' | 'done' | 'error';

/** One structured progress batch from a live action run. */
export interface LiveFramePayload {
  kind: string;
  upTo?: number;
  total?: number;
  frames: unknown[];
}

export interface PromenadeApi {
  sql(text: string): Promise<{ numRows: number; columns: Record<string, unknown> }>;
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  artifact(): {
    id: string; name: string; type: string;
    tables: Record<string, string>; value: unknown;
    runState?: RunState;
  };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  /** A batch of structured frames from the still-running producing action. */
  on(event: 'liveFrame', fn: (payload: LiveFramePayload) => void): void;
  /** The producing action finished (or failed / was superseded). */
  on(event: 'liveRunState', fn: (payload: { state: RunState; message?: string }) => void): void;
  setCachedState(value: unknown): void;
  cachedState(): Promise<unknown>;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
