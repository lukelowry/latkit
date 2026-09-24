import { COLORMAPS, colormap, gradient, type ColormapName } from '@latkit/colormaps';
import {
  createDiagram,
  type Events,
  type Interaction,
  type Options,
  type Part,
} from '@latkit/diagram';
import { CLASS_NAMES, CLASSES, isClassName, type ClassName, type PortSpec } from './classes.js';
import {
  apply,
  build,
  describe,
  History,
  positionsOf,
  Refusal,
  type Built,
  type Doc,
  type Edit,
} from './document.js';
import { SCENES, type SceneOption } from './scenes.js';
import { Simulation } from './simulate.js';
import './style.css';

/** Diverging maps: the simulation colors a signed deviation. */
const EXAMPLE_COLORMAPS = [
  'berlin',
  'coolwarm',
  'icefire',
  'spectral',
] as const satisfies readonly ColormapName[];

/** The identity shade: installed only so its tick can count the frames the diagram renders. */
const IDENTITY_SHADE = 'fn shade(f: Fragment) -> vec4f { return f.color; }\n';

/** The drag-and-drop type a palette item carries. */
const CLASS_MIME = 'application/x-latkit-class';

const LOG = '[diagram-example]';

/** Option colors per color scheme; the canvas is transparent, so the page supplies the backdrop. */
const THEMES = {
  dark: {
    blockBaseColor: [0.13, 0.15, 0.19, 1],
    outlineColor: [0.42, 0.46, 0.54, 1],
    netBaseColor: [0.6, 0.64, 0.7, 1],
    textColor: [0.9, 0.91, 0.93, 1],
    gridColor: [0.55, 0.58, 0.65, 0.26],
    groupColor: [0.55, 0.58, 0.65, 0.06],
    hoverColor: [0.82, 0.38, 0.3, 1],
    selectedColor: [0.86, 0.42, 0.32, 1],
    portColors: [
      [0.45, 0.7, 0.95, 1],
      [0.93, 0.72, 0.3, 1],
    ],
    statusColors: [
      [0.96, 0.7, 0.2, 1],
      [0.92, 0.3, 0.28, 1],
    ],
  },
  light: {
    blockBaseColor: [0.985, 0.985, 0.99, 1],
    outlineColor: [0.38, 0.41, 0.47, 1],
    netBaseColor: [0.32, 0.35, 0.41, 1],
    textColor: [0.1, 0.11, 0.14, 1],
    gridColor: [0.3, 0.33, 0.4, 0.28],
    groupColor: [0.2, 0.26, 0.36, 0.045],
    hoverColor: [0.74, 0.3, 0.2, 1],
    selectedColor: [0.7, 0.26, 0.16, 1],
    portColors: [
      [0.12, 0.43, 0.76, 1],
      [0.76, 0.48, 0.04, 1],
    ],
    statusColors: [
      [0.82, 0.55, 0.05, 1],
      [0.78, 0.18, 0.16, 1],
    ],
  },
} as const satisfies Record<string, Options>;

const stage = document.getElementById('stage') as HTMLCanvasElement;
const summaryEl = document.getElementById('summary') as HTMLElement;
const hoverEl = document.getElementById('hover') as HTMLElement;
const selectionEl = document.getElementById('selection') as HTMLElement;
const proposalEl = document.getElementById('proposal') as HTMLElement;
const fpsEl = document.getElementById('fps') as HTMLElement;

const scheme = window.matchMedia('(prefers-color-scheme: dark)');

function theme(): Options {
  return scheme.matches ? THEMES.dark : THEMES.light;
}

/** Keep fits clear of the panels floating over the canvas (see style.css breakpoints). */
function fitPadding(): readonly [number, number, number, number] {
  const width = window.innerWidth;
  if (width <= 640) return [16, 16, 64, 16];
  return [24, width <= 900 ? 24 : 228, 68, 316];
}

function fail(message: string): void {
  const box = document.createElement('div');
  box.className = 'fatal';
  const title = document.createElement('h2');
  title.textContent = 'Cannot render';
  const detail = document.createElement('p');
  detail.textContent = message;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'This example needs a browser with WebGPU support.';
  box.append(title, detail, hint);
  stage.replaceWith(box);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve after the browser has had a chance to paint (so a status line shows before work). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function main(): Promise<void> {
  let scene: SceneOption = SCENES[0]!;
  const first = scene.build();
  const history = new History({ structure: first, placements: new Map() });
  let built: Built = build(first);
  let simulating = false;
  let simulation: { readonly built: Built; readonly run: Simulation } | null = null;
  let simulationFrame = 0;
  /** Bumped per scene switch, so a slower switch never lands over a newer one. */
  let sceneGeneration = 0;

  // Created before the first load, which syncs them; placed with the other actions below.
  const undoButton = createButton('undo', false);
  const redoButton = createButton('redo', false);
  for (const button of [undoButton, redoButton]) button.removeAttribute('aria-pressed');

  function syncHistory(): void {
    undoButton.disabled = !history.canUndo;
    redoButton.disabled = !history.canRedo;
  }

  const diagram = createDiagram({
    interaction: 'edit',
    gridPitch: 8,
    colormap: colormap(EXAMPLE_COLORMAPS[scheme.matches ? 0 : 1]),
    fitPaddingPx: fitPadding(),
    ...theme(),
  });
  window.addEventListener('resize', () => diagram.setOptions({ fitPaddingPx: fitPadding() }));
  // A console handle: try `diagram.setOptions({ gridPitch: 10 })` or `diagram.arrange()`.
  Object.assign(window, { diagram });

  // ---- status ----

  const describePart = (part: Part): string => describe(history.current, built, part);

  function describeParts(parts: readonly Part[]): string {
    if (parts.length === 0) return '-';
    if (parts.length === 1) return describePart(parts[0]!);
    const blocks = parts.filter((part) => part.kind === 'block').length;
    return blocks === parts.length
      ? `${blocks.toLocaleString()} blocks`
      : `${parts.length.toLocaleString()} parts`;
  }

  function setSummary(): void {
    const { netlist } = built;
    const nets = netlist.netStart.length - 1;
    summaryEl.textContent =
      `${scene.label}: ${netlist.blockCount.toLocaleString()} blocks / ` +
      `${nets.toLocaleString()} nets / ${(netlist.groupCount ?? 0).toLocaleString()} plants`;
  }

  function note(text: string, refused = false): void {
    proposalEl.textContent = text;
    proposalEl.classList.toggle('refused', refused);
  }

  function setSelection(parts: readonly Part[]): void {
    selectionEl.textContent = describeParts(parts);
  }

  // ---- the document on the diagram ----

  function simulationFor(current: Built): Simulation {
    if (simulation?.built !== current) {
      simulation = { built: current, run: new Simulation(current) };
    }
    return simulation.run;
  }

  function writeSimulation(now: number): void {
    const run = simulationFor(built);
    diagram.setChannel('netFlow', run.flow);
    diagram.setChannel('netColor', run.at(now), [-1, 1]);
  }

  /**
   * Show a document: load its netlist without moving the camera, then write its placements. A
   * load keeps every surviving block where it was, placement included, but a new block arrives
   * unplaced (an insert, an undone delete) and an unchanged netlist loads nothing (clearing the
   * placements, an undone move), so the document's placements follow every load; the diagram
   * moves only blocks whose pair differs. The load clears every other channel, so the
   * simulation's are written again. Returns false when the diagram refused the netlist.
   */
  function show(doc: Doc): boolean {
    const next = build(doc.structure);
    try {
      diagram.load(next.netlist, { fit: false });
    } catch (error) {
      console.error(`${LOG} the document built a netlist the diagram rejects:`, error);
      return false;
    }
    built = next;
    diagram.setChannel('blockPosition', positionsOf(doc, next));
    if (simulating) writeSimulation(performance.now());
    setSummary();
    return true;
  }

  /** Put the diagram's placements back to the current document's: a refused move snaps back. */
  function restore(): void {
    diagram.setChannel('blockPosition', positionsOf(history.current, built));
  }

  /** One undoable step: accepted edits load, refusals leave the document and restore the view. */
  function propose(edits: readonly Edit[]): Doc | null {
    let result: ReturnType<typeof apply>;
    try {
      result = apply(history.current, built, edits);
    } catch (error) {
      if (error instanceof Refusal) {
        note(`refused: ${error.message}`, true);
      } else {
        console.error(`${LOG} an edit failed:`, error);
        note(`edit failed: ${errorMessage(error)}`, true);
      }
      restore();
      return null;
    }
    if (result.summary === '') {
      note('nothing to change');
      restore();
      return null;
    }
    if (!show(result.doc)) {
      note('refused: the edit would build an invalid netlist (see the console)', true);
      restore();
      return null;
    }
    history.commit(result.doc);
    note(result.summary);
    syncHistory();
    return result.doc;
  }

  function undo(): void {
    const doc = history.undo();
    if (!doc) return;
    if (!show(doc)) console.error(`${LOG} undo could not show the previous document`);
    note('undo');
    syncHistory();
  }

  function redo(): void {
    const doc = history.redo();
    if (!doc) return;
    if (!show(doc)) console.error(`${LOG} redo could not show the next document`);
    note('redo');
    syncHistory();
  }

  /** Add a class where a client point lands on the diagram, and select it. */
  function insertAt(cls: ClassName, clientX: number, clientY: number): void {
    const at = diagram.toDiagram(clientX, clientY);
    if (at === null) {
      console.error(`${LOG} cannot place ${cls}: the diagram has no camera yet (not attached?)`);
      note('refused: the canvas is not ready', true);
      return;
    }
    if (propose([{ kind: 'insert', cls, at }]) === null) return;
    const inserted: Part = { kind: 'block', index: built.netlist.blockCount - 1 };
    diagram.select([inserted]);
    setSelection([inserted]);
    stage.focus();
  }

  async function loadScene(option: SceneOption, initial: boolean): Promise<void> {
    const generation = ++sceneGeneration;
    summaryEl.textContent = `building ${option.label}`;
    await nextPaint();
    if (generation !== sceneGeneration) return;
    scene = option;
    const t0 = performance.now();
    const structure = initial ? first : option.build();
    const doc: Doc = { structure, placements: new Map() };
    const next = build(structure);
    const t1 = performance.now();
    try {
      diagram.load(next.netlist, { fit: initial });
    } catch (error) {
      console.error(`${LOG} scene ${option.id} built a netlist the diagram rejects:`, error);
      summaryEl.textContent = `scene ${option.label} failed: ${errorMessage(error)}`;
      return;
    }
    const t2 = performance.now();
    built = next;
    history.reset(doc);
    // Block keys carry the scene, so no block survived: the load arranged the scene afresh and
    // dropped the selection with the old blocks.
    if (!initial) diagram.fit();
    setSelection([]);
    if (simulating) writeSimulation(performance.now());
    const t3 = performance.now();
    setSummary();
    syncHistory();
    note(`${option.label} loaded`);
    console.info(
      `${LOG} ${option.id}: ${next.netlist.blockCount} blocks; document + netlist ` +
        `${(t1 - t0).toFixed(1)} ms, load ${(t2 - t1).toFixed(1)} ms, ` +
        `fit + channels ${(t3 - t2).toFixed(1)} ms`,
    );
  }

  // ---- proposals ----

  diagram.on('connect', ({ from, to, replaces }: Events['connect']) => {
    if (to === null) {
      if (replaces !== null) propose([{ kind: 'disconnect', port: replaces }]);
      else note('released over empty canvas: drag a class from the palette to add a block');
      return;
    }
    const connect: Edit = { kind: 'connect', from, to };
    propose(replaces === null ? [connect] : [{ kind: 'disconnect', port: replaces }, connect]);
  });
  diagram.on('move', ({ blocks, positions }) => {
    propose([{ kind: 'move', blocks, positions }]);
  });
  diagram.on('delete', (parts) => {
    if (propose([{ kind: 'delete', parts }]) === null) return;
    diagram.select([]);
    setSelection([]);
  });

  // ---- what the user looks at ----

  diagram.on('hover', (part) => {
    hoverEl.textContent = part === null ? '-' : describePart(part);
  });
  diagram.on('select', setSelection);
  diagram.on('open', (part) => {
    diagram.reveal(part, { neighbors: true, animate: true });
    note(`open ${describePart(part)}`);
  });
  diagram.on('contextmenu', ({ parts }) => {
    note(
      parts.length === 0 ? 'context menu on empty canvas' : `context menu: ${describeParts(parts)}`,
    );
  });
  diagram.on('deviceLost', ({ reason, message, recovering }) => {
    console.error(`${LOG} WebGPU device lost (${reason}): ${message}`);
    note(
      recovering ? `device lost (${reason}); recovering` : `device unavailable: ${message}`,
      true,
    );
  });
  diagram.on('pipelineError', ({ cause }) => {
    console.error(`${LOG} a diagram pipeline failed to build:`, cause);
    note(`pipeline error: ${errorMessage(cause)}`, true);
  });

  // ---- frame counter ----

  const stamps = new Float64Array(256);
  let frames = 0;
  diagram
    .setShade({
      wgsl: IDENTITY_SHADE,
      tick(_host, frame) {
        stamps[frames++ & 255] = frame.timeMs;
        return false;
      },
    })
    .catch((error: unknown) => console.error(`${LOG} the frame-counting shade failed:`, error));
  setInterval(() => {
    const now = performance.now();
    let count = 0;
    for (let i = 0; i < Math.min(frames, 256); i++) if (now - stamps[i]! <= 1000) count++;
    fpsEl.textContent = count === 0 ? 'idle' : `${count} fps`;
  }, 500);

  // ---- attach ----

  await loadScene(scene, true);
  try {
    await diagram.attach(stage);
  } catch (error) {
    console.error(`${LOG} attach failed:`, error);
    diagram.destroy();
    fail(errorMessage(error));
    return;
  }

  scheme.addEventListener('change', () => diagram.setOptions(theme()));

  // ---- controls ----

  const sceneRow = row('scenes');
  for (const option of SCENES) {
    const button = createButton(option.label, option === scene);
    button.addEventListener('click', () => {
      if (option === scene) return;
      setActive(sceneRow, button);
      void loadScene(option, false);
    });
    sceneRow.append(button);
  }

  choice<Interaction>('interaction', ['edit', 'navigate', 'inspect', 'none'], 'edit', (mode) =>
    diagram.setOptions({ interaction: mode }),
  );
  choice('routing', ['orthogonal', 'straight'] as const, 'orthogonal', (routing) =>
    diagram.setOptions({ routing }),
  );
  choice('motion', ['auto', 'reduce', 'full'] as const, 'auto', (motion) =>
    diagram.setOptions({ motion }),
  );

  const displayRow = row('display');
  for (const key of ['grid', 'snap', 'labels', 'arrows', 'junctions'] as const) {
    displayRow.append(
      toggle(key, true, (on) => {
        const patch: Options = {};
        patch[key] = on;
        diagram.setOptions(patch);
      }),
    );
  }

  const colormapRow = row('colormaps');
  EXAMPLE_COLORMAPS.forEach((name, i) => {
    const button = createButton(COLORMAPS[name].label, i === (scheme.matches ? 0 : 1));
    button.classList.add('swatch');
    button.style.setProperty('--swatch', gradient(name, 'to right'));
    button.addEventListener('click', () => {
      diagram.setOptions({ colormap: colormap(name) });
      setActive(colormapRow, button);
    });
    colormapRow.append(button);
  });

  const actions = row('actions');
  actions.append(
    toggle('simulate', false, (on) => {
      simulating = on;
      if (on) {
        writeSimulation(performance.now());
        const step = (now: number): void => {
          if (!simulating) return;
          diagram.setChannel('netColor', simulationFor(built).at(now), [-1, 1]);
          simulationFrame = requestAnimationFrame(step);
        };
        simulationFrame = requestAnimationFrame(step);
      } else {
        cancelAnimationFrame(simulationFrame);
        diagram.setChannel('netColor', null);
        diagram.setChannel('netFlow', null);
      }
    }),
  );
  const arrangeButton = createButton('arrange', false);
  arrangeButton.addEventListener('click', () => {
    // Placements are the document's: clearing them is an undoable step that hands every block
    // back to the automatic layout, which `arrange` then recomputes (not part of the document).
    const unplaced = history.current.placements.size > 0 && propose([{ kind: 'unplace' }]) !== null;
    diagram.arrange(undefined, { animate: true });
    note(unplaced ? 'arranged; placements cleared (undo restores them)' : 'arranged');
  });
  const fitButton = createButton('fit', false);
  fitButton.addEventListener('click', () => diagram.fit(true));
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  actions.append(arrangeButton, fitButton, undoButton, redoButton);
  for (const button of [arrangeButton, fitButton]) button.removeAttribute('aria-pressed');

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      redo();
    }
  });

  // ---- palette ----

  buildPalette((cls) => {
    const rect = stage.getBoundingClientRect();
    insertAt(cls, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  stage.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes(CLASS_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('drop', (event) => {
    const cls = event.dataTransfer?.getData(CLASS_MIME) ?? '';
    if (!isClassName(cls)) return;
    event.preventDefault();
    insertAt(cls, event.clientX, event.clientY);
  });

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    diagram.destroy();
  });

  // ---- control helpers bound to this diagram ----

  function choice<T extends string>(
    id: string,
    values: readonly T[],
    initial: T,
    applyValue: (value: T) => void,
  ): void {
    const container = row(id);
    for (const value of values) {
      const button = createButton(value, value === initial);
      button.addEventListener('click', () => {
        applyValue(value);
        setActive(container, button);
      });
      container.append(button);
    }
  }

  function toggle(label: string, on: boolean, set: (on: boolean) => void): HTMLButtonElement {
    const button = createButton(label, on);
    let state = on;
    button.addEventListener('click', () => {
      state = !state;
      set(state);
      setPressed(button, state);
    });
    return button;
  }
}

function buildPalette(add: (cls: ClassName) => void): void {
  const container = document.getElementById('classes') as HTMLElement;
  const categories = new Map<string, ClassName[]>();
  for (const cls of CLASS_NAMES) {
    const category = CLASSES[cls].category;
    categories.set(category, [...(categories.get(category) ?? []), cls]);
  }
  for (const [category, classes] of categories) {
    const section = document.createElement('section');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = category;
    section.append(label);
    for (const cls of classes) section.append(paletteItem(cls, add));
    container.append(section);
  }
}

function paletteItem(cls: ClassName, add: (cls: ClassName) => void): HTMLButtonElement {
  const spec = CLASSES[cls];
  const ports: readonly PortSpec[] = spec.ports;
  const count = (flow: PortSpec['flow']): number =>
    ports.filter((port) => port.flow === flow).length;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'class';
  button.draggable = true;
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = spec.title;
  const shape = document.createElement('span');
  shape.className = 'ports';
  const parts = [`${count('in')} in`, `${count('out')} out`];
  if (count('both') > 0) parts.push('bus');
  shape.textContent = parts.join(' / ');
  button.append(title, shape);
  button.title = ports.map((port) => `${port.name} (${port.flow}): ${port.description}`).join('\n');
  button.setAttribute('aria-label', `Add ${spec.title}: ${parts.join(', ')}`);
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(CLASS_MIME, cls);
    event.dataTransfer?.setData('text/plain', spec.title);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  });
  button.addEventListener('click', () => add(cls));
  return button;
}

function row(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function createButton(label: string, pressed: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  setPressed(button, pressed);
  return button;
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.classList.toggle('active', pressed);
  button.setAttribute('aria-pressed', String(pressed));
}

function setActive(container: HTMLElement, active: HTMLButtonElement): void {
  for (const button of container.querySelectorAll('button')) setPressed(button, button === active);
}

main().catch((error: unknown) => {
  console.error(`${LOG} startup failed:`, error);
  fail(errorMessage(error));
});
