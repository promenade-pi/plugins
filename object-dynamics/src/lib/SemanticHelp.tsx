import { useEffect, useRef, useState } from 'react';

/**
 * A concise, always-available explanation of exactly what a view measures.
 * Several Object Dynamics analyses can look plausible while aggregating
 * subtly different things (an event count is not an object count; a
 * multiplicity is not a repetition) — every view carries one of these so the
 * semantics are never left to be inferred from the chart alone.
 */
export function SemanticHelp({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="od-help-btn" onClick={() => setOpen((v) => !v)} title="What does this view measure?">?</button>
      {open && <div className="od-help-pop">{children}</div>}
    </div>
  );
}
