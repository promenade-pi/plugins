/**
 * The host-injected sandboxed-view API — see
 * `app/src/ui/plugin-frame.html`'s `promenade` object for the real
 * implementation this mirrors. Declared here only so this package
 * type-checks standalone; it is never imported or bundled.
 */
export interface SqlResult {
  numRows: number;
  columns: Record<string, ArrayLike<unknown>>;
}

/** One entry in the bound artifact's own OPFS directory. */
export interface ArtifactFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  /** Set only where the file *is* one of the artifact's declared relations. */
  logical?: string;
}

export interface ParquetFile {
  kind: 'parquet';
  path: string;
  size: number;
  /** A DuckDB relation over the file itself — page it with `sql()`. */
  relation: string;
  rows: number;
  columns: Array<{ name: string; type: string }>;
  rowGroups: number | null;
  createdBy: string | null;
  compression: string | null;
}

export interface BytesFile {
  kind: 'bytes';
  path: string;
  size: number;
  bytes: Uint8Array;
  truncated: boolean;
}

export interface PromenadeApi {
  sql(text: string): Promise<SqlResult>;
  files(): Promise<{ entries: ArtifactFileEntry[] }>;
  openFile(path: string, maxBytes?: number): Promise<ParquetFile | BytesFile>;
  artifact(): { id: string; name: string; type: string; tables: Record<string, string> };
  theme(): Record<string, string>;
  cachedState(): Promise<unknown>;
  setCachedState(value: unknown): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string> }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
