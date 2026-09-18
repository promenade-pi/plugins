/**
 * esbuild's `.css` → text loader (see `build.js`) turns a stylesheet import
 * into a plain string; the frame's CSP allows no external stylesheet, so the
 * text is injected into a `<style>` tag at runtime.
 */
declare module '*.css' {
  const text: string;
  export default text;
}
