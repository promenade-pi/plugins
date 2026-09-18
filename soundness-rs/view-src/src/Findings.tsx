import type { ReactNode } from 'react';
import { REQUIREMENTS, type Finding, type Outcome, type SoundnessReport, type Verdict } from './types';

const VERDICT_TOKEN: Record<Verdict, string> = { sound: 'ok', unsound: 'danger', inconclusive: 'warn' };
const VERDICT_LABEL: Record<Verdict, string> = { sound: 'Sound', unsound: 'Not sound', inconclusive: 'Undecided' };
const OUTCOME_TOKEN: Record<Outcome, string> = { pass: 'ok', fail: 'danger', unknown: 'text-dim' };
const OUTCOME_MARK: Record<Outcome, string> = { pass: '✓', fail: '✗', unknown: '?' };

/** The diagnosis as text, beside the net it is about. Selecting a finding is
 *  what drives the highlighting on the right, so this list is the view's
 *  navigation, not a caption. */
export function Findings({
  report,
  theme,
  selected,
  onSelect,
}: {
  report: SoundnessReport;
  theme: Record<string, string>;
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const { summary, structure, behaviour } = report;
  const token = VERDICT_TOKEN[summary.verdict];

  return (
    <div style={{
      width: 330, flex: '0 0 330px', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
      borderRight: `1px solid ${theme.border}`, background: theme['bg-soft'], color: theme.text,
      font: '12px/1.5 system-ui, sans-serif', padding: 14,
    }}>
      <div style={{
        border: `1px solid ${theme[token]}`, borderRadius: 8, padding: '10px 12px',
        background: `${theme[token]}14`, marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: theme[token] }}>
            {VERDICT_LABEL[summary.verdict]}
          </span>
          <span style={{ fontSize: 11, color: theme['text-dim'] }}>
            {summary.isWorkflowNet ? 'workflow net' : 'not a workflow net'}
          </span>
        </div>
        <div style={{ fontSize: 12 }}>{summary.headline}</div>
      </div>

      <Section title="Requirements" theme={theme}>
        {REQUIREMENTS.map(({ key, label, hint }) => {
          const outcome = summary[key] as Outcome;
          return (
            <div key={key} title={hint} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
              <span style={{ color: theme[OUTCOME_TOKEN[outcome]], fontWeight: 700, width: 12 }}>
                {OUTCOME_MARK[outcome]}
              </span>
              <span style={{ color: outcome === 'unknown' ? theme['text-dim'] : theme.text }}>{label}</span>
            </div>
          );
        })}
      </Section>

      <Section title={`Findings (${report.findings.length})`} theme={theme}>
        {report.findings.length === 0 && (
          <div style={{ color: theme['text-dim'] }}>Nothing to report.</div>
        )}
        {report.findings.map((finding, index) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            theme={theme}
            open={selected === index}
            onToggle={() => onSelect(selected === index ? null : index)}
          />
        ))}
      </Section>

      <Section title="The net" theme={theme}>
        <Row theme={theme} label="Places" value={String(structure.placeCount)} />
        <Row theme={theme} label="Transitions" value={`${structure.transitionCount} (${structure.silentTransitionCount} silent)`} />
        <Row theme={theme} label="Arcs" value={String(structure.arcCount)} />
        <Row theme={theme} label="Free choice" value={structure.freeChoice ? 'yes' : 'no'} />
        {structure.stateMachine && <Row theme={theme} label="State machine" value="yes" />}
        {structure.markedGraph && <Row theme={theme} label="Marked graph" value="yes" />}
      </Section>

      <Section title="The search" theme={theme}>
        <Row theme={theme} label="Reachable markings" value={behaviour.states.toLocaleString()} />
        <Row
          theme={theme}
          label="Ended"
          value={{
            complete: 'complete — exact',
            truncated: 'at the state limit',
            unbounded: 'on an unboundedness proof',
          }[behaviour.exploration]}
        />
        {behaviour.finalReachable != null && (
          <Row theme={theme} label="Final marking reached" value={behaviour.finalReachable ? 'yes' : 'no'} />
        )}
      </Section>

      {report.warnings.length > 0 && (
        <Section title="About the input" theme={theme}>
          {report.warnings.map((warning) => (
            <div key={warning} style={{ color: theme['text-dim'], padding: '2px 0' }}>{warning}</div>
          ))}
        </Section>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  theme,
  open,
  onToggle,
}: {
  finding: Finding;
  theme: Record<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  const token = finding.severity === 'error' ? 'danger' : finding.severity === 'warning' ? 'warn' : 'text-dim';
  return (
    <div
      onClick={onToggle}
      style={{
        border: `1px solid ${open ? theme[token] : theme.border}`, borderRadius: 6,
        background: open ? `${theme[token]}12` : theme.bg,
        padding: '7px 9px', marginBottom: 6, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ color: theme[token], fontWeight: 700, fontSize: 11 }}>
          {finding.severity === 'error' ? '●' : finding.severity === 'warning' ? '▲' : '○'}
        </span>
        <span style={{ fontWeight: 600, flex: 1 }}>{finding.title}</span>
      </div>
      {open && (
        <>
          <div style={{ marginTop: 6, color: theme['text-dim'] }}>{finding.detail}</div>
          {finding.witness && finding.witness.steps.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: theme['text-dim'], marginBottom: 4 }}>
                Firing sequence
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {finding.witness.steps.map((step, index) => (
                  <span key={`${step}-${index}`} style={{
                    border: `1px solid ${theme.border}`, borderRadius: 4, padding: '1px 5px',
                    background: theme['bg-sunken'] ?? theme.bg, fontSize: 11,
                  }}>{index + 1}. {step}</span>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 10, color: theme['text-dim'] }}>{finding.id}</div>
        </>
      )}
    </div>
  );
}

function Section({ title, theme, children }: { title: string; theme: Record<string, string>; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
        color: theme['text-dim'], marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ theme, label, value }: { theme: Record<string, string>; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' }}>
      <span style={{ color: theme['text-dim'] }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
