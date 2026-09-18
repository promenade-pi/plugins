interface SelectionItem {
  kind: 'event' | 'object' | 'activity' | 'objectType' | 'trace' | 'edge' | 'place' | 'transition';
  id: string;
}

interface PromenadeApi {
  color(domain: string, value: string): string;
  select(items: SelectionItem[]): void;
  artifact(): { id: string; name: string; type: string; tables: Record<string, string>; value: unknown };
  theme(): Record<string, string>;
  on(event: 'selection', fn: (selection: { items: SelectionItem[] }) => void): void;
  on(event: 'theme', fn: (payload: { theme: Record<string, string> }) => void): void;
  on(event: 'resize', fn: () => void): void;
  ready(): void;
}

declare const promenade: PromenadeApi;

