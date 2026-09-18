/** `.css` is bundled as raw text and injected via a `<style>` tag at runtime —
 *  the frame's CSP has no way to load an external stylesheet. */
declare module '*.css' {
  const content: string;
  export default content;
}
