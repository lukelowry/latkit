/** Exercises the installed release tarball, never the workspace-linked npm package. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import type { Browser } from 'playwright-core';
import { deadline, launch, STEP } from './browser.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const reportPath = path.join(root, 'target/npm/package.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
  consumer: string;
  sizes: unknown;
};
const consumer = report.consumer;
const installed = path.join(consumer, 'node_modules/latkit');
assert(
  !fs.lstatSync(installed).isSymbolicLink(),
  'consumer must install the tarball, not link the workspace',
);
execFileSync(
  process.execPath,
  [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', consumer],
  { stdio: 'inherit' },
);
execFileSync(process.execPath, ['--test', 'npm/test/load.test.mjs', 'npm/test/jobs.test.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, LATKIT_TEST_PACKAGE: installed },
});
await build({
  root: consumer,
  base: '/nested/app/',
  configFile: false,
  build: { target: 'es2022' },
});

const dist = path.join(consumer, 'dist');
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const relative = decodeURIComponent(url.pathname).replace(/^\/nested\/app\//, '');
  const file = path.resolve(dist, relative || 'index.html');
  if (
    !file.startsWith(`${dist}${path.sep}`) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    response.writeHead(404).end();
    return;
  }
  const mime: Record<string, string> = {
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.html': 'text/html',
  };
  response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(response);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
let browser: Browser | undefined;
const timings: unknown[] = [];
try {
  for (const mode of ['default', 'custom', 'compiled']) {
    browser = await launch([
      '--disable-gpu-shader-disk-cache',
      ...(process.platform === 'linux'
        ? ['--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan,WebGPU']
        : []),
    ]);
    const page = await browser.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    await page.addInitScript(() => {
      const original = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Set<number>();
      window.requestAnimationFrame = (callback) => {
        const id = original((now) => {
          pending.delete(id);
          callback(now);
        });
        pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        cancel(id);
      };
      Object.assign(window, { pendingFrames: () => pending.size });
    });
    await page.goto(`http://127.0.0.1:${address.port}/nested/app/`);
    await page.waitForFunction(() => 'packageConsumer' in window);
    assert(
      !requests.some((url) => /\.wasm(?:\?|$)|worker[^/]*\.js/.test(url)),
      'import must not request WASM or workers',
    );
    const result = await deadline(
      page.evaluate(async (mode) => {
        const state = window as unknown as {
          packageConsumer: { run(custom: boolean, compiled: boolean): Promise<unknown> };
          pendingFrames(): number;
        };
        const timing = await state.packageConsumer.run(mode === 'custom', mode === 'compiled');
        if (state.pendingFrames() !== 0)
          throw new Error('GPU cleanup left animation frames scheduled');
        return timing;
      }, mode),
      STEP,
      'packaged rendering and cleanup',
    );
    assert.deepEqual(errors, []);
    timings.push({ mode, ...(result as object) });
    await page.close();
    await browser.close();
  }
  const measurement = {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    browser: browser?.version(),
    origin: 'localhost',
    freshBrowserPerCase: true,
    shaderDiskCache: false,
    softwareGpu: process.platform === 'linux',
    timings,
  };
  fs.writeFileSync(
    path.join(root, 'target/npm/browser.json'),
    `${JSON.stringify(measurement, null, 2)}\n`,
  );
  console.log(JSON.stringify(measurement, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
