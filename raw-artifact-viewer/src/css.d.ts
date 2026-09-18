/**
 * esbuild's `.css` → text loader (see `build.js`) turns a stylesheet import
 * into a plain string. Declared so this package type-checks standalone; the
 * frame's CSP allows no external stylesheet, so the text is injected into a
 * `<style>` tag at runtime instead.
 */
declare module '*.css' {
  const text: string;
  export default text;
}
