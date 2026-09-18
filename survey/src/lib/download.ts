/**
 * Getting a file out of the sandboxed frame.
 *
 * The frame's CSP closes every network path (`default-src 'none'`, so no
 * fetch, XHR, WebSocket or beacon), which leaves exactly one way for a result
 * to reach the participant's disk: the browser's own download UI, reached by
 * clicking a detached `<a download>`. That works only because the iframe
 * carries `allow-downloads` — without it the click is silently a no-op, which
 * is how plugin export buttons used to sit there doing nothing.
 *
 * Same two mechanisms the rest of the plugin tree uses (figures go through
 * `exportFigure.ts`, tabular data through a `csv.ts` like this one); there is
 * deliberately no third.
 */

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  triggerDownload(url, filename);
  // Long enough that a slow save dialog still has the blob, short enough not
  // to hold megabytes for the life of the panel.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadJson(value: unknown, filename: string) {
  downloadBlob(JSON.stringify(value, null, 2), filename, 'application/json');
}

/** RFC-4180-ish: quote anything containing a delimiter, quote, or newline. */
function cell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Columns are the union of the rows' keys, in first-seen order. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const columns: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n');
}

export function downloadCsv(rows: Array<Record<string, unknown>>, filename: string) {
  downloadBlob(toCsv(rows), filename, 'text/csv;charset=utf-8');
}

/** A filename-safe slug of a survey or response title. */
export function slug(text: string): string {
  return (text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'survey').slice(0, 60);
}

/**
 * Reads JSON files the user picks.
 *
 * A plain `<input type="file">` inside the frame: no network is involved, so
 * the CSP has nothing to say about it, and the opaque origin does not affect
 * a file the user handed over deliberately. This is the import half of the
 * transport — a survey authored on one machine, or the responses collected
 * from several, arriving as files rather than through a server the app does
 * not have.
 */
export function pickJsonFiles(multiple: boolean): Promise<Array<{ name: string; value: unknown }>> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      const out: Array<{ name: string; value: unknown }> = [];
      for (const file of files) {
        try { out.push({ name: file.name, value: JSON.parse(await file.text()) }); }
        // A file that is not JSON is reported by its absence from the result,
        // and the caller says how many of how many were read.
        catch { /* skipped */ }
      }
      input.remove();
      resolve(out);
    });
    // No 'cancel' event in every browser: the promise simply never settles if
    // the user dismisses the picker, which is harmless here — nothing is
    // blocked on it and the panel stays interactive.
    input.click();
  });
}
