import { createGpu, createCanvasView, createRenderTarget } from '@latkit/gpu';
import { numberAt, rowAt, rowCount } from '@latkit/model';
import { createDiagram, attachDiagramInput, arrange } from '@latkit/diagram';
import type {
  DiagramItem,
  InputOptions,
  LayoutOptions,
  Options,
  Shape,
  Point,
} from '@latkit/diagram';
import { GraphSource } from './source.js';
import {
  preset,
  presets,
  types,
  History,
  addBlock,
  connectGraph,
  deleteItems,
  moveGraph,
} from './graph.js';
import type { Graph, NodeType, Preset } from './graph.js';
import { data, effect, theme } from './presentation.js';
import type { Settings } from './presentation.js';
import './style.css';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const select = (id: string) => $<HTMLSelectElement>('#' + id);
const check = (id: string) => $<HTMLInputElement>('#' + id);
const canvas = $<HTMLCanvasElement>('#canvas');
const errors: string[] = [];
function message(text: string, log = true) {
  $('#message').textContent = text;
  if (log) {
    const li = document.createElement('li');
    li.textContent = text;
    $('#activity').prepend(li);
    while ($('#activity').children.length > 5) $('#activity').lastElementChild?.remove();
  }
}
function report(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  const text = error instanceof Error ? error.message : String(error);
  errors.push(text);
  message(text);
  $('#error-detail').textContent =
    text + ' Reset the scene to recover. WebGPU requires a supported browser and graphics device.';
  $('#error').hidden = false;
}
function tab(name: string) {
  for (const id of ['inspect', 'features', 'api']) {
    $('#tab-' + id).hidden = id !== name;
    document
      .querySelector('[data-tab="' + id + '"]')
      ?.setAttribute('aria-pressed', String(id === name));
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]'))
  button.onclick = () => tab(button.dataset.tab!);
$('#toggle-controls').onclick = () => {
  const expanded = document.body.classList.toggle('show-controls');
  $('#toggle-controls').setAttribute('aria-expanded', String(expanded));
  if (expanded) $('.sidebar').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
const code = `const gpu = await createGpu();

const diagram = createDiagram({
  gpu,
  data: {
    source: model,
    components: {
      Process: {
        position: 'position',
        labels: { field: 'name' },
      },
    },
    connections: {
      Signal: {
        route: 'orthogonal',
        arrows: ['target'],
      },
    },
  },
});

const view = createCanvasView({
  gpu, canvas, renderer: diagram,
  onError: console.error,
});

attachDiagramInput({
  canvas, diagram,
  interaction: 'edit',
});

diagram.on('move', acceptMove);
diagram.on('connect', acceptWire);
view.request();`;
$('#api-code').textContent = code;
const shapeIcon = (type: NodeType) => {
  const drawing =
    type === 'Input'
      ? '<ellipse cx="12" cy="9" rx="9" ry="6"/>'
      : type === 'Control'
        ? '<path d="m12 2 10 7-10 7L2 9Z"/>'
        : '<rect x="3" y="3" width="18" height="12" rx="' +
          (type === 'Process' ? '3' : '0') +
          '"/>';
  return '<svg viewBox="0 0 24 18" aria-hidden="true">' + drawing + '</svg>';
};
async function boot() {
  const gpu = await createGpu();
  gpu.device.addEventListener('uncapturederror', (event) => report(event.error));
  const compact = matchMedia('(max-width: 650px)');
  let active: Preset = 'loop',
    history = new History(preset(active, compact.matches));
  const source = new GraphSource(history.current);
  let selected: readonly DiagramItem[] = [];
  let lastFrames = -1,
    busy = false,
    pointerDown = false;
  const settings = (): Settings => ({
    shape: select('shape').value as 'mixed' | Shape,
    route: select('route').value as Settings['route'],
    appearance: select('appearance').value as Settings['appearance'],
    palette: select('palette').value as Settings['palette'],
    flow: check('flow').checked,
    arrows: check('arrows').checked,
    status: check('status').checked,
    labels: check('labels').checked,
  });
  const options = (): Options => ({
    ...theme,
    grid: check('grid').checked,
    snap: check('snap').checked,
    labels: check('labels').checked,
    junctions: check('junctions').checked,
    motion: select('motion').value as Options['motion'],
    msaa: Number(select('msaa').value) as 1 | 4,
    hover: select('hover').value as Options['hover'],
    fitPaddingPx: innerWidth <= 650 ? 24 : 44,
  });
  const binding = (automatic = false) => {
    const value = data(source, settings(), automatic);
    return {
      ...value,
      components: Object.fromEntries(
        Object.entries(value.components).map(([type, component]) => [
          type,
          {
            ...component,
            labels: component.labels
              ? { ...component.labels, overflow: select('overflow').value as 'wrap' | 'ellipsis' }
              : null,
          },
        ]),
      ),
    };
  };
  const diagram = createDiagram({ gpu, data: binding(), options: options() });
  const view = createCanvasView({
    gpu,
    canvas,
    renderer: diagram,
    onError: report,
    onRendered: () => {
      $('#loading').hidden = true;
      $('#engine-state').textContent = 'WebGPU ready';
      $('#engine-state').classList.add('ready');
      syncMetrics();
    },
  });
  let detach = attachDiagramInput({ diagram, canvas, interaction: 'edit' });
  const bindInput = () => {
    detach();
    detach = attachDiagramInput({
      diagram,
      canvas,
      interaction: select('mode').value as InputOptions['interaction'],
    });
    message(select('mode').selectedOptions[0].text + ' mode');
  };
  select('mode').onchange = bindInput;
  function historyButtons() {
    document.querySelectorAll<HTMLButtonElement>('[data-action="undo"]').forEach((button) => {
      button.disabled = !history.canUndo;
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action="redo"]').forEach((button) => {
      button.disabled = !history.canRedo;
    });
  }
  function refresh() {
    $('#error').hidden = true;
    source.publish(history.current);
    diagram.setData(binding());
    historyButtons();
    showGroups();
    inspect();
  }
  function commit(graph: Graph, description: string) {
    history.commit(graph);
    refresh();
    message(description);
  }
  function choosePreset(id: Preset) {
    active = id;
    history = new History(preset(id, compact.matches));
    selected = [];
    select('shape').value = id === 'shapes' ? 'mixed' : 'rounded';
    select('appearance').value = 'wire';
    select('route').value = 'orthogonal';
    check('simulate').checked = false;
    diagram.select([]);
    refresh();
    diagram.fit();
    const entry = presets.find((item) => item.id === id)!;
    $('#scene-title').textContent = entry.name;
    $('#scene-description').textContent = entry.description;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]'))
      button.setAttribute('aria-pressed', String(button.dataset.preset === id));
    message(entry.name + ' loaded');
  }
  for (const entry of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.preset = entry.id;
    button.setAttribute('aria-pressed', String(entry.id === active));
    const title = document.createElement('strong'),
      subtitle = document.createElement('small');
    title.textContent = entry.name;
    subtitle.textContent = entry.description;
    button.append(title, subtitle);
    button.onclick = () => choosePreset(entry.id);
    $('#presets').append(button);
  }
  function add(type: NodeType, point?: Point) {
    const world = point ??
      diagram.toDiagram([canvas.clientWidth / 2, canvas.clientHeight / 2]) ?? [0, 0];
    const result = addBlock(history.current, type, world);
    commit(result.graph, 'Added ' + type.toLowerCase());
    selected = [{ kind: 'component', type, id: result.node.id }];
    diagram.select(selected);
    inspect();
  }
  for (const type of types) {
    const button = document.createElement('button');
    button.innerHTML = shapeIcon(type);
    button.append(document.createTextNode(type));
    button.draggable = true;
    button.onclick = () => add(type);
    button.ondragstart = (event) =>
      event.dataTransfer?.setData('application/x-latkit-component', type);
    $('#palette-buttons').append(button);
  }
  canvas.ondragover = (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  canvas.ondrop = (event) => {
    event.preventDefault();
    const type = event.dataTransfer?.getData('application/x-latkit-component') as NodeType;
    if (!types.includes(type)) return;
    const rect = canvas.getBoundingClientRect();
    add(
      type,
      diagram.toDiagram([event.clientX - rect.left, event.clientY - rect.top]) ?? undefined,
    );
  };
  function showGroups() {
    const entries = Object.entries(history.current.groups);
    $('#group-section').hidden = !entries.length;
    $('#groups').replaceChildren();
    for (const [id, group] of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-expanded', String(!group.collapsed));
      const label = document.createElement('span'),
        action = document.createElement('span');
      label.textContent = group.label ?? id;
      action.textContent = group.collapsed ? 'Expand' : 'Collapse';
      button.append(label, action);
      button.onclick = () =>
        commit(
          {
            ...history.current,
            groups: { ...history.current.groups, [id]: { ...group, collapsed: !group.collapsed } },
          },
          (group.collapsed ? 'Expanded ' : 'Collapsed ') + label.textContent,
        );
      $('#groups').append(button);
    }
  }
  function inspect() {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]'))
      button.disabled = !selected.some(
        (item) => item.kind === 'component' || item.kind === 'connection',
      );
    const item = selected[0];
    $('#selection-empty').hidden = !!item;
    $('#selection-form').hidden = !item;
    if (!item) return;
    const node = history.current.nodes.find((n) => n.id === item.id);
    const wire = history.current.wires.find((n) => n.id === item.id);
    const group = history.current.groups[item.id];
    $('#selected-name').textContent = node?.name ?? wire?.name ?? group?.label ?? item.id;
    $('#selected-type').textContent =
      item.kind === 'group'
        ? 'Presentation group'
        : item.type +
          ' · ' +
          item.kind +
          (selected.length > 1 ? ' · ' + selected.length + ' selected' : '');
    const input = check('rename');
    if (document.activeElement !== input)
      input.value = node?.name ?? wire?.name ?? group?.label ?? '';
    input.disabled = item.kind === 'port';
    const entries = node
      ? [
          ['Identity', node.id],
          ['Position', node.position.map((v) => Math.round(v)).join(', ')],
          ['Signal', node.signal.toFixed(2)],
          ['Status', node.status ? 'Attention' : 'Normal'],
        ]
      : wire
        ? [
            ['Identity', wire.id],
            ['Endpoints', String(wire.ends.length)],
            ['Routing', select('route').selectedOptions[0].text],
          ]
        : [
            ['Identity', item.id],
            ['State', group?.collapsed ? 'Collapsed' : 'Expanded'],
          ];
    $('#selection-details').replaceChildren();
    for (const [key, value] of entries) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = key;
      dd.textContent = value;
      $('#selection-details').append(dt, dd);
    }
  }
  $('#selection-form').onsubmit = (event) => event.preventDefault();
  check('rename').onchange = () => {
    const item = selected[0],
      name = check('rename').value.trim();
    if (!item || !name) return;
    const graph = history.current;
    commit(
      {
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === item.id ? { ...node, name } : node)),
        wires: graph.wires.map((wire) => (wire.id === item.id ? { ...wire, name } : wire)),
        groups:
          item.kind === 'group'
            ? { ...graph.groups, [item.id]: { ...graph.groups[item.id], label: name } }
            : graph.groups,
      },
      'Renamed ' + name,
    );
  };
  diagram.on('select', (items) => {
    selected = items;
    inspect();
    $('#hovered').textContent = items.length ? items.length + ' selected' : 'No selection';
  });
  diagram.on('move', (proposal) =>
    commit(
      moveGraph(history.current, proposal),
      'Moved ' + proposal.moves.length + (proposal.moves.length === 1 ? ' block' : ' blocks'),
    ),
  );
  diagram.on('connect', (proposal) => {
    try {
      commit(
        connectGraph(history.current, proposal),
        proposal.replaces ? 'Reconnected endpoint' : 'Connected signal',
      );
    } catch (error) {
      message(error instanceof Error ? error.message : String(error));
    }
  });
  diagram.on('delete', (ids) => {
    if (ids.length) {
      commit(deleteItems(history.current, ids), 'Removed selection');
      selected = [];
      diagram.select([]);
      inspect();
    }
  });
  diagram.on('open', (item) => {
    selected = [item];
    diagram.select(selected);
    tab('inspect');
    inspect();
    check('rename').focus();
    check('rename').select();
  });
  diagram.on('hover', (item) => {
    $('#hovered').textContent = item
      ? item.kind === 'port'
        ? item.port + ' · ' + item.id
        : item.id
      : selected.length
        ? selected.length + ' selected'
        : 'No selection';
  });
  diagram.on('contextmenu', (event) => {
    if (event.items[0]) {
      selected = [event.items[0]];
      diagram.select(selected);
      inspect();
    }
    const menu = $('#context-menu'),
      rect = canvas.getBoundingClientRect();
    menu.style.left = Math.min(innerWidth - 195, rect.left + event.point[0]) + 'px';
    menu.style.top = Math.min(innerHeight - 140, rect.top + event.point[1]) + 'px';
    menu.showPopover();
  });
  async function layout() {
    if (busy) return;
    busy = true;
    const version = source.version;
    const button = $<HTMLButtonElement>('[data-action="arrange"]');
    button.disabled = true;
    button.textContent = 'Arranging…';
    try {
      const algorithm: LayoutOptions['algorithm'] =
        select('algorithm').value === 'grid'
          ? {
              arrange: ({ nodes }) => {
                const columns = Math.ceil(Math.sqrt(nodes.length));
                const width = Math.max(220, ...nodes.map((node) => node.size[0] + 64));
                const height = Math.max(160, ...nodes.map((node) => node.size[1] + 64));
                return nodes.map((_, i) => [
                  (i % columns) * width,
                  Math.floor(i / columns) * height,
                ]);
              },
            }
          : 'layered';
      const fields = await arrange({
        data: binding(true),
        options: options(),
        layout: {
          algorithm,
          direction: select('direction').value as LayoutOptions['direction'],
          rankGap: 72,
          nodeGap: 48,
        },
        measureText: (input, request) => gpu.measureText(input, request),
      });
      if (source.version !== version) {
        message('Scene changed during layout. Arrange again.');
        return;
      }
      const updated = new Map<string, Point>();
      for (const [type, field] of Object.entries(fields)) {
        if (field.values.kind !== 'vector') continue;
        const values = field.values;
        const nodes = history.current.nodes.filter((node) => node.type === type);
        for (let i = 0; i < rowCount(field.rows); i++)
          updated.set(nodes[rowAt(field.rows, i)].id, [
            numberAt(values.values, i * 2)!,
            numberAt(values.values, i * 2 + 1)!,
          ]);
      }
      commit(
        {
          ...history.current,
          nodes: history.current.nodes.map((node) => ({
            ...node,
            position: updated.get(node.id) ?? node.position,
          })),
        },
        'Applied ' + select('algorithm').selectedOptions[0].text.toLowerCase() + ' layout',
      );
      diagram.fit({ animate: true });
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'Arrange';
    }
  }
  async function exportImage(download = true): Promise<Blob> {
    const fixed = await source.retain();
    const renderer = createDiagram({
      gpu,
      data: { ...binding(), source: fixed },
      options: { ...options(), motion: 'reduce', fitPaddingPx: 64 },
    });
    const width = 2048,
      height = 1280,
      rowBytes = Math.ceil((width * 4) / 256) * 256;
    const target = createRenderTarget({ gpu, width, height, format: 'rgba8unorm' });
    let buffer: GPUBuffer | undefined;
    try {
      await renderer.setShade(effect(select('shade').value));
      await gpu.render({ views: [{ renderer, target }], timeMs: 0, completion: 'complete' });
      buffer = gpu.device.createBuffer({
        size: rowBytes * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = gpu.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target.texture() },
        { buffer, bytesPerRow: rowBytes },
        [width, height],
      );
      gpu.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8ClampedArray(width * height * 4),
        bytes = new Uint8Array(buffer.getMappedRange());
      for (let y = 0; y < height; y++)
        pixels.set(bytes.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
      buffer.unmap();
      const image = new OffscreenCanvas(width, height);
      image.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
      const blob = await image.convertToBlob({ type: 'image/png' });
      if (download) {
        const url = URL.createObjectURL(blob),
          anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'latkit-' + active + '.png';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message('Exported 2048 × 1280 PNG');
      }
      return blob;
    } finally {
      buffer?.destroy();
      renderer.destroy();
      target.destroy();
      await fixed.close();
    }
  }
  const actions: Record<string, () => void | Promise<unknown>> = {
    undo: () => {
      if (history.canUndo) {
        history.undo();
        refresh();
        message('Undid edit');
      }
    },
    redo: () => {
      if (history.canRedo) {
        history.redo();
        refresh();
        message('Redid edit');
      }
    },
    reset: () => choosePreset(active),
    fit: () => diagram.fit({ animate: true }),
    arrange: layout,
    'zoom-in': () => diagram.zoomBy(1.25),
    'zoom-out': () => diagram.zoomBy(0.8),
    delete: () => {
      const ids = selected
        .filter((item) => item.kind === 'component' || item.kind === 'connection')
        .map((item) => item.id);
      if (ids.length) {
        commit(deleteItems(history.current, ids), 'Removed selection');
        selected = [];
        diagram.select([]);
        inspect();
      }
    },
    neighbors: () => {
      if (selected[0]) diagram.reveal(selected[0], { neighbors: true, animate: true });
    },
    export: () => exportImage(),
    retry: () => {
      $('#error').hidden = true;
      refresh();
      diagram.fit();
    },
    copy: async () => {
      await navigator.clipboard.writeText(code);
      message('Copied API example');
    },
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.disabled = false;
    button.onclick = () => {
      if ($('#context-menu').matches(':popover-open')) $('#context-menu').hidePopover();
      void Promise.resolve()
        .then(() => actions[button.dataset.action!]())
        .catch(report);
    };
  }
  for (const id of [
    'shape',
    'route',
    'appearance',
    'palette',
    'flow',
    'arrows',
    'status',
    'overflow',
  ])
    $('#' + id).onchange = () => {
      diagram.setData(binding());
      message('Updated ' + id);
    };
  for (const id of ['grid', 'snap', 'labels', 'junctions', 'msaa', 'motion', 'hover'])
    $('#' + id).onchange = () => {
      diagram.setOptions(options());
      message('Updated ' + id);
    };
  select('shade').onchange = () => {
    void diagram
      .setShade(effect(select('shade').value))
      .then(() => message('Updated shade'))
      .catch(report);
  };
  check('simulate').onchange = () => {
    if (!check('simulate').checked) source.publish(history.current);
    message(check('simulate').checked ? 'Synthetic signal values are live' : 'Live values paused');
  };
  canvas.addEventListener('pointerdown', () => {
    pointerDown = true;
  });
  window.addEventListener('pointerup', () => {
    pointerDown = false;
  });
  window.addEventListener('pointercancel', () => {
    pointerDown = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void actions[event.shiftKey ? 'redo' : 'undo']();
    }
  });
  function syncMetrics() {
    const stats = diagram.stats();
    if (stats.frames === lastFrames) return;
    lastFrames = stats.frames;
    $('#nodes').textContent = stats.components.toLocaleString();
    $('#wires').textContent = stats.connections.toLocaleString();
    $('#draws').textContent = String(stats.drawCalls);
    $('#prepare').textContent = stats.prepareMs.toFixed(1);
    $('#zoom').textContent = Math.round((diagram.getCamera()?.scale[0] ?? 1) * 100) + '%';
  }
  const timer = setInterval(() => {
    syncMetrics();
    if (check('simulate').checked && !pointerDown && !busy) {
      const time = performance.now() / 1000;
      source.publish({
        ...history.current,
        nodes: history.current.nodes.map((node, i) => ({
          ...node,
          signal: (Math.sin(time + i * 0.7) + 1) / 2,
        })),
        wires: history.current.wires.map((wire, i) => ({
          ...wire,
          signal: (Math.sin(time + i * 0.4) + 1) / 2,
        })),
      });
    }
  }, 250);
  const resize = () => {
    diagram.setOptions({ fitPaddingPx: compact.matches ? 24 : 44 });
    if (!history.canUndo) choosePreset(active);
  };
  compact.addEventListener('change', resize);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    clearInterval(timer);
    compact.removeEventListener('change', resize);
    detach();
    view.destroy();
    diagram.destroy();
    gpu.destroy();
    void source.close();
  });
  $<HTMLFieldSetElement>('#controls').disabled = false;
  select('mode').disabled = false;
  historyButtons();
  inspect();
  view.request();
  message('Control loop ready. Drag a port to make a connection.', false);
  return { gpu, diagram, source, view, errors, choosePreset, exportImage };
}
const ready = boot().catch((error: unknown) => {
  $('#loading').hidden = true;
  $('#error button').onclick = () => location.reload();
  report(error);
  throw error;
});
Object.assign(window, { diagramStudioReady: ready });
