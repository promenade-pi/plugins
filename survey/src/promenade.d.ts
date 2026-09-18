/**
 * The host-injected sandboxed-view API — see `app/src/ui/plugin-frame.html`
 * for the implementation this mirrors. Declared here only so the package
 * type-checks standalone; it is never imported or bundled.
 */
export interface SelectionItem {
  artifactId?: string;
  kind: string;
  id: string;
  parts?: Record<string, string>;
}

/** One open panel, as `promenade.workspace()` reports it. */
export interface WorkspacePanel {
  panelId: string;
  artifactId: string;
  artifactName: string;
  artifactType: string;
  viewId: string;
  viewLabel: string;
  params: Record<string, unknown>;
  active: boolean;
}

export interface PromenadeApi {
  sql(text: string): Promise<{ numRows: number; columns: Record<string, ArrayLike<unknown>> }>;
  /** The open panels and the parameters each is showing. Needs `readsWorkspace`. */
  workspace(): Promise<{ panels: WorkspacePanel[] }>;
  /** Opens (or redirects) a panel; `beside` puts it alongside this one. */
  openView(
    artifactId: string, viewId?: string | null, params?: Record<string, unknown> | null,
    opts?: { beside?: 'left' | 'right' },
  ): Promise<null>;
  /** Writes an artifact of a type this package declares. Needs `publishes`. */
  publishArtifact(request: {
    type: string; name: string; value: unknown;
    inputs?: string[]; meta?: Record<string, unknown>;
  }): Promise<{ id: string; name: string; type: string }>;
  artifact(): {
    id: string; name: string; type: string;
    tables: Record<string, string>; value: unknown;
  };
  /** Which of this package's views this frame is. */
  view(): { id: string; label: string } | null;
  theme(): Record<string, string>;
  setParams(patch: Record<string, unknown>): void;
  cachedState(): Promise<unknown>;
  setCachedState(value: unknown): void;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'workspace', fn: (payload: { panels: WorkspacePanel[] }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string> }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  ready(): void;
}

declare global {
  const promenade: PromenadeApi;
}
