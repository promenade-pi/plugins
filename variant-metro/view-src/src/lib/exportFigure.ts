import { toJpeg, toPng, toSvg } from 'html-to-image';

/**
 * Default filter for figure export: excludes anything carrying React Flow's
 * `react-flow__panel` class. Controls is internally a Panel, so this one
 * check also excludes it (and any user `<Panel>` legend) along with the
 * minimap, matching this plugin family's existing PNG export behaviour.
 */
export function defaultFigureFilter(node: HTMLElement): boolean {
  return !(node.classList?.contains('react-flow__minimap') || node.classList?.contains('react-flow__panel'));
}

interface FigureExportOptions {
  filter?: (node: HTMLElement) => boolean;
  backgroundColor?: string;
  pixelRatio?: number;
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function exportElementAsPng(el: HTMLElement, filename: string, opts: FigureExportOptions = {}) {
  const url = await toPng(el, { pixelRatio: 2, filter: defaultFigureFilter, ...opts });
  triggerDownload(url, filename);
}

export async function exportElementAsSvg(el: HTMLElement, filename: string, opts: FigureExportOptions = {}) {
  const url = await toSvg(el, { filter: defaultFigureFilter, ...opts });
  triggerDownload(url, filename);
}

/** Reads width/height straight out of the JPEG's SOF marker, rather than
 * trusting arithmetic from the source element's box times pixelRatio — the
 * PDF's declared /Width and /Height must exactly match the DCTDecode
 * stream's own raster size, or strict readers misrender it. */
function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2; // skip SOI (FFD8)
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    const segmentLength = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + segmentLength;
  }
  throw new Error('Could not read JPEG dimensions');
}

/** Builds a minimal single-page, single-image PDF by wrapping a JPEG byte
 * stream directly as a DCTDecode XObject — JPEG is already DCT-compressed,
 * so no further encoding is needed. Avoids pulling in a PDF library for one
 * raster-image page. */
function buildSingleImagePdf(jpegBytes: Uint8Array): Uint8Array {
  const { width, height } = jpegPixelSize(jpegBytes);
  const ptPerPx = 0.75; // treat the raster as 96 CSS px/inch -> 72 pt/inch
  const pageW = Math.round(width * ptPerPx);
  const pageH = Math.round(height * ptPerPx);
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0, 0, 0, 0, 0, 0];
  let pos = 0;
  const push = (b: Uint8Array) => { chunks.push(b); pos += b.length; };
  const str = (s: string) => push(enc.encode(s));

  str('%PDF-1.4\n');

  offsets[1] = pos;
  str('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = pos;
  str('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  offsets[3] = pos;
  str(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  offsets[4] = pos;
  str(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  str('\nendstream\nendobj\n');

  offsets[5] = pos;
  str(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefStart = pos;
  str('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) str(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  str(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { total.set(c, o); o += c.length; }
  return total;
}

export async function exportElementAsPdf(el: HTMLElement, filename: string, opts: FigureExportOptions = {}) {
  const jpegUrl = await toJpeg(el, { quality: 0.95, pixelRatio: 2, backgroundColor: '#ffffff', filter: defaultFigureFilter, ...opts });
  const b64 = jpegUrl.slice(jpegUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const pdfBytes = buildSingleImagePdf(bytes);
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
