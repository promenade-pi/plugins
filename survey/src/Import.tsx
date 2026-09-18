import { useState } from 'react';
import { pickJsonFiles } from './lib/download';

/**
 * Getting JSON *into* the panel — two ways, deliberately.
 *
 * A study on more than one participant runs on more than one machine, and
 * OPFS is per-browser, so files are the only transport there is. The file
 * picker is the good one. The paste box exists because a file picker inside a
 * sandboxed, opaque-origin frame is a thing this codebase has never relied on
 * before and could not be verified from outside one (a picker needs a real
 * user gesture, and synthetic clicks do not reach that frame) — so rather than
 * ship an import path that might silently do nothing on someone's browser,
 * there is a second one that cannot.
 *
 * If the picker turns out to be reliable everywhere, the paste box is still
 * the quicker route for a single response someone emailed you.
 */
export function ImportPanel({ label, multiple, onLoad, onClose }: {
  label: string;
  multiple: boolean;
  /** Called with each parsed value; returns a message to show, or null. */
  onLoad: (values: Array<{ name: string; value: unknown }>) => string | null;
  onClose: () => void;
}) {
  const [pasted, setPasted] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = (values: Array<{ name: string; value: unknown }>) => {
    const message = onLoad(values);
    if (message) setNote(message);
    else onClose();
  };

  return (
    <div className="sv-capture">
      <div className="sv-capture-head">
        {label}
        <button type="button" className="sv-btn quiet" onClick={onClose}>Cancel</button>
      </div>
      <div className="sv-actions">
        <button
          type="button" className="sv-btn"
          onClick={async () => {
            const files = await pickJsonFiles(multiple);
            if (files.length) load(files);
          }}
        >
          Choose {multiple ? 'files' : 'a file'}…
        </button>
        <span className="sv-hint">or paste the JSON below</span>
      </div>
      <textarea
        className="sv-paste" rows={5} value={pasted}
        onChange={(e) => { setPasted(e.target.value); setNote(null); }}
        placeholder='{ "schemaVersion": 1, … }'
      />
      <div className="sv-actions">
        <button
          type="button" className="sv-btn" disabled={!pasted.trim()}
          onClick={() => {
            try {
              const value = JSON.parse(pasted);
              // A pasted array is the multi-response export, which is exactly
              // what the aggregate view writes out — accepting it back means
              // pooled sets round-trip without being split up by hand.
              load(Array.isArray(value)
                ? value.map((v, i) => ({ name: `pasted[${i}]`, value: v }))
                : [{ name: 'pasted', value }]);
            } catch (e: any) {
              setNote(`That is not valid JSON — ${String(e?.message ?? e)}`);
            }
          }}
        >
          Load pasted
        </button>
      </div>
      {note && <p className="sv-error">{note}</p>}
    </div>
  );
}
