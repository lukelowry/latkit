import { createGpu, type LayoutOptions, type Point } from '@latkit/gpu';
import { itemId } from '@latkit/model';
import { createDiagram, arrange } from '@latkit/diagram';
import type { DiagramConfig, DiagramInput, DiagramItem, Shape } from '@latkit/diagram';
import { GraphSource } from './source.js';
import {
  plugged,
  preset,
  presets,
  types,
  History,
  addBlock,
  connectGraph,
  deleteItems,
  placeGraph,
} from './graph.js';
import type { BlockType, Graph, Preset } from './graph.js';
import { data, effect, theme } from './presentation.js';
import type { Settings, Style } from './presentation.js';
import './style.css';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const select = (id: string) => $<HTMLSelectElement>('#' + id);
/** The graph id of a diagram item: a block's or wire's row id, or a group's name. */
const idOf = (item: DiagramItem) => (item.kind === 'group' ? item.id : itemId(item));
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
const narrow = matchMedia('(max-width: 650px)');
const systemTheme = matchMedia('(prefers-color-scheme: light)');
$('#toggle-controls').setAttribute('aria-expanded', String(!narrow.matches));
$('#toggle-controls').onclick = () => {
  const expanded = narrow.matches
    ? document.body.classList.toggle('show-controls')
    : !document.body.classList.toggle('hide-controls');
  $('#toggle-controls').setAttribute('aria-expanded', String(expanded));
};
function showInspector(open: boolean) {
  document.body.classList.toggle('show-inspector', open);
  $('#toggle-inspector').setAttribute('aria-expanded', String(open));
}
$('#toggle-inspector').onclick = () =>
  showInspector(!document.body.classList.contains('show-inspector'));
function lightTheme() {
  return (
    select('theme').value === 'light' || (select('theme').value === 'system' && systemTheme.matches)
  );
}
const code = `const gpu = await createGpu();

const diagram = createDiagram(gpu, {
  canvas,
  input: 'edit',
  source: model.data,
  vertices: {
    Process: {
      x: 'position',
      y: { field: 'position', component: 1 },
      labels: 'name',
    },
  },
  edges: {
    Signal: {
      route: 'orthogonal',
      arrows: true,
    },
  },
});

diagram.on('move', acceptMove);
diagram.on('connect', acceptWire);`;
$('#api-code').textContent = code;
const shapeIcon = (type: BlockType) => {
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
    light: lightTheme(),
    density: select('density').value as Settings['density'],
    titlePosition: select('title-position').value as Settings['titlePosition'],
    route: select('route').value as Settings['route'],
    appearance: select('appearance').value as Settings['appearance'],
    palette: select('palette').value as Settings['palette'],
    flow: check('flow').checked,
    arrows: check('arrows').checked,
    status: check('status').checked,
    labels: check('labels').checked,
    overflow: select('overflow').value as Settings['overflow'],
  });
  const options = (): Style => ({
    ...theme(lightTheme()),
    vertexPadding:
      select('density').value === 'compact' ? 8 : select('density').value === 'spacious' ? 16 : 12,
    portSpacing:
      select('density').value === 'compact' ? 20 : select('density').value === 'spacious' ? 30 : 24,
    portMarker: select('port-marker').value as DiagramConfig['portMarker'],
    portLabels: check('port-labels').checked,
    cornerRadius: Number(select('radius').value),
    detail: select('detail').value as DiagramConfig['detail'],
    grid: check('grid').checked,
    snap: check('snap').checked,
    labels: check('labels').checked,
    junctions: check('junctions').checked,
    motion: select('motion').value as DiagramConfig['motion'],
    msaa: Number(select('msaa').value) as 1 | 4,
    hover: select('hover').value as DiagramConfig['hover'],
    fitPaddingPx: innerWidth <= 650 ? [24, 28, 60, 28] : 44,
  });
  const binding = (automatic = false) => data(source, settings(), automatic);
  const input = (): DiagramInput => ({
    mode: select('mode').value as DiagramInput['mode'],
    backgroundDrag: select('background-drag').value as DiagramInput['backgroundDrag'],
    autoPan: check('auto-pan').checked,
  });
  const shades = new Map<string, ReturnType<typeof effect>>();
  const shade = (name: string) => {
    if (!shades.has(name)) shades.set(name, effect(name));
    return shades.get(name)!;
  };
  /** Everything the diagram draws, from the document and the page's controls. */
  const config = () => ({
    ...binding(),
    ...options(),
    input: input(),
    shade: shade(select('shade').value),
  });
  document.documentElement.dataset.theme = lightTheme() ? 'light' : 'dark';
  const diagram = createDiagram(gpu, { ...config(), canvas });
  /** Draw what the document and controls say; the diagram keeps whatever stays the same. */
  const show = (animate = false) => diagram.set(config(), { replace: true, animate });
  /** A canvas point in diagram units, on the grid when snapping. */
  const world = (point: Point): Point => {
    const { center, scale } = diagram.camera,
      pitch = diagram.config.gridPitch!;
    const x = center[0] + (point[0] - canvas.clientWidth / 2) / scale,
      y = center[1] + (point[1] - canvas.clientHeight / 2) / scale;
    return diagram.config.snap
      ? [Math.round(x / pitch) * pitch, Math.round(y / pitch) * pitch]
      : [x, y];
  };
  diagram.on('error', report);
  diagram.on('frame', () => {
    $('#loading').hidden = true;
    $('#engine-state').textContent = 'WebGPU ready';
    $('#engine-state').classList.add('ready');
    syncMetrics();
  });
  const bindInput = () => {
    show();
    message(select('mode').selectedOptions[0].text + ' mode');
  };
  for (const id of ['mode', 'background-drag', 'auto-pan']) $('#' + id).onchange = bindInput;
  function historyButtons() {
    document.querySelectorAll<HTMLButtonElement>('[data-action="undo"]').forEach((button) => {
      button.disabled = !history.canUndo;
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action="redo"]').forEach((button) => {
      button.disabled = !history.canRedo;
    });
  }
  function refresh(animate = false) {
    $('#error').hidden = true;
    source.publish(history.current);
    show(animate);
    historyButtons();
    showGroups();
    inspect();
  }
  function commit(graph: Graph, description: string, animate = false) {
    if (graph === history.current) return;
    history.commit(graph);
    refresh(animate);
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
  function add(type: BlockType, point: Point = [canvas.clientWidth / 2, canvas.clientHeight / 2]) {
    const result = addBlock(history.current, type, world(point));
    commit(result.graph, 'Added ' + type.toLowerCase());
    selected = [source.item(result.block.id)!];
    diagram.select(selected);
    inspect();
  }
  for (const type of types) {
    const button = document.createElement('button');
    button.innerHTML = shapeIcon(type);
    button.append(document.createTextNode(type));
    button.draggable = true;
    button.onclick = () => add(type);
    button.ondragstart = (event) => event.dataTransfer?.setData('application/x-latkit-block', type);
    $('#palette-buttons').append(button);
  }
  canvas.ondragover = (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  canvas.ondrop = (event) => {
    event.preventDefault();
    const type = event.dataTransfer?.getData('application/x-latkit-block') as BlockType;
    if (!types.includes(type)) return;
    const rect = canvas.getBoundingClientRect();
    add(type, [event.clientX - rect.left, event.clientY - rect.top]);
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
      button.disabled = !selected.some((item) => item.kind === 'vertex' || item.kind === 'edge');
    const item = selected[0];
    $('#selection-empty').hidden = !!item;
    $('#selection-form').hidden = !item;
    if (!item) return;
    const id = idOf(item);
    const block = history.current.blocks.find((n) => n.id === id);
    const wire = history.current.wires.find((n) => n.id === id);
    const group = history.current.groups[id];
    $('#selected-name').textContent = block?.name ?? wire?.name ?? group?.label ?? id;
    $('#selected-type').textContent =
      item.kind === 'group'
        ? 'Presentation group'
        : item.index.type +
          ' · ' +
          item.kind +
          (selected.length > 1 ? ' · ' + selected.length + ' selected' : '');
    const input = check('rename');
    if (document.activeElement !== input)
      input.value = block?.name ?? wire?.name ?? group?.label ?? '';
    input.disabled = item.kind === 'port';
    const entries = block
      ? [
          ['Identity', block.id],
          ['Position', block.position.map((v) => Math.round(v)).join(', ')],
          ['Signal', block.signal.toFixed(2)],
          ['Status', block.status ? 'Attention' : 'Normal'],
        ]
      : wire
        ? [
            ['Identity', wire.id],
            ['Ports', String(plugged(history.current, wire.id).length)],
            ['Routing', select('route').selectedOptions[0].text],
          ]
        : [
            ['Identity', id],
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
    const graph = history.current,
      id = idOf(item);
    commit(
      {
        ...graph,
        blocks: graph.blocks.map((block) => (block.id === id ? { ...block, name } : block)),
        wires: graph.wires.map((wire) => (wire.id === id ? { ...wire, name } : wire)),
        groups:
          item.kind === 'group'
            ? { ...graph.groups, [id]: { ...graph.groups[id], label: name } }
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
    commit(placeGraph(history.current, proposal.positions), 'Moved blocks'),
  );
  diagram.on('connect', (proposal) => {
    try {
      commit(
        connectGraph(history.current, proposal, select('free-drop').value === 'create'),
        proposal.replaces
          ? proposal.to
            ? 'Reconnected input'
            : 'Disconnected input'
          : 'Connected signal',
      );
    } catch (error) {
      message(error instanceof Error ? error.message : String(error));
    }
  });
  diagram.on('delete', (rows) => {
    if (rows.length) {
      commit(deleteItems(history.current, rows.map(itemId)), 'Removed selection');
      selected = [];
      diagram.select([]);
      inspect();
    }
  });
  diagram.on('open', (item) => {
    selected = [item];
    diagram.select(selected);
    tab('inspect');
    showInspector(true);
    inspect();
    check('rename').focus();
    check('rename').select();
  });
  diagram.on('hover', (item) => {
    $('#hovered').textContent = item
      ? item.kind === 'port'
        ? item.port + ' · ' + idOf(item)
        : idOf(item)
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
    const revision = source.revision;
    const button = $<HTMLButtonElement>('[data-action="arrange"]');
    button.disabled = true;
    button.textContent = 'Arranging…';
    try {
      const choice = select('algorithm').value,
        algorithm: LayoutOptions['algorithm'] =
          choice === 'grid'
            ? {
                // Each part's blocks in rows, a cell as large as its largest block.
                arrange: ({ vertices, input }) => {
                  const columns = Math.ceil(Math.sqrt(vertices.length));
                  let width = 220,
                    height = 160;
                  for (const v of vertices) {
                    width = Math.max(width, input.sizes![v * 2] + 64);
                    height = Math.max(height, input.sizes![v * 2 + 1] + 64);
                  }
                  return Array.from(vertices).flatMap((_, i) => [
                    (i % columns) * width,
                    Math.floor(i / columns) * height,
                  ]);
                },
              }
            : choice === 'stress'
              ? 'stress'
              : 'layered';
      const fields = await arrange(gpu, {
        ...binding(true),
        ...options(),
        layout: {
          algorithm,
          direction: select('direction').value as LayoutOptions['direction'],
          rankGap: 72,
          vertexGap: 48,
        },
      });
      if (source.revision !== revision) {
        message('Scene changed during layout. Arrange again.');
        return;
      }
      commit(
        placeGraph(history.current, fields),
        'Applied ' + select('algorithm').selectedOptions[0].text.toLowerCase() + ' layout',
        true,
      );
      diagram.fit(undefined, { animate: true });
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'Arrange';
    }
  }
  async function exportImage(download = true): Promise<Blob> {
    const fixed = source.data;
    const offscreen = createDiagram(gpu, {
      ...binding(),
      ...options(),
      source: fixed,
      motion: 'reduce',
      fitPaddingPx: 64,
      shade: effect(select('shade').value),
    });
    try {
      const blob = await offscreen.image({ width: 2048, height: 1280 });
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
      offscreen.destroy();
    }
  }
  const actions: Record<string, () => void | Promise<unknown>> = {
    undo: () => {
      if (history.canUndo) {
        history.undo();
        refresh(true);
        message('Undid edit');
      }
    },
    redo: () => {
      if (history.canRedo) {
        history.redo();
        refresh(true);
        message('Redid edit');
      }
    },
    reset: () => choosePreset(active),
    fit: () => diagram.fit(undefined, { animate: true }),
    arrange: layout,
    'zoom-in': () => diagram.set({ camera: { scale: diagram.camera.scale * 1.25 } }),
    'zoom-out': () => diagram.set({ camera: { scale: diagram.camera.scale * 0.8 } }),
    delete: () => {
      const ids = selected
        .filter((item) => item.kind === 'vertex' || item.kind === 'edge')
        .map(idOf);
      if (ids.length) {
        commit(deleteItems(history.current, ids), 'Removed selection');
        selected = [];
        diagram.select([]);
        inspect();
      }
    },
    neighbors: () => {
      if (selected[0]) diagram.fit(diagram.neighborhood(selected[0]), { animate: true });
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
    'title-position',
  ])
    $('#' + id).onchange = () => {
      show();
      message('Updated ' + id);
    };
  for (const id of [
    'grid',
    'snap',
    'labels',
    'junctions',
    'msaa',
    'motion',
    'hover',
    'port-labels',
    'port-marker',
    'radius',
    'detail',
  ])
    $('#' + id).onchange = () => {
      show();
      message('Updated ' + id);
    };
  const updateTheme = () => {
    document.documentElement.dataset.theme = lightTheme() ? 'light' : 'dark';
    show();
  };
  select('theme').onchange = updateTheme;
  systemTheme.addEventListener('change', updateTheme);
  select('density').onchange = () => show();
  select('shade').onchange = () => {
    show();
    message('Updated shade');
  };
  check('simulate').onchange = () => {
    if (!check('simulate').checked) source.publish(history.current);
    diagram.set({ source: source.data });
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
    $('#blocks').textContent = stats.vertices.toLocaleString();
    $('#wires').textContent = stats.edges.toLocaleString();
    $('#draws').textContent = String(stats.drawCalls);
    $('#prepare').textContent = stats.prepareMs.toFixed(1);
    $('#zoom').textContent = Math.round(diagram.camera.scale * 100) + '%';
  }
  const timer = setInterval(() => {
    syncMetrics();
    if (check('simulate').checked && !pointerDown && !busy) {
      const time = performance.now() / 1000;
      source.publish({
        ...history.current,
        blocks: history.current.blocks.map((block, i) => ({
          ...block,
          signal: (Math.sin(time + i * 0.7) + 1) / 2,
        })),
        wires: history.current.wires.map((wire, i) => ({
          ...wire,
          signal: (Math.sin(time + i * 0.4) + 1) / 2,
        })),
      });
      diagram.set({ source: source.data });
    }
  }, 250);
  const resize = () => {
    show();
    if (!history.canUndo) choosePreset(active);
  };
  compact.addEventListener('change', resize);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    clearInterval(timer);
    compact.removeEventListener('change', resize);
    systemTheme.removeEventListener('change', updateTheme);
    diagram.destroy();
    gpu.destroy();
  });
  $<HTMLFieldSetElement>('#controls').disabled = false;
  select('mode').disabled = false;
  historyButtons();
  inspect();
  message('Control loop ready. Drag from a port to draw a wire.', false);
  return { gpu, diagram, source, errors, choosePreset, exportImage };
}
const ready = boot().catch((error: unknown) => {
  $('#loading').hidden = true;
  $('#error button').onclick = () => location.reload();
  report(error);
  throw error;
});
Object.assign(window, { diagramStudioReady: ready });
