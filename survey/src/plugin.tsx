import { useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { validateSurvey, type Survey, type SurveyResponse } from './model';
import { Runner } from './Runner';
import { Editor } from './Editor';
import { Responses } from './Responses';
import { useHostParams } from './host';
import css from './styles.css';

/**
 * Survey & Task — questionnaires that drive the panels beside them.
 *
 * One bundle, four views. The frame evals exactly one script, so a package
 * with several views has to be able to ask which one it is; `promenade.view()`
 * answers that. (Telling them apart by artifact type, the older trick, cannot
 * work here — the runner and the editor bind to the same `Survey` type.)
 *
 * The whole design rests on two host doors that face opposite ways:
 * `openView()` puts a visualisation on screen with given parameters, and
 * `workspace()` reads back what the participant did to it. A question can
 * therefore *be* a task rather than only describe one, and its answer can be
 * the state of a view rather than a typed sentence.
 */

const VIEW = {
  run: 'run.promenade.survey.run',
  edit: 'run.promenade.survey.edit',
  create: 'run.promenade.survey.new',
  responses: 'run.promenade.survey.responses',
};

function App() {
  const viewId = promenade.view()?.id ?? VIEW.run;
  const artifact = promenade.artifact();
  const params = useHostParams();

  /**
   * The in-progress run, persisted through the host's own parameter store.
   *
   * `setCachedState` is the obvious home and the wrong one: it is an
   * in-memory LRU that a page reload wipes, and a participant twelve questions
   * into a study whose browser reloads is a participant lost. View parameters
   * are written to disk by the host, so they survive it.
   *
   * The echo guard matters — the host pushes every parameter change back as a
   * `params` event, and re-saving on the echo would fight the panel for its
   * own state.
   */
  const lastSaved = useRef<string>('');
  const saveDraft = useCallback((draft: unknown) => {
    const encoded = JSON.stringify(draft);
    if (encoded === lastSaved.current) return;
    lastSaved.current = encoded;
    promenade.setParams({ draft });
  }, []);

  if (viewId === VIEW.responses) {
    const value = artifact.value as SurveyResponse | null;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.answers)) {
      return <Problem title="This is not a survey response">Its payload is missing or has a shape this build does not read.</Problem>;
    }
    return <Responses own={value} />;
  }

  if (viewId === VIEW.create) {
    return <Editor initial={null} />;
  }

  const check = validateSurvey(artifact.value);
  if (!check.ok) {
    // An invalid survey is still editable — that is how it gets fixed — but it
    // must never be *run*, because a participant is the wrong person to
    // discover that question 7 has no options.
    if (viewId === VIEW.edit) {
      return (
        <Editor
          initial={(artifact.value as Survey) ?? null}
          sourceArtifactId={artifact.id}
          sourceVersion={versionOf(artifact.value)}
        />
      );
    }
    return (
      <Problem title="This survey cannot be run yet">
        <ul>{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        <p>Open it in the editor to fix it.</p>
      </Problem>
    );
  }

  if (viewId === VIEW.edit) {
    return (
      <Editor
        initial={check.survey!}
        sourceArtifactId={artifact.id}
        sourceVersion={versionOf(artifact.value)}
      />
    );
  }

  return (
    <Runner
      survey={check.survey!}
      surveyArtifactId={artifact.id}
      params={params}
      onDraft={saveDraft}
    />
  );
}

/** A survey's own version counter, used to name the next one. */
function versionOf(value: unknown): number {
  const v = (value as { version?: unknown } | null)?.version;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sv sv-pad">
      <h1 className="sv-title">{title}</h1>
      <div className="sv-problem">{children}</div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
promenade.ready();
