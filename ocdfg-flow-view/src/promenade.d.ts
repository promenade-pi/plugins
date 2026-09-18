export interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
}

export interface PromenadeApi {
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  artifact(): { id: string; name: string; type: string; tables: Record<string, string>; value: unknown };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (sel: { items: SelectionItem[]; source?: string }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string>; colors: unknown }) => void): void;
  on(event: 'resize', fn: (size: { w: number; h: number }) => void): void;
  on(event: 'params', fn: (params: Record<string, unknown>) => void): void;
  ready(): void;
}

declare global { const promenade: PromenadeApi; }
