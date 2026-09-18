import { useEffect, useState } from 'react';

const TOKENS = ['bg', 'bg-soft', 'bg-sunken', 'border', 'text', 'text-dim', 'accent', 'accent-soft', 'danger', 'warn', 'ok'];

/** Mirrors the host theme onto this document's own CSS custom properties, so
 * plain `var(--bg)` etc. works in every stylesheet here exactly as it does
 * in the host app — same tokens the host reads via `getComputedStyle` in
 * `PluginPanel.tsx`. Re-applies whenever `promenade.on('theme', ...)` fires
 * (a light/dark toggle). */
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
