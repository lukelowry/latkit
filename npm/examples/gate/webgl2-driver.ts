/**
 * Checks latkit's WebGL2 device through the public Rust API (`driver/tests.rs`) in Chrome: WGSL
 * compilation and scopes, rendering, vertices, transfers, exports, surfaces, unsupported calls, and
 * device loss. It builds the `latkit-browser-tests` workspace crate, which uses latkit's `wgsl`
 * feature, unless given `--skip-build`. `--software` draws with SwiftShader, as Linux always does.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deadline, errorsOf, launch, STEP } from './browser.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const output = path.join(root, 'target/webgl2-driver');
if (!process.argv.includes('--skip-build')) {
  const built = execFileSync(
    'cargo',
    [
      'build',
      '--locked',
      '-p',
      'latkit-browser-tests',
      '--target',
      'wasm32-unknown-unknown',
      '--profile',
      'wasm-dev',
      '--message-format=json-render-diagnostics',
    ],
    { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 1 << 28 },
  );
  // The shaders latkit's build translated, which the page hands over before creating a GPU.
  const store = built
    .toString()
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { reason?: string; package_id?: string; out_dir?: string }];
      } catch {
        return [];
      }
    })
    .find(
      (m) => m.reason === 'build-script-executed' && m.package_id?.includes('/crates/latkit#'),
    )?.out_dir;
  if (!store) throw new Error("cargo did not report latkit's build output");
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(store, 'shaders.bin'), path.join(output, 'shaders.bin'));
  execFileSync(
    'wasm-bindgen',
    [
      path.join(root, 'target/wasm32-unknown-unknown/wasm-dev/latkit_browser_tests.wasm'),
      '--target',
      'web',
      '--out-dir',
      output,
      '--out-name',
      'driver',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
const files = new Map(
  ['driver.js', 'driver_bg.wasm', 'shaders.bin'].map((name) => [
    name,
    fs.readFileSync(path.join(output, name)),
  ]),
);
const server = http.createServer((req, res) => {
  const name = req.url?.slice(1);
  if (!name) {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>WebGL2 driver verification</title>');
    return;
  }
  if (name === 'favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const bytes = files.get(name);
  if (!bytes) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    'Content-Type',
    name.endsWith('.wasm')
      ? 'application/wasm'
      : name.endsWith('.bin')
        ? 'application/octet-stream'
        : 'text/javascript',
  );
  res.end(bytes);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server has no port');
const browser = await launch(
  ['--disable-webgpu', '--disable-gpu-shader-disk-cache'],
  process.argv.includes('--software') || undefined,
);
try {
  const page = await browser.browser.newPage();
  const errors = errorsOf(page);
  page.on('pageerror', (error) => console.error(error));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().startsWith('driver:'))
      console.log(message.text());
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await deadline(
    page.evaluate(async () => {
      const url = '/driver.js';
      const module = (await import(url)) as {
        default(): Promise<void>;
        shaders(bytes: Uint8Array): void;
        compile(source: string): Promise<string>;
        render(integer: boolean, samples: number, automatic: boolean): Promise<string>;
        vertices(bundled: boolean): Promise<string>;
        transfers(): Promise<string>;
        exports(): Promise<string>;
        surfaces(canvas: OffscreenCanvas, external: OffscreenCanvas): Promise<string>;
        scopes(): Promise<string>;
        unsupported(): Promise<string>;
        validation(): Promise<string>;
        loss(): Promise<string>;
      };
      await module.default();
      module.shaders(new Uint8Array(await (await fetch('/shaders.bin')).arrayBuffer()));
      console.debug('driver: compilation');
      const valid = await module.compile(
        '@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f { return vec4f(f32(i),0,0,1); } @fragment fn fragment()->@location(0) vec4f { return vec4f(1); }',
      );
      let invalid: string | undefined;
      try {
        await module.compile('invalid WGSL');
      } catch (error) {
        invalid = String(error);
      }
      if (!invalid?.includes('expected global item'))
        throw new Error('invalid WGSL escaped the error scope: ' + invalid);
      const canvas = new OffscreenCanvas(160, 96);
      const external = new OffscreenCanvas(8, 8);
      console.debug('driver: surfaces');
      const surfaces = await module.surfaces(canvas, external);
      for (const [target, expected] of [
        [canvas, [0, 255, 0, 255]],
        [external, [255, 0, 0, 255]],
      ] as const) {
        const pixels = target
          .getContext('2d')!
          .getImageData(0, 0, target.width, target.height).data;
        for (let i = 0; i < pixels.length; i++)
          if (pixels[i] !== expected[i % 4])
            throw new Error(`surface byte ${i}: ${pixels[i]}, expected ${expected[i % 4]}`);
      }
      const check = async (name: string, run: () => Promise<string>) => {
        console.debug(`driver: ${name}`);
        return run();
      };
      return {
        valid,
        invalid,
        rgba: await module.render(false, 1, false),
        integer: await module.render(true, 1, false),
        multisample: await module.render(false, 4, false),
        automatic: await module.render(true, 1, true),
        indexed: await module.vertices(false),
        bundled: await module.vertices(true),
        transfers: await module.transfers(),
        exports: await check('exports', () => module.exports()),
        surfaces,
        scopes: await check('scopes', () => module.scopes()),
        unsupported: await check('unsupported', () => module.unsupported()),
        validation: await check('validation', () => module.validation()),
        loss: await check('loss', () => module.loss()),
      };
    }),
    STEP,
    'public Rust API checks',
  );
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
