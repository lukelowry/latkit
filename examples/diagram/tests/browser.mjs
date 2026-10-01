import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, 'output/diagram-example');
const executable =
  process.env.LATKIT_BROWSER ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync);
if (!executable) throw new Error('Set LATKIT_BROWSER to Chromium');
const profile = await mkdtemp(path.join(tmpdir(), 'latkit-diagram-example-'));
const child = spawn(
  executable,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let debugging;
  for (let i = 0; i < 100; i++) {
    try {
      debugging = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!debugging) throw new Error('Browser did not start');
  const tabs = await (await fetch('http://127.0.0.1:' + debugging + '/json/list')).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(message.params));
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      message.error ? call.reject(message.error) : call.resolve(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next,
        timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }, 60000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      );
    return result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.navigate', { url: process.env.LATKIT_EXAMPLE_URL ?? 'http://127.0.0.1:5192' });
  for (let i = 0; i < 200; i++) {
    if (await evaluate('!!window.diagramStudioReady')) break;
    await sleep(100);
  }
  await evaluate(`(async () => {
    const app = await window.diagramStudioReady;
    window.proofApp = app;
    window.proofWait = async (check) => {
      const start = performance.now();
      while (!check()) {
        if (app.errors.length) throw new Error(app.errors.join('\\n'));
        if (performance.now() - start > 45000) throw new Error('Timed out waiting for a frame');
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    await window.proofWait(() => app.diagram.stats().frames > 0);
    return app.diagram.stats();
  })()`);
  await mkdir(output, { recursive: true });
  const screenshot = async (name) => {
    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    await writeFile(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  await evaluate(
    `(async()=>{ const app=window.proofApp, frames=app.diagram.stats().frames; const el=document.getElementById('theme'); el.value='dark'; el.dispatchEvent(new Event('change')); await window.proofWait(()=>app.diagram.stats().frames>frames); })()`,
  );
  await screenshot('desktop');
  const report = await evaluate(`(async () => {
    const app = window.proofApp, wait = window.proofWait, passed = [];
    const assert = (condition, text) => { if (!condition) throw new Error(text); };
    const change = async (id, value) => {
      const el = document.getElementById(id), frames = app.diagram.stats().frames;
      if (el.type === 'checkbox') el.checked = value; else el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => app.diagram.stats().frames > frames);
      assert(app.errors.length === 0, app.errors.join('\\n'));
    };
    for (const shape of ['rectangle','ellipse','diamond','rounded']) await change('shape', shape);
    passed.push('four shapes');
    for (const marker of ['circle','diamond','directional']) await change('port-marker', marker);
    for (const density of ['compact','spacious','comfortable']) await change('density', density);
    for (const position of ['header','center']) await change('title-position', position);
    for (const radius of ['3','16','8']) await change('radius', radius);
    await change('port-labels', false); await change('port-labels', true);
    await change('detail', 'full'); await change('detail', 'auto');
    await change('theme', 'light'); await change('theme', 'dark');
    passed.push('themes, density, directional markers, port labels, title placement, corner radius and detail');
    for (const route of ['straight','elbow','orthogonal']) await change('route', route);
    for (const appearance of ['tag','wire']) await change('appearance', appearance);
    for (const palette of ['signal','thermal','neutral']) await change('palette', palette);
    for (const shade of ['spotlight','signal','none']) await change('shade', shade);
    await change('flow', true); await change('flow', false);
    passed.push('routing, tags, scales, shades, flow');
    for (const id of ['grid','snap','labels','junctions','status']) { await change(id, false); await change(id, true); }
    await change('msaa','1'); await change('msaa','4');
    const version = app.source.version;
    document.getElementById('simulate').checked = true;
    await wait(() => app.source.version !== version);
    document.getElementById('simulate').checked = false;
    document.getElementById('simulate').dispatchEvent(new Event('change'));
    passed.push('live native values');
    app.choosePreset('groups'); await wait(() => app.diagram.stats().components === 8);
    let frames = app.diagram.stats().frames;
    document.querySelector('#groups button').click(); await wait(() => app.diagram.stats().frames > frames);
    assert(Object.values(app.source.graph.groups)[0].collapsed, 'Group did not collapse');
    frames = app.diagram.stats().frames;
    document.querySelector('#groups button').click(); await wait(() => app.diagram.stats().frames > frames);
    frames = app.diagram.stats().frames;
    document.querySelector('#groups button:last-child').click(); await wait(() => app.diagram.stats().frames > frames);
    frames = app.diagram.stats().frames;
    document.querySelector('#groups button:last-child').click(); await wait(() => app.diagram.stats().frames > frames);
    passed.push('nested group collapse and expansion');
    app.choosePreset('shapes'); await wait(() => app.diagram.stats().components === 4);
    app.choosePreset('scale'); await wait(() => app.diagram.stats().components === 1024);
    assert(app.diagram.stats().connections === 992, 'Scale scene connections missing');
    passed.push('1024-node scene');
    app.choosePreset('loop'); await wait(() => app.diagram.stats().components === 6);
    document.querySelector('#palette-buttons button:nth-child(2)').click();
    await wait(() => app.diagram.stats().components === 7);
    document.querySelector('[data-action="undo"]').click(); await wait(() => app.diagram.stats().components === 6);
    document.querySelector('[data-action="redo"]').click(); await wait(() => app.diagram.stats().components === 7);
    document.querySelector('[data-action="undo"]').click(); await wait(() => app.diagram.stats().components === 6);
    passed.push('adding components, undo, redo');
    document.getElementById('algorithm').value = 'grid';
    frames = app.diagram.stats().frames;
    document.querySelector('[data-action="arrange"]').click(); await wait(() => app.diagram.stats().frames > frames && !document.querySelector('[data-action="arrange"]').disabled);
    passed.push('custom headless arrangement');
    await change('flow', true);
    const blob = await app.exportImage(false);
    await change('flow', false);
    assert(blob.type === 'image/png' && blob.size > 1000, 'PNG export failed');
    passed.push('2048 x 1280 PNG export while the canvas is animating');
    app.choosePreset('loop'); await wait(() => app.diagram.stats().components === 6);
    assert(!document.getElementById('error').hidden === false, 'Error panel is visible');
    return { passed, pngBytes: blob.size, errors: app.errors, stats: app.diagram.stats() };
  })()`);
  await evaluate(
    `(async()=>{ const app=window.proofApp; const frames=app.diagram.stats().frames; app.choosePreset('shapes'); await window.proofWait(()=>app.diagram.stats().frames>frames); })()`,
  );
  await screenshot('shapes');
  await evaluate(
    `(async()=>{ const app=window.proofApp, frames=app.diagram.stats().frames; const el=document.getElementById('theme'); el.value='light'; el.dispatchEvent(new Event('change')); document.getElementById('toggle-inspector').click(); await window.proofWait(()=>app.diagram.stats().frames>frames); })()`,
  );
  await screenshot('light');
  await evaluate(`document.getElementById('toggle-inspector').click()`);
  await evaluate(
    `(async()=>{ const app=window.proofApp; const frames=app.diagram.stats().frames; app.choosePreset('loop'); await window.proofWait(()=>app.diagram.stats().frames>frames); })()`,
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(500);
  const mobile = await evaluate(
    '({ width: innerWidth, content: document.documentElement.scrollWidth, error: !document.getElementById("error").hidden })',
  );
  if (mobile.content > mobile.width || mobile.error)
    throw new Error('Mobile overflow or rendering failure: ' + JSON.stringify(mobile));
  await screenshot('mobile');
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ ...report, mobile }, null, 2));
  console.log(JSON.stringify({ ...report, mobile }, null, 2));
} finally {
  socket?.close();
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1000)]);
  if (
    path.dirname(path.resolve(profile)) === path.resolve(tmpdir()) &&
    path.basename(profile).startsWith('latkit-diagram-example-')
  )
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
