import { toPng, toSvg } from 'html-to-image';

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function exportElementAsPng(el: HTMLElement, filename: string, pixelRatio = 2) {
  const url = await toPng(el, { pixelRatio });
  triggerDownload(url, filename);
}

export async function exportElementAsSvg(el: HTMLElement, filename: string) {
  const url = await toSvg(el);
  triggerDownload(url, filename);
}
