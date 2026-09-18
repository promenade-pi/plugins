/**
 * Drives the staged harness in headless Chrome over the DevTools protocol.
 *
 * Why this exists: the shipped view runs its render loop on
 * `requestAnimationFrame`, and React Three Fiber does not even *create* a
 * renderer until `react-use-measure`'s `ResizeObserver` has reported a
 * non-zero size. Both of those are part of a document's rendering lifecycle,
 * which a hidden or backgrounded tab never performs - so in an unattended
 * browser pane the canvas is never sized, never drawn, and the view looks
 * broken when nothing is wrong with it. Headless Chrome's page is *visible*
 * from the platform's point of view, so everything runs, and CDP gives real
 * waiting (rather than `--virtual-time-budget`, which fires the screenshot
 * before DuckDB-Wasm has finished instantiating).
 *
 * Usage, with the app's vite dev server already running:
 *
 *   node harness/drive.js --out /tmp/shots [--port 5200] [--script step.js]
 *
 * A `--script` file is evaluated in the page between load and screenshot; it
 * may `await`. Its value is printed. Every run also prints `#probe`, which the
 * harness page keeps filled with the diagnostics that matter (query count, SQL
 * errors, frame count, which labels are actually visible).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = arg('port', '5200');
const outDir = arg('out', path.join(process.cwd(), 'shots'));
const scriptFile = arg('script', null);
const url = arg('url', `http://localhost:${port}/__ft-harness/`);
const width = Number(arg('width', 1440));
const height = Number(arg('height', 880));
const settle = Number(arg('settle', 9000));
const cdpPort = Number(arg('cdp', 9333));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* Chrome is not listening yet. */
    }
    await sleep(250);
  }
  throw new Error('Chrome never opened a DevTools endpoint');
}

/** Minimal CDP client: one socket, sequential ids, no dependencies. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    } else {
      events.push(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return {
    ready,
    events,
    send(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    close() { socket.close(); },
  };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  // A fixed `--profile DIR` persists installed plugins, imported artifacts
  // and OPFS state across separate `drive.js` invocations - needed for any
  // scenario spanning more than one script (install once, then drive several
  // follow-up steps against what's already there). Without it, each run gets
  // a throwaway profile that is wiped on exit.
  const fixedProfile = arg('profile', null);
  const profile = fixedProfile ? path.resolve(fixedProfile) : fs.mkdtempSync(path.join(require('os').tmpdir(), 'ft-chrome-'));
  if (fixedProfile) fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // WebGPU in headless is not a given; when it is missing three's
    // WebGPURenderer initialises its WebGL 2 backend instead, which is the
    // fallback this plugin's whole material choice exists to keep working.
    ...(arg('nowebgpu', null) != null
      // Forces the WebGL 2 fallback, so the path most users are actually on
      // can be verified rather than assumed.
      ? ['--disable-features=WebGPU,WebGPUExperimentalFeatures']
      : ['--enable-unsafe-webgpu']),
    '--use-angle=metal',
    ...String(arg('flags', '')).split(' ').filter(Boolean),
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const chromeLog = [];
  chrome.stdout.on('data', (d) => chromeLog.push(String(d)));
  chrome.stderr.on('data', (d) => chromeLog.push(String(d)));

  let client;
  try {
    const target = await findTarget();
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false,
    });

    await client.send('Page.navigate', { url });
    await sleep(settle);

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
      }
      return result.result.value;
    };

    const probe = await evaluate("return document.getElementById('probe')?.textContent ?? '(no probe)';");
    console.log('--- probe ---');
    console.log(probe);

    if (scriptFile) {
      const source = fs.readFileSync(scriptFile, 'utf8');
      const value = await evaluate(source);
      console.log('--- script ---');
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
      const after = await evaluate("return document.getElementById('probe')?.textContent ?? '';");
      console.log('--- probe after ---');
      console.log(after);
    }

    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${arg('name', 'shot')}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`--- screenshot ---\n${file}`);

    const errors = client.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text);
    const exceptions = client.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text);
    if (errors.length || exceptions.length) {
      console.log('--- console errors ---');
      for (const line of [...new Set([...errors, ...exceptions])]) console.log(line);
    }
  } finally {
    client?.close();
    chrome.kill('SIGKILL');
    if (!fixedProfile) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
