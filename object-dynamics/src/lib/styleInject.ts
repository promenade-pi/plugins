/** esbuild's `.css` -> text loader turns a CSS import into a plain string;
 * this is the only way to get a stylesheet into an opaque-origin frame that
 * cannot load a subresource of its own. */
export function injectCss(css: string) {
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
}
