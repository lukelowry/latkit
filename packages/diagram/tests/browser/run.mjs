import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const executable =
  process.env.LATKIT_BROWSER ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executable) throw new Error('Set LATKIT_BROWSER to a Chromium executable');
const headed = process.argv.includes('--headed'),
  keepOpen = process.argv.includes('--keep-open');
if (keepOpen && !headed) throw new Error('--keep-open requires --headed');
const profile = await mkdtemp(path.join(tmpdir(), 'latkit-diagram-'));
const server = createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(root, '.' + requested);
    if (!filename.startsWith(path.resolve(root) + path.sep)) throw new Error('Outside repository');
    response.setHeader(
      'content-type',
      filename.endsWith('.html') ? 'text/html' : 'text/javascript',
    );
    response.end(await readFile(filename));
  } catch {
    response.statusCode = 404;
    response.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const child = spawn(
  executable,
  [
    ...(headed ? ['--new-window', '--window-size=1440,1100'] : ['--headless=new']),
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: !headed },
);
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-16000);
});
let socket;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let debugging;
  for (let i = 0; i < 200; i++) {
    try {
      debugging = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch {
      await sleep(50);
    }
  }
  if (!debugging) throw new Error('Browser did not start: ' + stderr);
  const tabs = await (await fetch('http://127.0.0.1:' + debugging + '/json/list')).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const calls = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(message.params));
    if (message.method === 'Log.entryAdded') console.error(JSON.stringify(message.params));
    const pending = calls.get(message.id);
    if (pending) {
      calls.delete(message.id);
      message.error ? pending.reject(message.error) : pending.resolve(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => {
        calls.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 60000);
      calls.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call('Page.enable');
  await call('Runtime.enable');
  /**
   * Load a page, await the global its script sets, and keep its result and a screenshot, taken at
   * once; `check` names a function of the page that then judges the screenshot.
   */
  const run = async (page, global, name, check) => {
    await call('Page.navigate', {
      url: 'http://127.0.0.1:' + port + '/packages/diagram/tests/browser/' + page,
    });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      const result = await call('Runtime.evaluate', {
        expression: 'typeof globalThis.' + global + ' !== "undefined"',
        returnByValue: true,
      });
      if (result.result.value) {
        ready = true;
        break;
      }
      await sleep(50);
    }
    if (!ready) throw new Error('Browser fixture did not load: ' + page);
    const result = await call('Runtime.evaluate', {
      expression: 'globalThis.' + global,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      );
    const screenshot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    const { images = {}, ...value } = result.result.value;
    if (check) {
      const judged = await call('Runtime.evaluate', {
        expression:
          'globalThis.' +
          check +
          '(' +
          JSON.stringify('data:image/png;base64,' + screenshot.data) +
          ')',
        awaitPromise: true,
        returnByValue: true,
      });
      if (judged.exceptionDetails)
        throw new Error(
          judged.exceptionDetails.exception?.description ?? JSON.stringify(judged.exceptionDetails),
        );
      value.screenshot = judged.result.value;
    }
    await mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await writeFile(
      path.join(root, 'output/' + name + '.json'),
      JSON.stringify(value, null, 2) + '\n',
    );
    console.log(JSON.stringify(value, null, 2));
    if (Object.keys(images).length) {
      const folder = path.join(root, 'output', name);
      await mkdir(folder, { recursive: true });
      for (const [title, data] of Object.entries(images))
        await writeFile(
          path.join(folder, title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png'),
          Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'),
        );
    }
    await writeFile(
      path.join(root, 'output/playwright/' + name + '.png'),
      Buffer.from(screenshot.data, 'base64'),
    );
  };
  await run('check.html', 'diagramCheck', 'diagram-browser');
  await run('gallery.html', 'diagramGallery', 'diagram-gallery', 'diagramTransitionCheck');
  if (keepOpen) {
    console.log(
      'Visible GPU fixture: http://127.0.0.1:' +
        port +
        '/packages/diagram/tests/browser/check.html',
    );
    console.log('Browser debugging port: ' + debugging);
    await new Promise((resolve) => child.once('exit', resolve));
  }
} finally {
  socket?.close();
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
  await new Promise((resolve) => server.close(resolve));
  if (
    path.dirname(path.resolve(profile)) === path.resolve(tmpdir()) &&
    path.basename(profile).startsWith('latkit-diagram-')
  )
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.error('Refusing to remove unexpected browser profile path');
}
