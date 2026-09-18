declare const promenade: {
  artifact(): { value: unknown };
  theme(): Record<string, string>;
  color(kind: string, key: string): string;
  on(name: string, callback: (event: any) => void): void;
  ready(): void;
  select(items: Array<{ kind: string; id: string }>): void;
};
