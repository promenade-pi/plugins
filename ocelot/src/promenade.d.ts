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

export interface DeclaredType {
  name: string;
  attributes: Array<{ name: string; type: 'string' | 'integer' | 'float' | 'boolean' | 'time' }>;
}

export interface OCEL2Semantics {
  objectTypes: DeclaredType[];
  eventTypes: DeclaredType[];
  sourceFormat: 'json' | 'sqlite' | 'xml';
}

export interface ArtifactInfo {
  id: string;
  name: string;
  type: string;
  tables: Record<string, string>;
  value: unknown;
  semantics: OCEL2Semantics | null;
}

export interface SqlResult {
  numRows: number;
  columns: Record<string, unknown[]>;
}

export interface PromenadeApi {
  sql(text: string): Promise<SqlResult>;
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  artifact(): ArtifactInfo;
  theme(): Record<string, string>;
  /** Opens another artifact's view, or focuses it if already open. */
  openView(artifactId: string, viewId?: string, params?: Record<string, unknown>): Promise<void>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
