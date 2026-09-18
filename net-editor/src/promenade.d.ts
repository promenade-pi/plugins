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
  artifact(): { id: string; name: string; type: string; tables: Record<string, string>; value: unknown };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  /** Panel-scoped state the host hands back when the view reopens. */
  cachedState(): Promise<unknown>;
  setCachedState(value: unknown): void;
  /**
   * Writes an artifact of a type this view declares in `publishes`. The two
   * core net types are validated by the host itself — see
   * `HOST_VALIDATED_TYPES` in `host/artifact/publish-artifact.ts`.
   */
  publishArtifact(request: {
    type: string; name: string; value: unknown;
    inputs?: string[]; meta?: Record<string, unknown>;
  }): Promise<{ id: string; name: string; type: string }>;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
