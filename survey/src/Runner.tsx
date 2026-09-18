import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SelectionItem, WorkspacePanel } from './promenade';
import {
  isAnswered, newSeed, responseRows, stepOrder,
  type Step, type StepAnswer, type Survey, type SurveyResponse,
} from './model';
import { Answer } from './Answer';
import { downloadCsv, downloadJson, slug } from './lib/download';

const RESPONSE_TYPE = 'SurveyResponse';

interface Draft {
  seed: number;
  startedAt: string;
  /** Answers keyed by step id, so reordering never disturbs them. */
  answers: Record<string, unknown>;
  /** Per-step bookkeeping the response needs and the widgets do not. */
  meta: Record<string, { enteredAt: string; ms: number; submittedParams: Record<string, unknown> | null }>;
  at: number;
  participant: string;
  finished: boolean;
}

function freshDraft(): Draft {
  return {
    seed: newSeed(), startedAt: new Date().toISOString(),
    answers: {}, meta: {}, at: -1, participant: '', finished: false,
  };
}

/**
 * The participant panel.
 *
 * Everything a study needs that a plain form does not: it puts the stimulus on
 * screen itself, it can read the answer out of that stimulus rather than out of
 * a widget, and it records what the participant was actually looking at when
 * they answered.
 *
 * The run survives a reload. That is not a nicety — a participant halfway
 * through a twenty-question study whose browser hiccups is a lost participant —
 * and it is why the draft goes through `promenade.setParams()`, which the host
 * persists to disk, rather than `setCachedState()`, which is an in-memory LRU
 * that a reload wipes.
 */
export function Runner({ survey, surveyArtifactId, params, onDraft }: {
  survey: Survey;
  surveyArtifactId?: string;
  params: Record<string, unknown>;
  onDraft: (draft: Draft) => void;
}) {
  const restored = params.draft as Draft | undefined;
  const [draft, setDraft] = useState<Draft>(() => restored ?? freshDraft());
  const [selection, setSelection] = useState<SelectionItem[]>([]);
  const [panels, setPanels] = useState<WorkspacePanel[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A restored draft arriving after mount (the host's `params` event races the
  // first render) must win over the fresh one, but only once — afterwards this
  // panel is the author of its own draft and an echo would undo live edits.
  const adopted = useRef(!!restored);
  useEffect(() => {
    if (adopted.current || !restored) return;
    adopted.current = true;
    setDraft(restored);
  }, [restored]);

  const update = useCallback((patch: Partial<Draft> | ((d: Draft) => Draft)) => {
    setDraft((current) => {
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      onDraft(next);
      return next;
    });
  }, [onDraft]);

  const order = useMemo(() => stepOrder(survey, draft.seed), [survey, draft.seed]);
  const steps = useMemo(() => {
    const byId = new Map(survey.steps.map((s) => [s.id, s]));
    return order.map((id) => byId.get(id)).filter((s): s is Step => !!s);
  }, [survey, order]);

  const step: Step | undefined = draft.at >= 0 ? steps[draft.at] : undefined;

  useEffect(() => {
    promenade.on('selection', (sel) => setSelection(sel.items ?? []));
    promenade.on('workspace', (payload) => setPanels(payload.panels ?? []));
    promenade.workspace().then((w) => setPanels(w.panels ?? [])).catch(() => {});
  }, []);

  /**
   * The stimulus panel for the current step, as it stands *now*.
   *
   * Matched on (artifact, view) rather than a panel id: the id belongs to a
   * panel instance, and the participant may have closed and reopened the view
   * between steps. What the survey named is the view of the artifact.
   */
  const stimulusPanel = useMemo(() => {
    if (!step?.stimulus) return null;
    return panels.find((p) => p.artifactId === step.stimulus!.artifactId
      && p.viewId === step.stimulus!.viewId) ?? null;
  }, [panels, step]);

  // Putting the stimulus on screen is the runner's job, not the participant's.
  // Re-run on the step id alone: reopening on every params change would fight
  // the participant for control of the very panel the task asks them to
  // configure.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!step) return;
    if (openedFor.current === step.id) return;
    openedFor.current = step.id;
    if (!step.stimulus) return;
    promenade.openView(
      step.stimulus.artifactId, step.stimulus.viewId, step.stimulus.params,
      { beside: step.stimulus.side },
    ).catch((e) => setError(String(e?.message ?? e)));
  }, [step]);

  const answer = step ? draft.answers[step.id] : undefined;
  const liveAnswer = step?.kind === 'selection'
    ? selection.map((i) => `${i.kind}:${i.id}`)
    : step?.kind === 'workspace'
      ? stimulusPanel?.params ?? null
      : answer;

  const canAdvance = !step || !step.required || isAnswered(step, liveAnswer);

  const enter = useCallback((at: number) => {
    update((d) => {
      const target = steps[at];
      const meta = { ...d.meta };
      if (target && !meta[target.id]) {
        meta[target.id] = { enteredAt: new Date().toISOString(), ms: 0, submittedParams: null };
      }
      return { ...d, at, meta };
    });
  }, [steps, update]);

  const commit = useCallback(() => {
    if (!step) return;
    update((d) => {
      const previous = d.meta[step.id] ?? { enteredAt: new Date().toISOString(), ms: 0, submittedParams: null };
      const enteredAt = previous.enteredAt;
      return {
        ...d,
        answers: { ...d.answers, [step.id]: liveAnswer ?? null },
        meta: {
          ...d.meta,
          [step.id]: {
            enteredAt,
            ms: previous.ms + (Date.now() - Date.parse(enteredAt)),
            // Recorded for every step that had a stimulus, not only the ones
            // that asked about it — an answer given while looking at a
            // particular configuration is only interpretable alongside it.
            submittedParams: stimulusPanel?.params ?? null,
          },
        },
      };
    });
  }, [step, liveAnswer, stimulusPanel, update]);

  const response = useMemo<SurveyResponse>(() => ({
    schemaVersion: 1,
    surveyTitle: survey.title,
    ...(surveyArtifactId ? { surveyArtifactId } : {}),
    ...(draft.participant.trim() ? { participant: draft.participant.trim() } : {}),
    seed: draft.seed,
    order,
    startedAt: draft.startedAt,
    finishedAt: new Date().toISOString(),
    answers: steps
      .filter((s) => s.kind !== 'instruction')
      .map<StepAnswer>((s) => {
        const meta = draft.meta[s.id];
        return {
          stepId: s.id,
          kind: s.kind,
          prompt: s.prompt,
          answer: draft.answers[s.id] ?? null,
          stimulus: s.stimulus ?? null,
          submittedParams: meta?.submittedParams ?? null,
          enteredAt: meta?.enteredAt ?? draft.startedAt,
          submittedAt: new Date(Date.parse(meta?.enteredAt ?? draft.startedAt) + (meta?.ms ?? 0)).toISOString(),
          ms: meta?.ms ?? 0,
        };
      }),
  }), [survey, surveyArtifactId, draft, order, steps]);

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    try {
      // The response is a child of the survey *and* of every artifact it
      // showed — that is the provenance question a study answers: which
      // questionnaire, run against which data.
      const shown = [...new Set(steps.map((s) => s.stimulus?.artifactId).filter((id): id is string => !!id))];
      const inputs = [...new Set([...(surveyArtifactId ? [surveyArtifactId] : []), ...shown])];
      const name = draft.participant.trim()
        ? `${survey.title} · ${draft.participant.trim()}`
        : `${survey.title} · response`;
      const result = await promenade.publishArtifact({
        type: RESPONSE_TYPE, name, value: response, inputs,
        meta: { answers: response.answers.length, seed: response.seed, surveyTitle: survey.title },
      });
      setPublished(result);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setPublishing(false);
    }
  }, [response, steps, surveyArtifactId, survey.title, draft.participant]);

  // ---------------------------------------------------------------- rendering

  if (draft.at < 0) {
    return (
      <div className="sv sv-pad">
        <h1 className="sv-title">{survey.title}</h1>
        {survey.description && <p className="sv-desc">{survey.description}</p>}
        <p className="sv-hint">
          {steps.length} step{steps.length === 1 ? '' : 's'}.
          {steps.some((s) => s.stimulus) && ' Views will open beside this panel as you go.'}
        </p>
        <label className="sv-field">
          <span>Participant (optional)</span>
          <input
            value={draft.participant}
            onChange={(e) => update({ participant: e.target.value })}
            placeholder="P01"
          />
        </label>
        <div className="sv-actions">
          <button type="button" className="sv-btn primary" onClick={() => enter(0)}>Start</button>
        </div>
        {error && <p className="sv-error">{error}</p>}
      </div>
    );
  }

  if (draft.finished) {
    return (
      <div className="sv sv-pad">
        <h1 className="sv-title">Finished</h1>
        <p className="sv-desc">
          {response.answers.length} answer{response.answers.length === 1 ? '' : 's'} recorded
          {draft.participant.trim() ? ` for ${draft.participant.trim()}` : ''}.
        </p>
        {published ? (
          <p className="sv-ok">Saved as “{published.name}”. It is in the artifact tree, under this survey.</p>
        ) : (
          <div className="sv-actions">
            <button type="button" className="sv-btn primary" onClick={publish} disabled={publishing}>
              {publishing ? 'Saving…' : 'Save response'}
            </button>
          </div>
        )}
        <div className="sv-actions">
          <button
            type="button" className="sv-btn"
            onClick={() => downloadJson(response, `${slug(survey.title)}-response.json`)}
          >
            Export JSON
          </button>
          <button
            type="button" className="sv-btn"
            onClick={() => downloadCsv(responseRows(response), `${slug(survey.title)}-response.csv`)}
          >
            Export CSV
          </button>
        </div>
        <p className="sv-hint">
          JSON is what another workspace can import to pool responses; CSV is one row per answer.
        </p>
        <div className="sv-actions">
          <button
            type="button" className="sv-btn quiet"
            onClick={() => { openedFor.current = null; update(freshDraft()); }}
          >
            Run again
          </button>
        </div>
        {error && <p className="sv-error">{error}</p>}
      </div>
    );
  }

  if (!step) {
    return <div className="sv sv-pad"><p className="sv-hint">This survey has no steps.</p></div>;
  }

  const last = draft.at === steps.length - 1;
  return (
    <div className="sv sv-run">
      <header className="sv-head">
        <div className="sv-head-row">
          <span className="sv-head-title">{survey.title}</span>
          <span className="sv-head-count">Step {draft.at + 1} of {steps.length}</span>
        </div>
        <div className="sv-progress"><i style={{ width: `${((draft.at + 1) / steps.length) * 100}%` }} /></div>
      </header>

      <div className="sv-body">
        <h2 className="sv-prompt">{step.prompt}</h2>
        {step.help && <p className="sv-help">{step.help}</p>}
        <Answer
          step={step}
          value={answer}
          onChange={(v) => update((d) => ({ ...d, answers: { ...d.answers, [step.id]: v } }))}
          selection={selection}
          stimulusParams={stimulusPanel?.params ?? null}
        />
        {step.stimulus && (
          <div className="sv-stimulus">
            <span className="sv-stimulus-label">Shown beside this panel</span>
            <span className="sv-stimulus-what">
              {step.stimulus.artifactName} · {step.stimulus.viewLabel}
            </span>
            {!stimulusPanel && (
              <button
                type="button" className="sv-btn quiet"
                onClick={() => {
                  openedFor.current = null;
                  promenade.openView(
                    step.stimulus!.artifactId, step.stimulus!.viewId, step.stimulus!.params,
                    { beside: step.stimulus!.side },
                  ).catch((e) => setError(String(e?.message ?? e)));
                }}
              >
                Reopen
              </button>
            )}
          </div>
        )}
        {error && <p className="sv-error">{error}</p>}
      </div>

      <footer className="sv-foot">
        <button
          type="button" className="sv-btn"
          disabled={draft.at === 0}
          onClick={() => { commit(); enter(draft.at - 1); }}
        >
          Back
        </button>
        <span className="sv-foot-gap" />
        {!canAdvance && <span className="sv-required">An answer is required</span>}
        <button
          type="button" className="sv-btn primary"
          disabled={!canAdvance}
          onClick={() => {
            commit();
            if (last) update((d) => ({ ...d, finished: true }));
            else enter(draft.at + 1);
          }}
        >
          {last ? 'Finish' : 'Next'}
        </button>
      </footer>
    </div>
  );
}
