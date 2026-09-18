import { useMemo } from 'react';
import type { BytesFile } from './promenade';
import { fmtBytes } from './format';

const MAX_RENDERED = 400_000;

/**
 * A non-Parquet file: the catalog sidecar, a materialized JSON payload,
 * whatever else is sitting in the directory.
 *
 * JSON is re-indented, because these are machine-written single-line files
 * and an 800 KB sidecar on one line is not readable at all. Everything else
 * is shown as text, and a file that is not text is reported as such rather
 * than rendered as mojibake — a raw viewer should not pretend.
 */
export function RawBytes({ file }: { file: BytesFile }) {
  const body = useMemo(() => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    } catch {
      return { kind: 'binary' as const, text: '' };
    }
    if (file.path.endsWith('.json') && !file.truncated) {
      try { return { kind: 'json' as const, text: JSON.stringify(JSON.parse(text), null, 2) }; }
      catch { /* a truncated or non-conforming payload still shows as text */ }
    }
    return { kind: 'text' as const, text };
  }, [file.bytes, file.path, file.truncated]);

  return (
    <>
      <div className="raw-head">
        <span className="raw-path">{file.path}</span>
        <span className="raw-chip">{fmtBytes(file.size)}</span>
        <span className="raw-chip">{body.kind}</span>
        {file.truncated && <span className="raw-chip">first {fmtBytes(file.bytes.byteLength)} only</span>}
      </div>
      {body.kind === 'binary' ? (
        <div className="raw-note">
          Not UTF-8 text — {fmtBytes(file.size)} of binary content, and nothing here would
          render it honestly.
        </div>
      ) : (
        <pre className="raw-text">
          {body.text.length > MAX_RENDERED
            ? `${body.text.slice(0, MAX_RENDERED)}\n\n… ${fmtBytes(file.size)} total; the rest is not rendered.`
            : body.text}
        </pre>
      )}
    </>
  );
}
