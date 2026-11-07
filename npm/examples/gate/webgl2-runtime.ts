/** Exercises the public package on real WebGL2: unequal canvases, exact hits, exports, and loss. */
import path from 'node:path';
import type { Gpu, View } from 'latkit';
import { deadline, errorsOf, launch, serve, STEP } from './browser.ts';

declare global {
  interface Window {
    webglContexts: WebGL2RenderingContext[];
    verification: { gpu: Gpu; views: View[] };
  }
}

const root = path.resolve(import.meta.dirname, '..');
const server = await serve(root, 5234, 'WebGL2 runtime verification');
const chrome = await launch(['--disable-webgpu'], process.argv.includes('--software'));
try {
  const page = await chrome.browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = errorsOf(page);
  await page.route('**/__webgl2_verify', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>WebGL2 verification</title><body></body>',
    }),
  );
  await page.addInitScript((html) => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
    window.webglContexts = [];
    for (const prototype of [HTMLCanvasElement.prototype, OffscreenCanvas.prototype]) {
      const original = prototype.getContext;
      Object.defineProperty(prototype, 'getContext', {
        value: function (...args: unknown[]) {
          if (html && this instanceof OffscreenCanvas) return null;
          const context: unknown = Reflect.apply(original, this, args);
          if (args[0] === 'webgl2' && context)
            window.webglContexts.push(context as WebGL2RenderingContext);
          return context;
        },
      });
    }
  }, process.argv.includes('--html'));
  await page.goto(`${server.url}__webgl2_verify`);
  const module = '/@fs/' + path.resolve(root, '../dist/index.js').replaceAll('\\', '/');
  const result = await deadline(
    page.evaluate(async (module) => {
      const { Gpu, Data, View, Shot } = (await import(module)) as typeof import('latkit');
      const gpu = await Gpu.create();
      const data = new Data('verify').set('Node', [11, 22], {
        x: [-36, 42],
        y: [28, -24],
        name: ['Alpha', 'Beta'],
      });
      const views: View[] = [];
      const sizes = [
        [180, 130],
        [360, 250],
        [240, 170],
      ] as const;
      const colors = ['#ff0000', '#00ff00', '#0000ff'];
      const seen: number[][] = [];
      for (let i = 0; i < sizes.length; i++) {
        const [width, height] = sizes[i]!;
        const canvas = document.body.appendChild(document.createElement('canvas'));
        canvas.style.cssText = `width:${width}px;height:${height}px;display:block`;
        const view = await View.create(
          canvas,
          {
            space: { plane: { grid: 'off' } },
            theme: { background: '#000000' },
            marks: [
              {
                vertices: data.table('Node'),
                position: ['$x', '$y'],
                radius: 8,
                color: colors[i]!,
                label: { text: '$name', color: '#ffffff' },
                pick: true,
              },
            ],
          },
          { gpu, camera: { center: [0, 0], zoom: 0 } },
        );
        views.push(view);
      }
      window.verification = { gpu, views };
      const verify = async () => {
        await Promise.all(views.map((view) => view.done()));
        for (let i = 0; i < views.length; i++) {
          const view = views[i]!;
          const point = await view.screenOf({ data: 'verify', table: 'Node', id: 11 });
          if (!point) throw new Error(`view ${i}: known row was not located`);
          const hits = await view.pick(point, { radius: 1 });
          if (!hits.some((hit) => Number(hit.row.id) === 11))
            throw new Error(`view ${i}: known row was not picked`);
          const image = await Shot.of(view).image();
          if (
            !image.rgba.some(
              (v, at, rgba) =>
                at % 4 === 0 && v > 220 && rgba[at + 1]! > 220 && rgba[at + 2]! > 220,
            )
          )
            throw new Error(`view ${i}: text has no visible glyphs`);
          const x = Math.round(point[0]),
            y = Math.round(point[1]);
          const pixel = [
            ...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
          ];
          if (
            pixel[i]! < 250 ||
            pixel[3]! < 250 ||
            pixel.some((v, channel) => channel < 3 && channel !== i && v > 3)
          )
            throw new Error(`view ${i}: wrong exported pixel ${pixel.join(',')}`);
          image.destroy();
          const canvas = document.querySelectorAll('canvas')[i]!;
          const displayed = [...canvas.getContext('2d')!.getImageData(x, y, 1, 1).data];
          if (displayed.some((v, channel) => Math.abs(v - pixel[channel]!) > 3))
            throw new Error(
              `view ${i}: presentation ${displayed.join(',')} differs from export ${pixel.join(',')}`,
            );
          seen.push(pixel);
        }
      };
      await verify();
      // Focus pages begin with the first interaction. Clearing selection and hover must
      // restore every pixel, including channels and depth shared by subsequent exports.
      const focused = views[0]!;
      const original = await Shot.of(focused).image();
      const originalPixels = original.rgba.slice();
      original.destroy();
      focused.selection = [{ data: 'verify', table: 'Node', ids: [11] }];
      await focused.done();
      const unselected = await focused.screenOf({ data: 'verify', table: 'Node', id: 22 });
      if (!unselected) throw new Error('unselected row could not be located');
      const selected = await Shot.of(focused).image();
      const dimmed =
        selected.rgba[
          (Math.round(unselected[1]) * selected.width + Math.round(unselected[0])) * 4
        ]!;
      selected.destroy();
      if (dimmed >= 200) throw new Error(`first selection did not dim the other row: ${dimmed}`);
      focused.selection = [];
      focused.hovered = { data: 'verify', table: 'Node', id: 22 };
      await focused.done();
      focused.hovered = null;
      await focused.done();
      const restored = await Shot.of(focused).image();
      if (restored.rgba.some((value, i) => value !== originalPixels[i]))
        throw new Error('clearing selection and hover did not restore the original pixels');
      restored.destroy();
      // Redraw the smallest view after the largest surface has been allocated.
      views[0]!.camera = { center: [3, 4], zoom: 0 };
      await verify();
      // Odd widths and origins exercise row pitch and destination offsets in the direct copy.
      const tiled = await new Shot([257, 131], {
        views: [
          { view: views[0]!, region: [0, 0, 1, 0.5] },
          { view: views[1]!, region: [0, 0.5, 0.5, 0.5] },
          { view: views[2]!, region: [0.5, 0.5, 0.5, 0.5] },
        ],
      }).image();
      const packed = tiled.rgba;
      const panels = [
        { origin: [0, 0], size: [257, 66] },
        { origin: [0, 66], size: [129, 65] },
        { origin: [129, 66], size: [128, 65] },
      ] as const;
      for (let i = 0; i < panels.length; i++) {
        const { origin, size } = panels[i]!;
        const panel = await new Shot(size, { views: [views[i]!] }).image();
        const bytes = panel.rgba;
        for (let y = 0; y < size[1]; y++) {
          const at = ((origin[1] + y) * tiled.width + origin[0]) * 4;
          for (let x = 0; x < size[0] * 4; x++)
            if (packed[at + x] !== bytes[y * size[0] * 4 + x])
              throw new Error(`panel ${i}: pixel bytes differ at row ${y}, byte ${x}`);
        }
        panel.destroy();
      }
      tiled.destroy();
      const contexts = window.webglContexts.length;
      const lose = window.webglContexts[0]!.getExtension('WEBGL_lose_context');
      if (!lose) throw new Error('WebGL context loss extension unavailable');
      lose.loseContext();
      const until = performance.now() + 10000;
      while ((window.webglContexts.length === contexts || gpu.lost) && performance.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (window.webglContexts.length === contexts || gpu.lost)
        throw new Error('WebGL context did not recover automatically');
      await verify();
      const work = gpu.work;
      if (work.late) throw new Error(`${work.late} pipelines compiled at first use`);
      gpu.destroy();
      data.destroy();
      return {
        canvases: sizes.length,
        knownHits: seen.length,
        panelPixels: 257 * 131,
        pixels: seen,
        contexts: window.webglContexts.length,
        work,
      };
    }, module),
    STEP * 2,
    'WebGL2 public API, presentation, exports, and recovery',
  );
  console.log(JSON.stringify(result, null, 2));
  const worker = await deadline(
    page.evaluate(async (module) => {
      const url = new URL(module, location.href).href;
      const script = `
        import { Gpu, Data, View, Shot } from ${JSON.stringify(url)};
        Object.defineProperty(navigator, 'gpu', { value: undefined });
        try {
          const gpu = await Gpu.create();
          const data = new Data('worker').set('Point', [17], { x: [0], y: [0] });
          const canvas = new OffscreenCanvas(128, 96);
          const view = await View.create(canvas, {
            space: { plane: { grid: 'off' } },
            theme: { background: '#000000' },
            marks: [{ vertices: data.table('Point'), position: ['$x', '$y'], radius: 8, color: '#00ff00', pick: true }],
          }, { gpu, camera: { center: [0, 0], zoom: 0 } });
          await view.done();
          const point = await view.screenOf({ data: 'worker', table: 'Point', id: 17 });
          if (!point) throw new Error('worker could not locate the known row');
          const hits = await view.pick(point, { radius: 1 });
          if (!hits.some(hit => Number(hit.row.id) === 17)) throw new Error('worker could not pick the known row');
          const image = await Shot.of(view).image();
          const at = (Math.round(point[1]) * image.width + Math.round(point[0])) * 4;
          const pixel = [...image.rgba.slice(at, at + 4)];
          if (pixel.join(',') !== '0,255,0,255') throw new Error('wrong worker export pixel: ' + pixel);
          if (gpu.work.late) throw new Error('worker compiled a pipeline at first use');
          image.destroy();
          view.destroy();
          gpu.destroy();
          data.destroy();
          postMessage({ offscreen: true, knownHits: hits.length, pixel });
        } catch (error) { postMessage({ error: String(error) }); }
      `;
      const blob = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      const worker = new Worker(blob, { type: 'module' });
      try {
        return await new Promise<unknown>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<{ error?: string }>) => {
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data);
          };
          worker.onerror = (event) => reject(new Error(event.message));
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(blob);
      }
    }, module),
    STEP,
    'worker-owned WebGL2 offscreen canvas',
  );
  console.log(JSON.stringify({ worker }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await chrome.close();
  await server.close();
}
