import { useMemo, useState } from 'react';
import { responseRows, tally, type SurveyResponse } from './model';
import { downloadCsv, downloadJson, slug } from './lib/download';
import { ImportPanel } from './Import';

/**
 * One recorded run, and — once you add more — the comparison across them.
 *
 * The pooling is a file picker rather than a server because OPFS is
 * per-browser: a study run on five machines produces five workspaces, and
 * nothing in Promenade can see across them. Exported JSON is the transport,
 * and this is the other end of it. Nothing is written when responses are
 * pooled; the imported ones live in this panel until it closes, which is the
 * honest scope for "I collected these from my participants".
 */
export function Responses({ own }: { own: SurveyResponse }) {
  const [imported, setImported] = useState<SurveyResponse[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const all = useMemo(() => [own, ...imported], [own, imported]);
  const rows = useMemo(() => all.flatMap((r) => responseRows(r)), [all]);
  const tallies = useMemo(() => tally(all), [all]);

  const addResponses = (files: Array<{ name: string; value: unknown }>) => {
    const good: SurveyResponse[] = [];
    const bad: string[] = [];
    for (const file of files) {
      const value = file.value as SurveyResponse | null;
      // Deliberately shallow: a response is this plugin's own output, so the
      // question is "is this one of mine", not "is every field well-formed".
      if (value && value.schemaVersion === 1 && Array.isArray(value.answers)) good.push(value);
      else bad.push(file.name);
    }
    setImported((current) => [...current, ...good]);
    setNote(
      `Added ${good.length} response${good.length === 1 ? '' : 's'}`
      + (bad.length ? `; skipped ${bad.join(', ')}` : '')
    );
    // Anything readable counts as success; a skipped file is reported above
    // rather than holding the panel open.
    return good.length ? null : `Nothing readable in ${bad.join(', ') || 'that'}.`;
  };

  return (
    <div className="sv sv-responses">
      <header className="sv-ed-head">
        <div>
          <h1 className="sv-title">{own.surveyTitle}</h1>
          <p className="sv-hint">
            {own.participant ? `${own.participant} · ` : ''}
            {own.answers.length} answer{own.answers.length === 1 ? '' : 's'} ·
            {' '}{new Date(own.finishedAt).toLocaleString()} · seed {own.seed}
          </p>
        </div>
        <div className="sv-actions">
          <button type="button" className="sv-btn" onClick={() => setImporting(true)}>Add responses…</button>
          <button
            type="button" className="sv-btn"
            onClick={() => downloadJson(all.length > 1 ? all : own, `${slug(own.surveyTitle)}-responses.json`)}
          >
            Export JSON
          </button>
          <button
            type="button" className="sv-btn"
            onClick={() => downloadCsv(rows, `${slug(own.surveyTitle)}-responses.csv`)}
          >
            Export CSV
          </button>
        </div>
      </header>
      {note && <p className="sv-ok sv-pad-x">{note}</p>}
      {importing && (
        <div className="sv-pad-x">
          <ImportPanel
            label="Add responses exported from other workspaces."
            multiple
            onLoad={addResponses}
            onClose={() => setImporting(false)}
          />
        </div>
      )}

      <div className="sv-resp-body">
        <section>
          <h2 className="sv-section">
            Summary
            <span className="sv-hint">
              {all.length} response{all.length === 1 ? '' : 's'}
              {imported.length ? ` (${imported.length} imported)` : ''}
            </span>
          </h2>
          {tallies.map((t) => {
            const top = Math.max(1, ...t.counts.map((c) => c.n));
            return (
              <div className="sv-tally" key={t.stepId}>
                <div className="sv-tally-prompt">
                  {t.prompt}
                  {t.mean != null && <span className="sv-mean">mean {t.mean}</span>}
                </div>
                {t.counts.map((c) => (
                  <div className="sv-bar-row" key={c.value}>
                    <span className="sv-bar-label" title={c.value}>{c.value || '—'}</span>
                    <span className="sv-bar"><i style={{ width: `${(c.n / top) * 100}%` }} /></span>
                    <span className="sv-bar-n">{c.n}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        <section>
          <h2 className="sv-section">Answers</h2>
          <div className="sv-table-wrap">
            <table className="sv-table">
              <thead>
                <tr><th>#</th><th>Question</th><th>Answer</th><th>Shown</th><th>s</th></tr>
              </thead>
              <tbody>
                {own.answers.map((a, i) => (
                  <tr key={a.stepId}>
                    <td className="num">{i + 1}</td>
                    <td>{a.prompt}</td>
                    <td>
                      {Array.isArray(a.answer) ? a.answer.join(', ')
                        : a.answer != null && typeof a.answer === 'object' ? <code>{JSON.stringify(a.answer)}</code>
                          : String(a.answer ?? '—')}
                    </td>
                    <td className="dim">{a.stimulus ? `${a.stimulus.artifactName} · ${a.stimulus.viewLabel}` : '—'}</td>
                    <td className="num">{Math.round(a.ms / 100) / 10}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
