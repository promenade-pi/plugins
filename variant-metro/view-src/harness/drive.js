/**
 * Drives the staged harness in headless Chrome over the DevTools protocol.
 *
 * Why this exists (the same reason `plugins/friction-topography` has one):
 * React Flow only mounts edges once the document performs its rendering
 * lifecycle, and a hidden or non-compositing tab never fires
 * `requestAnimationFrame` — so in an unattended browser pane this view draws
 * its stations and *no lines at all*, which looks exactly like a bug in the
 * router and is not one. Headless Chrome's page is visible as far as the
 * platform is concerned, so everything runs; CDP then gives real waiting and
 * a real screenshot.
 *
 * With the app's vite dev server already running and `npm run harness` staged:
 *
 *   node harness/drive.js --out /tmp/shots [--port 5200] [--variants 1]
 *
 * `--variants k` moves the slider to position k before the screenshot;
 * `--script file.js` evaluates a file in the page instead (it may `await`,
 * and its value is printed). Every run prints the page's own `#probe` line —
 * node/station/edge counts and the panel readout — which is what should be
 * asserted, rather than eyeballing the picture.
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
const variants = arg('variants', null);
// Explicit `index.html`: vite's SPA fallback answers a bare directory URL
// with the *app's* index, not the harness page.
const url = arg('url', `http://localhost:${port}/__vm-harness/index.html`);
const width = Number(arg('width', 1440));
const height = Number(arg('height', 900));
const settle = Number(arg('settle', 4000));
const cdpPort = Number(arg('cdp', 9334));

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
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-chrome-'));
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
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

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

    if (variants != null) {
      const moved = await evaluate(`return window.__setVariants(${Number(variants)});`);
      await sleep(1800);
      console.log(`--- slider ---\n${JSON.stringify(moved)}`);
    }
    if (scriptFile) {
      const value = await evaluate(fs.readFileSync(scriptFile, 'utf8'));
      console.log('--- script ---');
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
    }

    const probe = await evaluate('return window.__probe ? window.__probe() : "(no probe)";');
    console.log('--- probe ---');
    console.log(typeof probe === 'string' ? probe : JSON.stringify(probe, null, 1));

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
      process.exitCode = 1;
    }
  } finally {
    client?.close();
    chrome.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
