import { useEffect, useRef, useState } from 'react';
import type { ViewParams } from './types';

/**
 * The Fuzzy Miner's slider rail, as a side panel on the right of the view
 * rather than a card floating over the diagram.
 *
 * These controls are not an overlay on the picture — they are half of what the
 * panel *is*, and the diagram is a reading of whatever they currently say. A
 * floating card says the opposite: that the diagram is the thing and the
 * controls are a temporary intrusion sitting on top of it, hiding whatever is
 * underneath. Giving the rail its own column means nothing is ever covered,
 * the canvas knows its real width, and collapsing is a deliberate "I am done
 * adjusting" rather than a way to get the diagram back.
 *
 * Standing the sliders up and grouping them by which filter they belong to is
 * likewise not decoration: the reader sees that "resolve concurrency" happens
 * before "thin the edges" happens before "fold the quiet activities away", and
 * each group's sliders sit under its own heading.
 */

/** Wide enough for two vertical sliders side by side, and no wider. */
export const RAIL_WIDTH = 210;
/** Collapsed: just the spine, with the title turned on its side. */
export const RAIL_COLLAPSED_WIDTH = 30;

interface Props {
  theme: Record<string, string>;
  params: ViewParams;
  onChange: (patch: Partial<ViewParams>) => void;
  summary: { activities: number; clusters: number; relations: number; removed: number };
  stats: { hasResources: boolean; hasTimestamps: boolean; truncated: boolean };
  open: boolean;
  onToggle: () => void;
}

function VSlider({
  theme, label, hint, value, onChange, min = 0, max = 1, step = 0.01, disabled = false,
}: {
  theme: Record<string, string>;
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number; max?: number; step?: number; disabled?: boolean;
}) {
  // Local echo so the thumb tracks the pointer exactly; the filter chain and
  // the layout are re-run on a short debounce so a drag across the whole
  // track doesn't queue one ELK pass per pixel.
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (v: number) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 90);
  };

  return (
    <div
      title={hint}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        opacity: disabled ? 0.4 : 1, minWidth: 46,
      }}
    >
      <input
        type="range"
        min={min} max={max} step={step} value={local}
        disabled={disabled}
        onChange={(e) => commit(Number(e.target.value))}
        aria-label={label}
        style={{
          // `vertical-lr` + `rtl` is the standard way to stand a range input
          // up with its maximum at the top.
          writingMode: 'vertical-lr', direction: 'rtl',
          width: 16, height: 108, padding: 0, margin: 0,
          accentColor: theme.accent, cursor: disabled ? 'default' : 'pointer',
        }}
      />
      <div style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: theme.text }}>
        {max <= 1 ? local.toFixed(2) : local.toFixed(0)}
      </div>
      <div style={{
        fontSize: 9, lineHeight: 1.2, textAlign: 'center', color: theme['text-dim'],
        maxWidth: 58, hyphens: 'auto',
      }}>
        {label}
      </div>
    </div>
  );
}

function Toggle({
  theme, label, hint, checked, onChange, disabled = false,
}: {
  theme: Record<string, string>;
  label: string; hint: string; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label
      title={hint}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, fontSize: 10,
        color: theme.text, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
      }}
    >
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, accentColor: theme.accent, cursor: disabled ? 'default' : 'pointer' }}
      />
      <span>{label}</span>
    </label>
  );
}

function Section({
  theme, title, first = false, children,
}: {
  theme: Record<string, string>; title?: string; first?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{
      // The header already draws the top edge, so the first group must not
      // draw a second line 10px under it.
      borderTop: first ? 'none' : `1px solid ${theme.border}`,
      paddingTop: first ? 10 : 9,
      marginTop: first ? 0 : 9,
      display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      {title && (
        <div style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
          color: theme['text-dim'],
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function chevron(theme: Record<string, string>): React.CSSProperties {
  return {
    appearance: 'none', border: 'none', background: 'transparent',
    color: theme['text-dim'], cursor: 'pointer', padding: 0,
    fontSize: 13, lineHeight: 1, width: 16, height: 16,
  };
}

export function SliderRail({ theme, params, onChange, summary, stats, open, onToggle }: Props) {
  const shell: React.CSSProperties = {
    flex: '0 0 auto',
    width: open ? RAIL_WIDTH : RAIL_COLLAPSED_WIDTH,
    height: '100%',
    boxSizing: 'border-box',
    background: theme['bg-soft'],
    // The rail sits on the right, so its border is the edge facing the canvas.
    borderLeft: `1px solid ${theme.border}`,
    color: theme.text,
    fontSize: 11,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  if (!open) {
    return (
      <aside style={shell}>
        <button
          type="button"
          onClick={onToggle}
          title="Show the simplification controls"
          aria-label="Show the simplification controls"
          aria-expanded={false}
          style={{
            appearance: 'none', border: 'none', background: 'transparent', cursor: 'pointer',
            width: '100%', height: '100%', padding: '10px 0',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            color: theme['text-dim'], font: 'inherit',
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>‹</span>
          <span style={{
            writingMode: 'vertical-rl', fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            Simplification
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside style={shell}>
      <header style={{
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '9px 10px', borderBottom: `1px solid ${theme.border}`,
      }}>
        <span style={{ fontWeight: 600 }}>Simplification</span>
        <button
          type="button"
          onClick={onToggle}
          title="Collapse the simplification controls"
          aria-label="Collapse the simplification controls"
          aria-expanded
          style={chevron(theme)}
        >
          ›
        </button>
      </header>

      {/* Only this part scrolls: the header stays put, the way a side panel's
          does, so the collapse control never scrolls out of reach. */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '0 10px 12px' }}>
        <Section theme={theme} title="Nodes" first>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'space-around' }}>
            <VSlider
              theme={theme} label="Significance cutoff" value={params.nodeCutoff}
              hint="Activities below this significance are folded into clusters, or dropped where clustering cannot place them."
              onChange={(v) => onChange({ nodeCutoff: v })}
            />
            <div style={{ flex: 1, fontSize: 9.5, color: theme['text-dim'], lineHeight: 1.5, alignSelf: 'center' }}>
              <div><b style={{ color: theme.text }}>{summary.activities}</b> activities</div>
              <div><b style={{ color: theme.text }}>{summary.clusters}</b> clusters</div>
              <div><b style={{ color: theme.text }}>{summary.relations}</b> relations</div>
              {summary.removed > 0 && <div>{summary.removed} removed</div>}
            </div>
          </div>
        </Section>

        <Section theme={theme} title="Edges">
          <div style={{ display: 'flex', gap: 6, justifyContent: 'space-around' }}>
            <VSlider
              theme={theme} label="Utility ratio" value={params.utilityRatio}
              hint="How the edge filter ranks a relation: 1 purely by significance, 0 purely by correlation."
              disabled={params.edgeTransform === 'best'}
              onChange={(v) => onChange({ utilityRatio: v })}
            />
            <VSlider
              theme={theme} label="Edge cutoff" value={params.edgeCutoff}
              hint="How far below an activity's strongest relation a relation may fall and still be drawn. 0 keeps only the best, 1 keeps everything."
              disabled={params.edgeTransform === 'best'}
              onChange={(v) => onChange({ edgeCutoff: v })}
            />
          </div>
          <select
            value={params.edgeTransform}
            onChange={(e) => onChange({ edgeTransform: e.target.value as ViewParams['edgeTransform'] })}
            style={selectStyle(theme)}
          >
            <option value="fuzzy">Fuzzy edges</option>
            <option value="best">Best edges</option>
          </select>
          <Toggle
            theme={theme} label="Ignore self-loops" checked={params.ignoreSelfLoops}
            hint="Leave self-loops out of the ranking, so a dominant self-loop cannot suppress an activity's real relations."
            onChange={(v) => onChange({ ignoreSelfLoops: v })}
          />
          <Toggle
            theme={theme} label="Interpret absolute" checked={params.interpretAbsolute}
            hint="Rank an activity's incoming and outgoing relations against one shared range instead of two separate ones."
            disabled={params.edgeTransform === 'best'}
            onChange={(v) => onChange({ interpretAbsolute: v })}
          />
        </Section>

        <Section theme={theme} title="Concurrency">
          <div style={{ display: 'flex', gap: 6, justifyContent: 'space-around' }}>
            <VSlider
              theme={theme} label="Preserve threshold" value={params.concurrencyPreserve}
              hint="A two-way relation whose halves are both this important to their endpoints is left alone as real concurrency."
              disabled={!params.filterConcurrency}
              onChange={(v) => onChange({ concurrencyPreserve: v })}
            />
            <VSlider
              theme={theme} label="Ratio threshold" value={params.concurrencyRatio}
              hint="How lopsided the two halves must be before the weaker one is removed on its own. Above this, both go."
              disabled={!params.filterConcurrency}
              onChange={(v) => onChange({ concurrencyRatio: v })}
            />
          </div>
          <Toggle
            theme={theme} label="Resolve conflicts" checked={params.filterConcurrency}
            hint="Where A and B relate in both directions, decide whether that is genuine concurrency or an artefact, and drop the artefact."
            onChange={(v) => onChange({ filterConcurrency: v })}
          />
        </Section>

        <Section theme={theme} title="Display">
          <select
            value={params.edgeLabel}
            onChange={(e) => onChange({ edgeLabel: e.target.value as ViewParams['edgeLabel'] })}
            style={selectStyle(theme)}
          >
            <option value="none">No edge labels</option>
            <option value="significance">Significance</option>
            <option value="both">Significance + correlation</option>
          </select>
          <Toggle
            theme={theme} label="Hide disconnected" checked={params.dropDisconnected}
            hint="Leave out an activity that survived every filter but ended up with no relations at all."
            onChange={(v) => onChange({ dropDisconnected: v })}
          />
        </Section>

        {(!stats.hasResources || !stats.hasTimestamps || stats.truncated) && (
          <Section theme={theme}>
            <div style={{ fontSize: 9.5, color: theme['text-dim'], lineHeight: 1.45 }}>
              {!stats.hasTimestamps && <div>No timestamps in this log — proximity correlation contributed nothing.</div>}
              {!stats.hasResources && <div>No org:resource in this log — originator correlation contributed nothing.</div>}
              {stats.truncated && <div>The activity limit cut this log short; raise it and re-run for the full picture.</div>}
            </div>
          </Section>
        )}
      </div>
    </aside>
  );
}

function selectStyle(theme: Record<string, string>): React.CSSProperties {
  return {
    width: '100%', fontSize: 10, padding: '3px 4px', borderRadius: 4,
    border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text, cursor: 'pointer',
  };
}
