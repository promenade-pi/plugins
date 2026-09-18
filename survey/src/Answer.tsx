import type { SelectionItem } from './promenade';
import type { Step } from './model';

/**
 * The answer widgets, one per step kind.
 *
 * Split out from the runner because this is the part a study author judges the
 * survey by — the widgets are the questionnaire, as far as a participant is
 * concerned — and the runner is bookkeeping around them.
 *
 * Two of the nine take no input at all: `selection` and `workspace` are
 * answered *in the other panel*, so what they render is a read-out of what the
 * participant has done there. Making them look like the others would invite
 * people to try to answer them here.
 */
export function Answer({ step, value, onChange, selection, stimulusParams }: {
  step: Step;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Current cross-panel selection, for `selection` steps. */
  selection: SelectionItem[];
  /** The stimulus panel's live parameters, for `workspace` steps. */
  stimulusParams: Record<string, unknown> | null;
}) {
  switch (step.kind) {
    case 'instruction':
      return null;

    case 'choice':
      return (
        <div className="sv-options">
          {(step.options ?? []).map((option) => (
            <label className={`sv-option${value === option ? ' on' : ''}`} key={option}>
              <input
                type="radio" name={step.id} checked={value === option}
                onChange={() => onChange(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      );

    case 'multi': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="sv-options">
          {(step.options ?? []).map((option) => (
            <label className={`sv-option${chosen.includes(option) ? ' on' : ''}`} key={option}>
              <input
                type="checkbox" checked={chosen.includes(option)}
                onChange={() => onChange(chosen.includes(option)
                  // Kept in the author's option order rather than click order:
                  // an answer set is a set, and two participants who ticked the
                  // same boxes should produce the same recorded string.
                  ? chosen.filter((c) => c !== option)
                  : (step.options ?? []).filter((o) => o === option || chosen.includes(o)))}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'rating': {
      const { min = 1, max = 7, minLabel, maxLabel } = step.scale ?? {};
      const points: number[] = [];
      for (let n = min; n <= max; n++) points.push(n);
      return (
        <div className="sv-scale">
          <div className="sv-scale-row">
            {points.map((n) => (
              <button
                type="button" key={n}
                className={`sv-point${value === n ? ' on' : ''}`}
                onClick={() => onChange(n)}
                aria-pressed={value === n}
              >
                {n}
              </button>
            ))}
          </div>
          {(minLabel || maxLabel) && (
            <div className="sv-scale-ends">
              <span>{minLabel ?? ''}</span>
              <span>{maxLabel ?? ''}</span>
            </div>
          )}
        </div>
      );
    }

    case 'text':
      return (
        <textarea
          className="sv-text" rows={5} value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Your answer"
        />
      );

    case 'number':
      return (
        <input
          className="sv-number" type="number"
          value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          placeholder="0"
        />
      );

    case 'order':
      return <Ordering options={step.options ?? []} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;

    case 'selection':
      return (
        <div className="sv-readout">
          <div className="sv-readout-head">Selected in the view</div>
          {selection.length ? (
            <ul className="sv-chips">
              {selection.map((item) => (
                <li className="sv-chip" key={`${item.kind}:${item.id}`}>
                  <span className="sv-chip-kind">{item.kind}</span>
                  {item.id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sv-hint">Nothing selected yet — click something in the view beside this panel.</p>
          )}
        </div>
      );

    case 'workspace':
      return (
        <div className="sv-readout">
          <div className="sv-readout-head">The view as you have set it up</div>
          {stimulusParams && Object.keys(stimulusParams).length ? (
            <ParamDiff current={stimulusParams} initial={step.stimulus?.params ?? {}} />
          ) : (
            <p className="sv-hint">Waiting for the view beside this panel.</p>
          )}
        </div>
      );

    default:
      return null;
  }
}

/**
 * Ordering by assigning positions, not by dragging.
 *
 * Dragging is the obvious implementation and the wrong one here: this is the
 * ProVi question ("give each activity its position in the path"), participants
 * answer it against a diagram in the next panel, and a numbered dropdown is
 * both quicker to answer and unambiguous to record. It also works without a
 * pointer.
 */
function Ordering({ options, value, onChange }: {
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const positionOf = (option: string) => {
    const i = value.indexOf(option);
    return i < 0 ? '' : String(i + 1);
  };
  const setPosition = (option: string, position: string) => {
    const without = value.filter((v) => v !== option);
    if (!position) { onChange(without); return; }
    const at = Math.min(Math.max(Number(position) - 1, 0), without.length);
    onChange([...without.slice(0, at), option, ...without.slice(at)]);
  };
  return (
    <div className="sv-order">
      {options.map((option) => (
        <div className="sv-order-row" key={option}>
          <span className="sv-order-label">{option}</span>
          <select
            className="sv-order-pos" value={positionOf(option)}
            onChange={(e) => setPosition(option, e.target.value)}
          >
            <option value="">—</option>
            {options.map((_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

/**
 * What the participant changed, rather than everything the panel holds.
 *
 * A view can carry a dozen parameters and a task usually touches one. Showing
 * the whole object makes the answer unreadable and hides whether the task was
 * done at all; showing the delta is the actual content of a "configure the
 * view" answer.
 */
function ParamDiff({ current, initial }: {
  current: Record<string, unknown>;
  initial: Record<string, unknown>;
}) {
  const keys = [...new Set([...Object.keys(initial), ...Object.keys(current)])].sort();
  const changed = keys.filter((k) => JSON.stringify(initial[k]) !== JSON.stringify(current[k]));
  if (!changed.length) return <p className="sv-hint">Unchanged so far.</p>;
  return (
    <table className="sv-diff">
      <tbody>
        {changed.map((k) => (
          <tr key={k}>
            <th>{k}</th>
            <td className="was">{format(initial[k])}</td>
            <td className="now">{format(current[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function format(value: unknown): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return value.length > 3 ? `${value.length} items` : value.join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
