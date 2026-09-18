// esbuild's `text` loader (see build.js) turns a `.css` import into a plain
// string, so the frame can inject it via a <style> tag. There is no CSS
// modules pipeline here; this declaration is what makes the import type-check.
declare module '*.css' {
  const content: string;
  export default content;
}
