import { useEffect, useState } from 'react';

const TOKENS = ['bg', 'bg-soft', 'bg-sunken', 'border', 'text', 'text-dim', 'accent', 'accent-soft', 'danger', 'warn', 'ok'];

/** Mirrors the host theme onto this document's own CSS custom properties —
 * copied from `ocelot/src/lib/theme.ts` verbatim. */
export function useHostTheme(): Record<string, string> {
  const [theme, setTheme] = useState<Record<string, string>>(() => promenade.theme());

  useEffect(() => {
    apply(theme);
    promenade.on('theme', (p) => { setTheme(p.theme); apply(p.theme); });
  }, []);

  return theme;
}

function apply(theme: Record<string, string>) {
  for (const t of TOKENS) {
    const v = theme[t];
    if (v) document.documentElement.style.setProperty(`--${t}`, v);
  }
}
