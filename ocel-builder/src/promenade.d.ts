/**
 * The host-injected sandboxed-view API — see `app/src/ui/plugin-frame.html`'s
 * `promenade` object for the real implementation this mirrors. Declared here
 * only so this package type-checks standalone; it is never imported or
 * bundled.
 */
export interface PublishLogRequest {
  type: 'ObjectCentricEventLog';
  name: string;
  events: Array<Record<string, string>>;
  objects: Array<Record<string, string>>;
  e2o: Array<Record<string, string>>;
  o2o?: Array<Record<string, string>>;
  semantics?: unknown;
}

export interface PromenadeApi {
  sql(text: string): Promise<{ numRows: number; columns: Record<string, unknown> }>;
  /** Only for a manifest `standalone` view declaring `publishes`. */
  publishLog(request: PublishLogRequest): Promise<{ id: string; name: string; type: string }>;
  artifact(): {
    id: string;
    name: string;
    type: string;
    tables: Record<string, string>;
    value: unknown;
    /** `meta.semantics` — an OCEL 2.0 log's declared event and object types. */
    semantics?: {
      eventTypes?: Array<{ name: string; attributes?: Array<{ name: string; type?: string }> }>;
      objectTypes?: Array<{ name: string; attributes?: Array<{ name: string; type?: string }> }>;
    } | null;
  };
  theme(): Record<string, string>;
  cachedState(): Promise<unknown>;
  setCachedState(value: unknown): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
