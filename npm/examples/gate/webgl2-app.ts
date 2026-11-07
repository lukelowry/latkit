/** Real package smoke test with WebGPU disabled. Use `--webkit` to check WebKit compatibility. */
import path from 'node:path';
import { deadline, launch, serve } from './browser.ts';

const root = path.resolve(import.meta.dirname, '..');
const server = await serve(root, 5232, 'WebGL2 examples');
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const chrome = await launch(['--disable-webgpu'], undefined, engine);
try {
  const page = await chrome.browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
    const renderers: string[] = [];
    Object.assign(window, { renderers });
    const prototypes: (HTMLCanvasElement | OffscreenCanvas)[] = [HTMLCanvasElement.prototype];
    if (typeof OffscreenCanvas === 'function') prototypes.push(OffscreenCanvas.prototype);
    for (const prototype of prototypes) {
      const original = prototype.getContext;
      Object.defineProperty(prototype, 'getContext', {
        value: function (...args: unknown[]) {
          const context: unknown = Reflect.apply(original, this, args);
          if (args[0] === 'webgl2' && context) {
            const gl = context as WebGL2RenderingContext;
            const extension = gl.getExtension('WEBGL_debug_renderer_info');
            renderers.push(
              String(
                extension
                  ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
                  : gl.getParameter(gl.RENDERER),
              ),
            );
          }
          return context;
        },
      });
    }
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.log(`PAGE ERROR: ${error.stack}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'error' || message.type() === 'warning')
      console.log(`${message.type()}: ${message.text()}`);
  });
  const id = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'orbits';
  await page.goto(`${server.url}#${id}`);
  await deadline(
    page.waitForFunction(
      () => {
        const stage = (window as unknown as { stage?: { views: { stats: { frames: number } }[] } })
          .stage;
        return stage?.views.length && stage.views.every((v) => v.stats.frames > 1);
      },
      null,
      { timeout: 55_000 },
    ),
    60_000,
    'WebGL2 first frames',
  );
  await page.waitForFunction(
    () =>
      (window as unknown as { stage?: { views: { waiting: string[] }[] } }).stage?.views.every(
        (v) => !v.waiting.includes('compiling'),
      ),
    null,
    { timeout: 55_000 },
  );
  await page.mouse.move(500, 400);
  console.log(
    'pick',
    await deadline(
      page.evaluate(async () => {
        const stage = (
          window as unknown as {
            stage: {
              views: { pick(point: number[], options: { radius: number }): Promise<unknown[]> }[];
            };
          }
        ).stage;
        return (await stage.views[0]!.pick([500, 400], { radius: 12 })).length;
      }),
      20_000,
      'WebGL2 pick readback',
    ),
  );
  console.log(
    JSON.stringify(
      await page.evaluate(() => {
        const stage = (
          window as unknown as {
            stage?: { gpu?: { work: unknown }; views: { stats: unknown; waiting: unknown }[] };
          }
        ).stage;
        return {
          renderers: (window as unknown as { renderers: string[] }).renderers,
          work: stage?.gpu?.work,
          views: stage?.views.map((v) => ({ stats: v.stats, waiting: v.waiting })),
        };
      }),
    ),
  );
  await page.screenshot({ path: path.resolve(root, '../../target/webgl2-' + id + '.png') });
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await chrome.close();
  await server.close();
}
