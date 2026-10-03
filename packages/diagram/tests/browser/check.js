/* global document, PointerEvent, KeyboardEvent, MouseEvent, WheelEvent, OffscreenCanvas, createImageBitmap, requestAnimationFrame */
import { createGpu, createComposition, kit } from '@latkit/gpu';
import { createDiagram } from '../../dist/index.js';
import { Source, data, vertex, port as portOf } from '/output/diagram-fixture.js';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Whether an item draws the fixture row an id names, as `n2` for a task or `e0` for a dependency. */
const is = (item, id) =>
  !!item &&
  item.kind !== 'group' &&
  item.index.type === (id[0] === 'n' ? 'Task' : 'Dependency') &&
  item.row === Number(id.slice(1));
/** Views report events on a microtask; let them arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** An image's RGBA bytes, row by row. */
async function decode(blob) {
  const bitmap = await createImageBitmap(blob),
    context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
}
globalThis.diagramCheck = (async () => {
  const errors = [];
  const gpu = await createGpu();
  gpu.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const source = new Source(5);
  source.names = ['Load data', 'Validate α', 'Transform', 'Compute', 'Publish'];
  // One output fans out to three inputs; a second net leaves n1 for n3.
  source.ends = [
    [
      { vertex: 0, port: 'output' },
      { vertex: 1, port: 'input' },
      { vertex: 2, port: 'input' },
      { vertex: 4, port: 'input' },
    ],
    [
      { vertex: 1, port: 'output' },
      { vertex: 3, port: 'input' },
    ],
  ];
  const config = data(source);
  const canvas = document.querySelector('canvas');
  const diagram = createDiagram(gpu, { ...config, canvas, input: 'edit', msaa: 4 });
  let failure;
  diagram.on('error', (error) => {
    failure = error;
  });
  /** Wait for the canvas to present a frame after the given count. */
  const presented = async (after) => {
    while (diagram.stats().frames <= after) {
      if (failure) throw failure;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  /** Shades compile asynchronously; the diagram invalidates once one applies. */
  const applied = () =>
    new Promise((resolve, reject) => {
      const offs = [
        kit.rendererOf(diagram).on('invalidate', () => {
          offs.forEach((off) => off());
          resolve();
        }),
        diagram.on('error', (error) => {
          offs.forEach((off) => off());
          reject(error);
        }),
      ];
    });
  await presented(0);
  await gpu.idle();
  const ref = vertex(source, 'n0'),
    point = diagram.locate(ref);
  assert(
    point && (await diagram.pick(point)).some((h) => is(h, 'n0')),
    'Presented picking failed',
  );
  const rect = canvas.getBoundingClientRect();
  const pointer = (type, p, modifiers = {}) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: rect.left + p[0],
        clientY: rect.top + p[1],
        pointerType: 'mouse',
        ...modifiers,
      }),
    );
  let selections = 0;
  let selection = [];
  diagram.on('select', (items) => {
    selections++;
    selection = items;
  });
  pointer('pointerdown', point);
  pointer('pointerup', point);
  await settle();
  assert(selections > 0, 'Input selection failed');
  const another = diagram.locate(vertex(source, 'n2'));
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    pointer('pointerdown', another, modifiers);
    pointer('pointerup', another, modifiers);
    await settle();
    assert(
      selection.length === 2 && selection.some((item) => is(item, 'n2')),
      'Additive click did not add exactly once',
    );
    pointer('pointerdown', another, modifiers);
    pointer('pointerup', another, modifiers);
    await settle();
    assert(
      selection.length === 1 && is(selection[0], 'n0'),
      'Additive click did not remove exactly once',
    );
  }
  pointer('pointerdown', point);
  pointer('pointermove', [point[0] + 1, point[1] + 1]);
  pointer('pointerup', [point[0] + 1, point[1] + 1]);
  let moved,
    moveCount = 0;
  diagram.on('move', (proposal) => {
    moved = proposal;
    moveCount++;
    for (const [type, position] of Object.entries(proposal.positions))
      diagram.set({ vertices: { [type]: { position } } });
  });
  pointer('pointerdown', point);
  pointer('pointermove', [point[0], point[1] + 32]);
  pointer('pointerup', [point[0], point[1] + 32]);
  await settle();
  assert(moved?.moves.length === 1, 'Move proposal failed');
  // The canvas stops presenting; each step below renders an image at the canvas's size.
  diagram.set({ paused: true });
  const render = () => diagram.image({ width: 1000, height: 620, pixelRatio: 1 });
  await render();
  await gpu.idle();
  const port = (id, name) => {
    const point = diagram.locate(portOf(source, id, name));
    assert(point, 'Missing port ' + id + '.' + name);
    return point;
  };
  const wires = [];
  diagram.on('connect', (proposal) => wires.push(proposal));
  const wire = async (a, b) => {
    pointer('pointerdown', a);
    pointer('pointermove', b);
    pointer('pointerup', b);
    await settle();
  };
  await wire(port('n1', 'output'), port('n1', 'output'));
  assert(wires.length === 0, 'Port click unexpectedly proposed a wire');
  await wire(port('n1', 'output'), port('n4', 'input'));
  assert(
    wires.length === 1 && is(wires[0].from, 'n1') && is(wires[0].to, 'n4'),
    'Connect proposal failed',
  );
  await wire(port('n1', 'input'), port('n3', 'input'));
  assert(
    wires.length === 2 &&
      is(wires[1].from, 'n0') &&
      is(wires[1].replaces.edge, 'e0') &&
      is(wires[1].replaces.end, 'n1') &&
      wires[1].replaces.end.port === 'input',
    'Input reconnection failed',
  );
  await wire(port('n0', 'output'), port('n2', 'output'));
  assert(wires.length === 2, 'Incompatible output ports accepted');
  const key = (value) =>
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: value,
      }),
    );
  let current = diagram.locate(ref);
  const camera = () => JSON.stringify([diagram.camera.center, diagram.camera.scale]);
  const cameraBeforeDrag = camera();
  pointer('pointerdown', current);
  pointer('pointermove', [current[0], current[1] + 16]);
  await render();
  assert(camera() === cameraBeforeDrag, 'Auto-fit moved the camera during a drag');
  // Escape ends the drag in progress without committing it.
  key('Escape');
  pointer('pointerup', [current[0], current[1] + 16]);
  await settle();
  assert(moveCount === 1, 'Escape committed a cancelled movement');
  await render();
  current = diagram.locate(ref);
  pointer('pointerdown', current);
  pointer('pointermove', [current[0], current[1] + 16]);
  diagram.set({ vertices: { Task: { shape: 'rounded' } } });
  pointer('pointerup', [current[0], current[1] + 16]);
  await settle();
  assert(moveCount === 1, 'Data replacement committed a stale gesture');
  diagram.select([ref]);
  key('ArrowDown');
  await settle();
  assert(moveCount === 2 && is(moved.moves[0].vertex, 'n0'), 'Keyboard movement failed');
  let opened, removed;
  diagram.on('open', (item) => {
    opened = item;
  });
  diagram.on('delete', (items) => {
    removed = items;
  });
  key('Enter');
  key('Delete');
  await settle();
  assert(is(opened, 'n0') && is(removed?.[0], 'n0'), 'Keyboard action proposals failed');
  key('Escape');
  await render();
  diagram.set({ input: { canConnect: () => false } });
  await wire(port('n1', 'output'), port('n4', 'input'));
  assert(wires.length === 2, 'Application connect policy was ignored');
  // A composition presents its views, so the diagram leaves its canvas until the end.
  diagram.set({ canvas: null, input: { canConnect: null } });
  const before = diagram.stats().frames;
  for (const shape of ['rectangle', 'rounded', 'ellipse', 'diamond']) {
    diagram.set({ vertices: { Task: { shape } } });
    await render();
  }
  diagram.set({ vertices: { Task: { shape: 'rectangle', shade: 'weight' } }, grid: false });
  const shaded = await decode(await render()),
    sample = diagram.locate(ref),
    at = (Math.floor(sample[1]) * 1000 + Math.floor(sample[0])) * 4;
  assert(
    shaded[at] + shaded[at + 1] + shaded[at + 2] > 100,
    'Shade values must not implicitly change opacity',
  );
  diagram.set({
    shade: {
      wgsl: 'fn shade(f: ShadeFragment) -> vec4f { return vec4f(mix(f.color.rgb, vec3f(0.2, 0.8, 0.5), f.value), f.color.a); }',
    },
  });
  await applied();
  await render();
  diagram.set({ shade: null, grid: true, vertices: { Task: { shade: null } } });
  await applied();
  const second = createDiagram(gpu, config);
  const composition = createComposition(gpu, {
    views: [
      { view: diagram, region: [0, 0, 0.5, 1] },
      { view: second, region: [0.5, 0, 0.5, 1] },
    ],
  });
  // Read actual offscreen pixels; a non-background image must have been drawn.
  const pixels = await decode(await composition.image({ width: 1000, height: 620, pixelRatio: 1 }));
  composition.destroy();
  second.destroy();
  let bright = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] > 90 || pixels[i + 1] > 90 || pixels[i + 2] > 90) bright++;
  assert(bright > 1000, 'Diagram contains no visible geometry');
  assert(diagram.stats().frames >= before + 5, 'Frame lifecycle failed');
  const frames = diagram.stats().frames;
  diagram.set({ canvas, paused: false, vertices: { Task: { shape: 'rounded' } } });
  diagram.fit();
  await presented(frames);
  // The shared input: hover, the context menu, wheel zoom, and Home.
  const once = (event, accept = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('No ' + event + ' event'));
      }, 5000);
      const off = diagram.on(event, (value) => {
        if (!accept(value)) return;
        clearTimeout(timer);
        off();
        resolve(value);
      });
    });
  diagram.set({ hover: 'on' });
  const target = diagram.locate(ref),
    client = { clientX: rect.left + target[0], clientY: rect.top + target[1] };
  const hovered = once('hover', (item) => item !== null);
  pointer('pointermove', target, { buttons: 0 });
  assert(is(await hovered, 'n0'), 'Hover missed the vertex');
  const menu = once('contextmenu');
  canvas.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...client }),
  );
  const opened2 = await menu;
  assert(
    opened2.trigger === 'pointer' && is(opened2.items[0], 'n0'),
    'Context menu missed the vertex',
  );
  const scale = diagram.camera.scale;
  canvas.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, ...client }),
  );
  assert(diagram.camera.scale > scale && !diagram.camera.fit, 'Wheel did not zoom');
  key('Home');
  assert(diagram.camera.fit, 'Home did not fit');
  const fitted = diagram.stats().frames;
  await presented(fitted);
  await gpu.idle();
  if (failure) throw failure;
  assert(errors.length === 0, errors.join('\n'));
  const result = {
    status: 'passed',
    vertices: diagram.stats().vertices,
    edges: diagram.stats().edges,
    ends: diagram.stats().ends,
    brightPixels: bright,
    drawCalls: diagram.stats().drawCalls,
    input: true,
    gestures: [
      'select',
      'additive click',
      'drag threshold',
      'move',
      'connect',
      'reconnect',
      'port click',
      'connect policy',
      'cancel',
      'replace',
      'keyboard',
      'hover',
      'context menu',
      'wheel',
      'home',
    ],
    shapes: 4,
    shade: true,
    composition: true,
    errors,
  };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  // Keep the final canvas for the runner's screenshot.
  globalThis.diagramFixture = { gpu, diagram, source };
  return result;
})();
