/* global document, FileReader, OffscreenCanvas, createImageBitmap, requestAnimationFrame */
import { createGpu } from '@latkit/gpu';
import { createDiagram } from '../../dist/index.js';
import { Source, clusters, unplace, data, vertex } from '/output/diagram-fixture.js';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Reject a step that takes longer than its budget, naming it. */
const within = (ms, step, promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(step + ' timed out')), ms)),
  ]);
const isolated = (count) => Object.assign(new Source(count), { ends: [] });
function fan() {
  const source = new Source(9);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      ...Array.from({ length: 8 }, (_, i) => ({ vertex: i + 1, port: 'input' })),
    ],
  ];
  return source;
}
function tangled() {
  const source = new Source(6);
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 3, port: 'input' },
    ],
    [
      { vertex: 1, port: 'output' },
      { vertex: 2, port: 'input' },
    ],
    [
      { vertex: 2, port: 'output' },
      { vertex: 0, port: 'input' },
    ],
    [
      { vertex: 3, port: 'output' },
      { vertex: 4, port: 'input' },
    ],
    [{ vertex: 4, port: 'output' }],
    [
      { vertex: 5, port: 'output' },
      { vertex: 5, port: 'input' },
    ],
  ];
  return source;
}
const ids = (...rows) => ({ Task: { kind: 'ids', ids: rows.map((row) => 'n' + row) } });
const edges = (d, options) => ({ Dependency: { ...d.edges.Dependency, ...options } });
/** A case's source, how it is drawn, and the rows to frame; all of it without them. */
const drawn = (source, options = {}, framed) => [
  source,
  { ...data(source, options.position), ...options.config },
  framed,
];
const wires = (options) => ({ config: { edges: edges(data(), options) } });
/** Each case, by the name its image is saved under. */
const CASES = {
  'grid case': () => drawn(clusters(334)),
  'grid case, close': () => drawn(clusters(334), {}, [0, 1, 2, 3, 4, 5, 6, 7]),
  'isolated vertices': () => drawn(isolated(60)),
  'fan-out': () => drawn(fan()),
  'cycles and self-loops': () => drawn(tangled()),
  'parts flowing down': () => drawn(clusters(12), { config: { layout: { direction: 'down' } } }),
  'parts flowing left': () => drawn(clusters(12), { config: { layout: { direction: 'left' } } }),
  tags: () => drawn(clusters(12), wires({ appearance: 'tag' })),
  'straight wires': () => drawn(clusters(6), wires({ route: 'straight' })),
  'nested and collapsed groups': () =>
    drawn(clusters(6), {
      config: {
        groups: {
          outer: { label: 'Outer', vertices: ids(0) },
          inner: { label: 'Inner', parent: 'outer', vertices: ids(4, 5) },
          apart: { label: 'Apart', vertices: ids(8, 9, 10, 11) },
          shut: { label: 'Shut', collapsed: true, vertices: ids(12, 13, 14) },
        },
      },
    }),
  'pinned and loose parts': () =>
    drawn(unplace(clusters(8), [16, 17, 18, 19, 20, 21, 22, 23]), { position: true }),
  'an empty diagram': () => drawn(new Source(0)),
};
/** An image as a data URL. */
const url = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
async function bright(blob) {
  const bitmap = await createImageBitmap(blob),
    context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] > 90 || pixels[i + 1] > 90 || pixels[i + 2] > 90) count++;
  return count;
}
globalThis.diagramGallery = (async () => {
  const errors = [];
  const gpu = await within(10000, 'GPU', createGpu());
  gpu.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const cases = [],
    images = {};
  for (const [name, make] of Object.entries(CASES)) {
    const [source, config, framed] = make(),
      diagram = createDiagram(gpu, config),
      size = { width: 1400, height: 900, pixelRatio: 1 };
    try {
      let image = await within(30000, name, diagram.image(size));
      if (framed) {
        diagram.fit(framed.map((row) => vertex(source, 'n' + row)));
        image = await within(30000, name + ' framed', diagram.image(size));
      }
      const stats = diagram.stats(),
        lit = await bright(image);
      if (stats.vertices) assert(lit > 2000, name + ' drew nothing visible');
      cases.push({ name, vertices: stats.vertices, edges: stats.edges, brightPixels: lit });
      images[name] = await url(image);
    } finally {
      diagram.destroy();
    }
  }
  // A transition on the canvas, slow enough that the runner's screenshot finds it between its ends.
  const canvas = document.querySelector('canvas'),
    moving = clusters(8);
  const diagram = createDiagram(gpu, {
    ...data(moving, true),
    canvas,
    animationMs: 8000,
    motion: 'full',
  });
  const frames = async (count) => {
    const start = diagram.stats().frames;
    await within(
      20000,
      'canvas frames',
      (async () => {
        while (diagram.stats().frames < start + count)
          await new Promise((resolve) => requestAnimationFrame(resolve));
      })(),
    );
  };
  await frames(1);
  moving.xy.forEach((_, i) => (moving.xy[i] += i % 2 ? 220 : 340));
  moving.update();
  diagram.set(data(moving, true), { animate: true });
  await frames(30);
  const n0 = diagram.locate(vertex(moving, 'n0'));
  assert(n0, 'The moving vertex is not drawn');
  await gpu.idle();
  assert(errors.length === 0, errors.join('\n'));
  const result = { status: 'passed', cases, errors };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  globalThis.diagramGalleryFixture = { gpu, diagram };
  return { ...result, images };
})();
