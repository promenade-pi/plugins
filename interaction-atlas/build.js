// The sandbox accepts one classic script. Keep the computation kernel in a
// separately testable source file, then concatenate sources into that script.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const [engine, plugin] = await Promise.all([
  readFile(new URL('./src/engine.js', import.meta.url), 'utf8'),
  readFile(new URL('./src/plugin.js', import.meta.url), 'utf8'),
]);
await mkdir(new URL('./build/', import.meta.url), { recursive: true });
await writeFile(new URL('./build/plugin.js', import.meta.url), `${engine}\n${plugin}\n`);
