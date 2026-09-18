// esbuild's `text` loader hands a .css import over as a string.
declare module '*.css' {
  const content: string;
  export default content;
}
