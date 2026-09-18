import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePanel } from './promenade';
import {
  STEP_KINDS, emptySurvey, hasOptions, newId, readsFromStimulus, validateSurvey,
  type Block, type Step, type StepKind, type Stimulus, type Survey,
} from './model';
import { downloadJson, slug } from './lib/download';
import { ImportPanel } from './Import';
import { OptionList } from './OptionList';
import { useHostSize } from './host';

const SURVEY_TYPE = 'Survey';

/**
 * The authoring surface.
 *
 * The part that could not be a JSON file in a text box is *Capture*: the
 * author arranges a real panel — the metro map, filtered the way the question
 * is about — and presses one button, and the exact parameters the host is
 * holding for that panel become the step's stimulus. Hand-writing those means
 * reading a plugin's parameter schema and guessing; capturing them means the
 * thing the participant sees is by construction the thing the author saw.
 *
 * Saving publishes a new `Survey` artifact. Editing an existing one publishes
 * a *new version* whose parent is the old one, because there is no update door
 * and, for something a study has already been run against, there should not be
 * — a changed questionnaire is a different questionnaire, and the DAG says so.
 */
export function Editor({ initial, sourceArtifactId, sourceVersion }: {
  initial: Survey | null;
  sourceArtifactId?: string;
  sourceVersion?: number;
}) {
  const [survey, setSurvey] = useState<Survey>(() => initial ?? emptySurvey());
  const [selected, setSelected] = useState<string | null>(initial?.steps[0]?.id ?? null);
  const [panels, setPanels] = useState<WorkspacePanel[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  /**
   * Two columns need room for two columns.
   *
   * This panel is normally docked *beside* the thing being captured, which is
   * the whole point of it — and at that width a fixed 300px step list leaves
   * the detail form about 190px, where an option field fits four characters.
   * The host injects resize (an iframe gets no useful layout event of its
   * own), so the panel stacks instead.
   */
  // `w === 0` means the host has not measured yet — not "zero wide", which
  // would flash the narrow layout on every open.
  const { w } = useHostSize();
  const narrow = w > 0 && w < 640;

  const self = useRef<string | null>(null);
  useEffect(() => {
    self.current = promenade.view()?.id ?? null;
    promenade.on('workspace', (payload) => setPanels(payload.panels ?? []));
    promenade.workspace().then((w) => setPanels(w.panels ?? [])).catch(() => {});
  }, []);

  // Any panel except this editor and its siblings — a survey panel is not a
  // stimulus, and offering one would let an author nest the questionnaire
  // inside its own question.
  const candidates = useMemo(
    () => panels.filter((p) => !p.viewId.startsWith('run.promenade.survey.')),
    [panels]
  );

  const validation = useMemo(() => validateSurvey(survey), [survey]);
  const step = survey.steps.find((s) => s.id === selected) ?? null;

  const edit = useCallback((patch: Partial<Survey>) => {
    setSaved(null);
    setSurvey((s) => ({ ...s, ...patch }));
  }, []);

  const editStep = useCallback((id: string, patch: Partial<Step>) => {
    setSaved(null);
    setSurvey((s) => ({ ...s, steps: s.steps.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  }, []);

  const addStep = useCallback((kind: StepKind) => {
    const created: Step = {
      id: newId('s'),
      kind,
      prompt: '',
      ...(hasOptions(kind) ? { options: ['Option A', 'Option B'] } : {}),
      ...(kind === 'rating' ? { scale: { min: 1, max: 7, minLabel: 'Hard', maxLabel: 'Easy' } } : {}),
    };
    setSaved(null);
    setSurvey((s) => ({ ...s, steps: [...s.steps, created] }));
    setSelected(created.id);
  }, []);

  const move = useCallback((id: string, by: number) => {
    setSaved(null);
    setSurvey((s) => {
      const i = s.steps.findIndex((x) => x.id === id);
      const to = i + by;
      if (i < 0 || to < 0 || to >= s.steps.length) return s;
      const steps = [...s.steps];
      const [moved] = steps.splice(i, 1);
      steps.splice(to, 0, moved);
      return { ...s, steps };
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSaved(null);
    setSurvey((s) => ({
      ...s,
      steps: s.steps.filter((x) => x.id !== id),
      // A block that still names a deleted step would fail validation and,
      // worse, silently shrink a counterbalance to one member.
      blocks: (s.blocks ?? [])
        .map((b) => ({ ...b, steps: b.steps.filter((sid) => sid !== id) }))
        .filter((b) => b.steps.length > 0),
    }));
    setSelected((current) => (current === id ? null : current));
  }, []);

  const capture = useCallback((panel: WorkspacePanel) => {
    if (!step) return;
    const stimulus: Stimulus = {
      artifactId: panel.artifactId,
      artifactName: panel.artifactName,
      viewId: panel.viewId,
      viewLabel: panel.viewLabel,
      // A snapshot, deliberately: the author goes on adjusting the panel for
      // the next question, and this step must keep the state it was captured
      // in rather than track it.
      params: JSON.parse(JSON.stringify(panel.params ?? {})),
      side: step.stimulus?.side ?? 'left',
    };
    editStep(step.id, { stimulus });
    setCapturing(false);
  }, [step, editStep]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const version = (sourceVersion ?? 0) + 1;
      const result = await promenade.publishArtifact({
        type: SURVEY_TYPE,
        name: sourceArtifactId ? `${survey.title} (v${version})` : survey.title,
        value: survey,
        // An edited survey is a child of the one it was edited from: two
        // studies run against two versions are two different studies, and the
        // DAG is where that distinction belongs.
        inputs: sourceArtifactId ? [sourceArtifactId] : [],
        meta: { steps: survey.steps.length, version },
      });
      setSaved(result);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }, [survey, sourceArtifactId, sourceVersion]);

  const importJson = useCallback((files: Array<{ name: string; value: unknown }>) => {
    const check = validateSurvey(files[0]?.value);
    if (!check.ok) return `${files[0]?.name ?? 'that'}: ${check.errors.join(' ')}`;
    setSurvey(check.survey!);
    setSelected(check.survey!.steps[0]?.id ?? null);
    setSaved(null);
    setError(null);
    return null;
  }, []);

  return (
    <div className={`sv sv-editor${narrow ? ' narrow' : ''}`}>
      <header className="sv-ed-head">
        <input
          className="sv-ed-title" value={survey.title}
          onChange={(e) => edit({ title: e.target.value })}
          placeholder="Survey title"
        />
        <div className="sv-actions">
          <button type="button" className="sv-btn" onClick={() => setImporting(true)}>Import…</button>
          <button
            type="button" className="sv-btn"
            onClick={() => downloadJson(survey, `${slug(survey.title)}.json`)}
          >
            Export
          </button>
          <button
            type="button" className="sv-btn primary"
            onClick={save} disabled={saving || !validation.ok}
            title={validation.ok ? '' : 'Fix the problems listed below first'}
          >
            {saving ? 'Saving…' : sourceArtifactId ? 'Save as new version' : 'Save survey'}
          </button>
        </div>
      </header>

      {saved && <p className="sv-ok sv-pad-x">Saved as “{saved.name}” — it is in the artifact tree.</p>}
      {error && <p className="sv-error sv-pad-x">{error}</p>}
      {importing && (
        <div className="sv-pad-x">
          <ImportPanel
            label="Load a survey exported from another workspace."
            multiple={false}
            onLoad={importJson}
            onClose={() => setImporting(false)}
          />
        </div>
      )}

      <div className="sv-ed-body">
        <aside className="sv-ed-list">
          <textarea
            className="sv-ed-desc" rows={2} value={survey.description ?? ''}
            onChange={(e) => edit({ description: e.target.value })}
            placeholder="Description shown before the first step (optional)"
          />
          <ol className="sv-steps">
            {survey.steps.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`sv-step${s.id === selected ? ' on' : ''}`}
                  onClick={() => setSelected(s.id)}
                >
                  <span className="sv-step-n">{i + 1}</span>
                  <span className="sv-step-text">
                    <span className="sv-step-prompt">{s.prompt || <em>no prompt yet</em>}</span>
                    <span className="sv-step-kind">
                      {STEP_KINDS.find((k) => k.kind === s.kind)?.label ?? s.kind}
                      {s.stimulus ? ` · ${s.stimulus.viewLabel}` : ''}
                    </span>
                  </span>
                </button>
                <span className="sv-step-tools">
                  <button type="button" title="Move up" onClick={() => move(s.id, -1)} disabled={i === 0}>↑</button>
                  <button type="button" title="Move down" onClick={() => move(s.id, 1)} disabled={i === survey.steps.length - 1}>↓</button>
                  <button type="button" title="Delete" onClick={() => remove(s.id)}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          <div className="sv-add">
            <span>Add a step</span>
            <select
              value="" onChange={(e) => { if (e.target.value) addStep(e.target.value as StepKind); }}
            >
              <option value="">Choose a kind…</option>
              {STEP_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <Blocks survey={survey} onChange={(blocks) => edit({ blocks })} />
        </aside>

        <section className="sv-ed-detail">
          {!step ? (
            <p className="sv-hint sv-pad">Pick a step, or add one.</p>
          ) : (
            <div className="sv-pad">
              <label className="sv-field">
                <span>Kind</span>
                <select
                  value={step.kind}
                  onChange={(e) => {
                    const kind = e.target.value as StepKind;
                    editStep(step.id, {
                      kind,
                      ...(hasOptions(kind) && !step.options ? { options: ['Option A', 'Option B'] } : {}),
                      ...(kind === 'rating' && !step.scale
                        ? { scale: { min: 1, max: 7, minLabel: 'Hard', maxLabel: 'Easy' } }
                        : {}),
                      ...(kind === 'instruction' ? { required: false } : {}),
                    });
                  }}
                >
                  {STEP_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </label>
              <p className="sv-hint">{STEP_KINDS.find((k) => k.kind === step.kind)?.hint}</p>

              <label className="sv-field">
                <span>Prompt</span>
                <textarea
                  rows={2} value={step.prompt}
                  onChange={(e) => editStep(step.id, { prompt: e.target.value })}
                  placeholder="What the participant is asked"
                />
              </label>
              <label className="sv-field">
                <span>Help text (optional)</span>
                <textarea
                  rows={2} value={step.help ?? ''}
                  onChange={(e) => editStep(step.id, { help: e.target.value })}
                  placeholder="Task detail shown under the prompt"
                />
              </label>

              {step.kind !== 'instruction' && (
                <label className="sv-check">
                  <input
                    type="checkbox" checked={!!step.required}
                    onChange={(e) => editStep(step.id, { required: e.target.checked })}
                  />
                  <span>An answer is required</span>
                </label>
              )}

              {hasOptions(step.kind) && (
                <div className="sv-field">
                  <span>{step.kind === 'order' ? 'Items to put in order' : 'Options'}</span>
                  <OptionList
                    // Remounts when the selected step changes, which is what
                    // rebuilds the list's own rows from the new step's options.
                    key={step.id}
                    options={step.options ?? []}
                    onChange={(options) => editStep(step.id, { options })}
                    addLabel={step.kind === 'order' ? 'Add item' : 'Add option'}
                  />
                  <p className="sv-hint">
                    Drag by the handle to reorder, or focus a handle and use the arrow keys.
                    Enter adds the next one.
                    {step.kind === 'order' && ' Participants see these in this order and assign positions.'}
                  </p>
                </div>
              )}

              {step.kind === 'rating' && (
                <div className="sv-row">
                  <label className="sv-field small">
                    <span>From</span>
                    <NumberField
                      value={step.scale?.min ?? 1}
                      onChange={(min) => editStep(step.id, {
                        scale: { ...(step.scale ?? { min: 1, max: 7 }), min },
                      })}
                    />
                  </label>
                  <label className="sv-field small">
                    <span>To</span>
                    <NumberField
                      value={step.scale?.max ?? 7}
                      onChange={(max) => editStep(step.id, {
                        scale: { ...(step.scale ?? { min: 1, max: 7 }), max },
                      })}
                    />
                  </label>
                  <label className="sv-field">
                    <span>Low label</span>
                    <input
                      value={step.scale?.minLabel ?? ''}
                      onChange={(e) => editStep(step.id, {
                        scale: { ...(step.scale ?? { min: 1, max: 7 }), minLabel: e.target.value },
                      })}
                    />
                  </label>
                  <label className="sv-field">
                    <span>High label</span>
                    <input
                      value={step.scale?.maxLabel ?? ''}
                      onChange={(e) => editStep(step.id, {
                        scale: { ...(step.scale ?? { min: 1, max: 7 }), maxLabel: e.target.value },
                      })}
                    />
                  </label>
                </div>
              )}

              <div className="sv-field">
                <span>What to show{readsFromStimulus(step.kind) ? ' (required for this kind)' : ''}</span>
                {step.stimulus ? (
                  <div className="sv-captured">
                    <div className="sv-captured-what">
                      <b>{step.stimulus.artifactName}</b> · {step.stimulus.viewLabel}
                      <span className="sv-hint">
                        {Object.keys(step.stimulus.params).length} parameter
                        {Object.keys(step.stimulus.params).length === 1 ? '' : 's'} captured
                      </span>
                    </div>
                    <div className="sv-actions">
                      <select
                        value={step.stimulus.side}
                        onChange={(e) => editStep(step.id, {
                          stimulus: { ...step.stimulus!, side: e.target.value as 'left' | 'right' },
                        })}
                      >
                        <option value="left">Open on the left</option>
                        <option value="right">Open on the right</option>
                      </select>
                      <button type="button" className="sv-btn" onClick={() => setCapturing(true)}>Recapture</button>
                      <button
                        type="button" className="sv-btn quiet"
                        onClick={() => editStep(step.id, { stimulus: null })}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="sv-btn" onClick={() => setCapturing(true)}>
                    Capture a view…
                  </button>
                )}
              </div>

              {capturing && (
                <div className="sv-capture">
                  <div className="sv-capture-head">
                    Open and arrange the view you want, then pick its panel.
                    <button type="button" className="sv-btn quiet" onClick={() => setCapturing(false)}>Cancel</button>
                  </div>
                  {candidates.length ? (
                    <ul className="sv-capture-list">
                      {candidates.map((panel) => (
                        <li key={panel.panelId}>
                          <button type="button" onClick={() => capture(panel)}>
                            <b>{panel.artifactName}</b> · {panel.viewLabel}
                            <span className="sv-hint">
                              {Object.keys(panel.params ?? {}).length} parameter
                              {Object.keys(panel.params ?? {}).length === 1 ? '' : 's'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sv-hint">
                      No other panel is open. Open the visualisation you want to ask about, set it up,
                      then come back.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {!validation.ok && (
        <footer className="sv-problems">
          <b>{validation.errors.length} problem{validation.errors.length === 1 ? '' : 's'} to fix before saving</b>
          <ul>{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </footer>
      )}
    </div>
  );
}

/**
 * A number field that can be empty while it is being typed in.
 *
 * `Number('')` is 0, so binding a number straight to the input means clearing
 * the field snaps it to zero and the caret ends up behind a digit the user did
 * not type — the same class of problem as the options textarea that dropped
 * the line you had just added. Keeping the *text* locally lets the
 * intermediate state exist; only a parseable value is reported upward.
 */
function NumberField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  // Follow the value when it changes from outside (a different step selected),
  // but not while this field is the thing changing it.
  const own = useRef(false);
  useEffect(() => {
    if (own.current) { own.current = false; return; }
    setText(String(value));
  }, [value]);
  return (
    <input
      type="number" value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) { own.current = true; onChange(n); }
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/**
 * Counterbalancing, expressed as blocks of steps.
 *
 * Deliberately the only randomisation control in the editor. An A/B study
 * where every participant meets condition A first cannot separate "A is
 * better" from "the first one seen is better", so this is not an advanced
 * feature to defer — it is the difference between a result and an artefact of
 * ordering.
 */
function Blocks({ survey, onChange }: {
  survey: Survey;
  onChange: (blocks: Block[]) => void;
}) {
  const blocks = survey.blocks ?? [];
  const inABlock = new Set(blocks.flatMap((b) => b.steps));

  return (
    <div className="sv-blocks">
      <div className="sv-blocks-head">
        <span>Counterbalanced blocks</span>
        <button
          type="button"
          onClick={() => onChange([...blocks, {
            id: newId('b'), label: `Block ${blocks.length + 1}`, steps: [], counterbalance: true,
          }])}
        >
          + Block
        </button>
      </div>
      {!blocks.length && (
        <p className="sv-hint">
          A block's steps are shown in a random order per participant, so an A/B comparison
          is not also measuring which condition came first.
        </p>
      )}
      {blocks.map((block) => (
        <div className="sv-block" key={block.id}>
          <div className="sv-block-head">
            <input
              value={block.label}
              onChange={(e) => onChange(blocks.map((b) => (b.id === block.id ? { ...b, label: e.target.value } : b)))}
            />
            <button
              type="button" title="Remove block"
              onClick={() => onChange(blocks.filter((b) => b.id !== block.id))}
            >
              ✕
            </button>
          </div>
          <label className="sv-check">
            <input
              type="checkbox" checked={!!block.counterbalance}
              onChange={(e) => onChange(blocks.map((b) => (b.id === block.id ? { ...b, counterbalance: e.target.checked } : b)))}
            />
            <span>Flip the order per participant</span>
          </label>
          {survey.steps.map((s, i) => {
            const mine = block.steps.includes(s.id);
            if (!mine && inABlock.has(s.id)) return null;
            return (
              <label className="sv-check small" key={s.id}>
                <input
                  type="checkbox" checked={mine}
                  onChange={() => onChange(blocks.map((b) => (b.id === block.id
                    ? {
                      ...b,
                      steps: mine
                        ? b.steps.filter((x) => x !== s.id)
                        // Kept in document order so the block's own slots stay
                        // in the order the author laid them out.
                        : survey.steps.filter((x) => x.id === s.id || b.steps.includes(x.id)).map((x) => x.id),
                    }
                    : b)))}
                />
                <span>{i + 1}. {s.prompt || 'untitled step'}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
