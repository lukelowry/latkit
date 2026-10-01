/* global document, PointerEvent, KeyboardEvent, GPUBufferUsage, GPUMapMode */
import { createGpu, createCanvasView, createRenderTarget, createComposition } from '@latkit/gpu';
import { createDiagram, attachDiagramInput } from '../../dist/index.js';
import { Source, data } from '/output/diagram-fixture.js';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
globalThis.diagramCheck = (async () => {
  const errors = [];
  const gpu = await createGpu();
  gpu.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const source = new Source(5);
  source.names = ['Load data', 'Validate α', 'Transform', 'Compute', 'Publish'];
  source.ends.push([
    { node: 0, port: 'output', role: 'source' },
    { node: 2, port: 'input', role: 'target' },
    { node: 4, port: 'input', role: 'target' },
  ]);
  const config = data(source);
  const diagram = createDiagram({ gpu, data: config, options: { msaa: 4 } });
  const canvas = document.querySelector('canvas');
  let resolve, reject;
  let rendered = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const view = createCanvasView({
    gpu,
    canvas,
    renderer: diagram,
    onError: (error) => reject(error),
    onRendered: () => resolve(),
  });
  const detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
  view.request({ timeMs: 0 });
  await rendered;
  await gpu.idle();
  const ref = { kind: 'component', type: 'Task', id: 'n0' },
    point = diagram.locate(ref);
  assert(point && diagram.hitTest(point).some((h) => h.id === 'n0'), 'Presented picking failed');
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
  assert(selections > 0, 'Input selection failed');
  const another = diagram.locate({ kind: 'component', type: 'Task', id: 'n2' });
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    pointer('pointerdown', another, modifiers);
    pointer('pointerup', another, modifiers);
    assert(
      selection.length === 2 && selection.some((item) => item.id === 'n2'),
      'Additive click did not add exactly once',
    );
    pointer('pointerdown', another, modifiers);
    pointer('pointerup', another, modifiers);
    assert(
      selection.length === 1 && selection[0].id === 'n0',
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
      diagram.setComponent(type, { position });
  });
  pointer('pointerdown', point);
  pointer('pointermove', [point[0], point[1] + 32]);
  pointer('pointerup', [point[0], point[1] + 32]);
  assert(moved?.moves.length === 1, 'Move proposal failed');
  view.pause();
  const target = createRenderTarget({ gpu, width: 1000, height: 620 });
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0, completion: 'complete' });
  await gpu.idle();
  const port = (id, name) => {
    const point = diagram.locate({ kind: 'port', type: 'Task', id, port: name });
    assert(point, 'Missing port ' + id + '.' + name);
    return point;
  };
  const wires = [];
  diagram.on('connect', (proposal) => wires.push(proposal));
  const wire = (a, b) => {
    pointer('pointerdown', a);
    pointer('pointermove', b);
    pointer('pointerup', b);
  };
  wire(port('n1', 'output'), port('n1', 'output'));
  assert(wires.length === 0, 'Port click unexpectedly created a connection');
  wire(port('n1', 'output'), port('n4', 'input'));
  assert(
    wires.length === 1 && wires[0].from.id === 'n1' && wires[0].to.id === 'n4',
    'Connection proposal failed',
  );
  wire(port('n1', 'input'), port('n3', 'input'));
  assert(
    wires.length === 2 &&
      wires[1].from.id === 'n0' &&
      wires[1].replaces.connection.id === 'e0' &&
      wires[1].replaces.endpoint.ordinal === 1 &&
      wires[1].replaces.endpoint.index.type === 'Dependency',
    'Endpoint reconnection failed',
  );
  wire(port('n0', 'output'), port('n2', 'output'));
  assert(wires.length === 2, 'Incompatible output ports accepted');
  const key = (value) =>
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: value,
      }),
    );
  let current = diagram.locate(ref);
  const cameraBeforeDrag = diagram.getCamera();
  pointer('pointerdown', current);
  pointer('pointermove', [current[0], current[1] + 16]);
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  assert(
    JSON.stringify(diagram.getCamera()) === JSON.stringify(cameraBeforeDrag),
    'Auto-fit moved the camera during a drag',
  );
  key('Escape');
  pointer('pointerup', [current[0], current[1] + 16]);
  assert(moveCount === 1, 'Escape committed a cancelled movement');
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  current = diagram.locate(ref);
  pointer('pointerdown', current);
  pointer('pointermove', [current[0], current[1] + 16]);
  diagram.setComponent('Task', { shape: 'rounded' });
  pointer('pointerup', [current[0], current[1] + 16]);
  assert(moveCount === 1, 'Data replacement committed a stale gesture');
  diagram.select([ref]);
  key('ArrowDown');
  assert(moveCount === 2 && moved.moves[0].component.id === 'n0', 'Keyboard movement failed');
  let opened, removed;
  diagram.on('open', (item) => {
    opened = item;
  });
  diagram.on('delete', (ids) => {
    removed = ids;
  });
  key('Enter');
  key('Delete');
  assert(opened?.id === 'n0' && removed?.[0] === 'n0', 'Keyboard action proposals failed');
  key('Escape');
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  detach();
  const detachPolicy = attachDiagramInput({
    diagram,
    canvas,
    interaction: 'edit',
    canConnect: () => false,
  });
  wire(port('n1', 'output'), port('n4', 'input'));
  assert(wires.length === 2, 'Application connection policy was ignored');
  detachPolicy();
  const before = diagram.stats().frames;
  for (const shape of ['rectangle', 'rounded', 'ellipse', 'diamond']) {
    diagram.setComponent('Task', { shape });
    await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  }
  diagram.setComponent('Task', { shape: 'rectangle', shade: 'weight' });
  diagram.setOptions({ grid: false });
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  const sample = diagram.locate(ref);
  const pixelBuffer = gpu.device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const sampleEncoder = gpu.device.createCommandEncoder();
  sampleEncoder.copyTextureToBuffer(
    { texture: target.texture(), origin: [Math.floor(sample[0]), Math.floor(sample[1])] },
    { buffer: pixelBuffer, bytesPerRow: 256 },
    [1, 1],
  );
  gpu.device.queue.submit([sampleEncoder.finish()]);
  await pixelBuffer.mapAsync(GPUMapMode.READ);
  const pixel = new Uint8Array(pixelBuffer.getMappedRange());
  assert(pixel[0] + pixel[1] + pixel[2] > 100, 'Shade values must not implicitly change opacity');
  pixelBuffer.unmap();
  pixelBuffer.destroy();
  await diagram.setShade({
    wgsl: 'fn shade(f: ShadeFragment) -> vec4f { return vec4f(mix(f.color.rgb, vec3f(0.2, 0.8, 0.5), f.value), f.color.a); }',
  });
  await gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  await diagram.setShade(null);
  diagram.setComponent('Task', { shade: null });
  diagram.setOptions({ grid: true });
  const second = createDiagram({ gpu, data: config });
  const composition = createComposition({
    gpu,
    views: [
      { renderer: diagram, region: { x: 0, y: 0, width: 0.5, height: 1 } },
      { renderer: second, region: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ],
  });
  await gpu.render({ views: [{ renderer: composition, target }], timeMs: 0 });
  composition.destroy();
  second.destroy();
  // Read actual offscreen pixels; a non-background image must have been drawn.
  const rowBytes = 4096,
    buffer = gpu.device.createBuffer({
      size: rowBytes * 620,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  const encoder = gpu.device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target.texture() },
    { buffer, bytesPerRow: rowBytes },
    [1000, 620],
  );
  gpu.device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(buffer.getMappedRange());
  let bright = 0;
  for (let y = 0; y < 620; y++)
    for (let x = 0; x < 1000; x++) {
      const i = y * rowBytes + x * 4;
      if (pixels[i] > 90 || pixels[i + 1] > 90 || pixels[i + 2] > 90) bright++;
    }
  buffer.unmap();
  buffer.destroy();
  assert(bright > 1000, 'Diagram contains no visible geometry');
  assert(diagram.stats().frames >= before + 5, 'Frame lifecycle failed');
  diagram.setComponent('Task', { shape: 'rounded' });
  diagram.fit();
  rendered = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  view.resume();
  view.request({ timeMs: 0 });
  await rendered;
  await gpu.idle();
  assert(errors.length === 0, errors.join('\n'));
  const result = {
    status: 'passed',
    components: diagram.stats().components,
    connections: diagram.stats().connections,
    endpoints: diagram.stats().endpoints,
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
      'connection policy',
      'cancel',
      'replace',
      'keyboard',
    ],
    shapes: 4,
    shade: true,
    composition: true,
    errors,
  };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  // Keep the final canvas for the runner's screenshot.
  globalThis.diagramFixture = { gpu, diagram, view, source, detach, target };
  return result;
})();
