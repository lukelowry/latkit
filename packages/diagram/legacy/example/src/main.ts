import { COLORMAPS, colormap, gradient, type ColormapName } from '@latkit/colormaps';
import { createDiagram, type Events, type Options } from '@latkit/diagram';
import { Refusal, type Document, type Model } from '@latkit/model';
import { CLASSES, isClassName, type PortSpec } from './classes.js';
import { DynamicsDocument } from './document.js';
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

/** A scene's case, open for editing. */
function openScene(option: SceneOption): Promise<DynamicsDocument> {
  return Promise.resolve(new DynamicsDocument(option.build(), option.label));
}

async function main(): Promise<void> {
  let scene: SceneOption = SCENES[0]!;
  let doc = await openScene(scene);
  /** Stops following the previous scene's document. */
  let unfollow = (): void => {};
  let simulating = false;
  let simulation: { readonly netlist: Document.Netlist; readonly run: Simulation } | null = null;
  let simulationFrame = 0;
  /** Bumped per scene switch, so a slower switch never lands over a newer one. */
  let sceneGeneration = 0;

  // Created before the first load, which syncs them; placed with the other actions below.
  const undoButton = createButton('undo', false);
  const redoButton = createButton('redo', false);
  for (const button of [undoButton, redoButton]) button.removeAttribute('aria-pressed');

  function syncHistory(): void {
    const { undo, redo } = doc.history;
    undoButton.disabled = undo.length === 0;
    redoButton.disabled = redo.length === 0;
    undoButton.title = undo[0] ? `undo ${undo[0].label}` : '';
    redoButton.title = redo[0] ? `redo ${redo[0].label}` : '';
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

  const describePart = (part: Document.Part): string => doc.describe(part);

  function describeParts(parts: readonly Document.Part[]): string {
    if (parts.length === 0) return '-';
    if (parts.length === 1) return describePart(parts[0]!);
    const blocks = parts.filter((part) => part.kind === 'block').length;
    return blocks === parts.length
      ? `${blocks.toLocaleString()} blocks`
      : `${parts.length.toLocaleString()} parts`;
  }

  function setSummary(): void {
    const { netlist } = doc.schematic;
    const nets = netlist.netStart.length - 1;
    summaryEl.textContent =
      `${scene.label}: ${netlist.blockCount.toLocaleString()} blocks / ` +
      `${nets.toLocaleString()} nets / ${(netlist.groupCount ?? 0).toLocaleString()} plants`;
  }

  function note(text: string, refused = false): void {
    proposalEl.textContent = text;
    proposalEl.classList.toggle('refused', refused);
  }

  function setSelection(parts: readonly Document.Part[]): void {
    selectionEl.textContent = describeParts(parts);
  }

  // ---- the document on the diagram ----

  function simulationFor(schematic: Document.Schematic): Simulation {
    if (simulation?.netlist !== schematic.netlist) {
      simulation = { netlist: schematic.netlist, run: new Simulation(schematic) };
    }
    return simulation.run;
  }

  function writeSimulation(now: number): void {
    const run = simulationFor(doc.schematic);
    diagram.setChannel('netFlow', run.flow);
    diagram.setChannel('netColor', run.at(now), [-1, 1]);
  }

  /**
   * Show the document after a step. A structural step loads its netlist without moving the
   * camera, which keeps every surviving block where it was; the load clears every other channel,
   * so the port status and the simulation are written again. Every step writes the placements: a
   * new block arrives unplaced (an insert, an undone delete) and an unchanged netlist loads nothing
   * (an undone move), so the diagram moves only blocks whose pair differs.
   */
  function show(change: Document.Change): void {
    const { netlist, positions, status } = doc.schematic;
    if (change.scope === 'structure') {
      try {
        diagram.load(netlist, { fit: false });
      } catch (error) {
        console.error(`${LOG} the diagram rejects the document's netlist:`, error);
      }
      diagram.setChannel('portStatus', status);
      if (simulating) writeSimulation(performance.now());
      setSummary();
    }
    diagram.setChannel('blockPosition', positions);
    syncHistory();
  }

  /** Put the diagram's placements back to the document's: a refused move snaps back. */
  function restore(): void {
    diagram.setChannel('blockPosition', doc.schematic.positions);
  }

  /** One undoable step: the document shows it, or refuses it and the view snaps back. */
  function propose(...operations: Document.Operation[]): Document.Change | null {
    let change: Document.Change | null;
    try {
      change = doc.apply(...operations);
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
    if (change === null) {
      note('nothing to change');
      restore();
      return null;
    }
    note(change.label);
    return change;
  }

  function undo(): void {
    const change = doc.undo();
    if (change) note(`undo ${change.label}`);
  }

  function redo(): void {
    const change = doc.redo();
    if (change) note(`redo ${change.label}`);
  }

  /** Add a class where a client point lands on the diagram, and select it. */
  function insertAt(classId: string, clientX: number, clientY: number): void {
    const at = diagram.toDiagram(clientX, clientY);
    if (at === null) {
      console.error(
        `${LOG} cannot place ${classId}: the diagram has no camera yet (not attached?)`,
      );
      note('refused: the canvas is not ready', true);
      return;
    }
    const inserted = propose({ kind: 'insert', classId, at })?.created[0];
    const part = inserted && doc.partOf(inserted);
    if (!part) return;
    diagram.select([part]);
    setSelection([part]);
    stage.focus();
  }

  async function loadScene(option: SceneOption, initial: boolean): Promise<void> {
    const generation = ++sceneGeneration;
    summaryEl.textContent = `building ${option.label}`;
    await nextPaint();
    if (generation !== sceneGeneration) return;
    const t0 = performance.now();
    const next = initial ? doc : await openScene(option);
    if (generation !== sceneGeneration) return;
    const { netlist, status } = next.schematic;
    const t1 = performance.now();
    try {
      diagram.load(netlist, { fit: initial });
    } catch (error) {
      console.error(`${LOG} scene ${option.id} built a netlist the diagram rejects:`, error);
      summaryEl.textContent = `scene ${option.label} failed: ${errorMessage(error)}`;
      return;
    }
    const t2 = performance.now();
    scene = option;
    doc = next;
    unfollow();
    unfollow = doc.on('change', show);
    diagram.setChannel('portStatus', status);
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
      `${LOG} ${option.id}: ${netlist.blockCount} blocks; document + netlist ` +
        `${(t1 - t0).toFixed(1)} ms, load ${(t2 - t1).toFixed(1)} ms, ` +
        `fit + channels ${(t3 - t2).toFixed(1)} ms`,
    );
  }

  // ---- proposals, in the case's own terms ----

  diagram.on('connect', ({ from, to, replaces }: Events['connect']) => {
    const unwire: Document.Operation[] =
      replaces === null ? [] : [{ kind: 'disconnect', port: doc.portAt(replaces) }];
    if (to === null) {
      if (replaces !== null) propose(...unwire);
      else note('released over empty canvas: drag a class from the palette to add a block');
      return;
    }
    // Every net of the schematic is a signal or a bus of the case.
    const target = to.kind === 'port' ? doc.portAt(to.index) : { net: doc.elementAt(to)! };
    propose(...unwire, { kind: 'connect', from: doc.portAt(from), to: target });
  });
  diagram.on('move', ({ blocks, positions }) => {
    const elements = doc.schematic.blocks;
    propose({ kind: 'place', elements: Array.from(blocks, (b) => elements[b]!), positions });
  });
  diagram.on('delete', (parts) => {
    const { netlist, blocks } = doc.schematic;
    const removed = new Set<number>();
    const elements: Model.Element[] = [];
    for (const part of parts) {
      if (part.kind === 'block') removed.add(part.index);
      else if (part.kind === 'group') {
        netlist.blockGroup?.forEach((group, b) => {
          if (group === part.index) removed.add(b);
        });
      } else if (part.kind === 'net') elements.push(doc.elementAt(part)!);
    }
    for (const b of removed) elements.push(blocks[b]!);
    // A port goes with its block; a port of a block that stays is unwired.
    const unwire = parts.flatMap((part): Document.Operation[] => {
      if (part.kind !== 'port') return [];
      const port = doc.portAt(part.index);
      return removed.has(doc.partOf(port.element)!.index) ? [] : [{ kind: 'disconnect', port }];
    });
    if (propose(...unwire, { kind: 'remove', elements }) === null) return;
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

  choice<NonNullable<Options['interaction']>>(
    'interaction',
    ['edit', 'navigate', 'inspect', 'none'],
    'edit',
    (mode) => diagram.setOptions({ interaction: mode }),
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
          diagram.setChannel('netColor', simulationFor(doc.schematic).at(now), [-1, 1]);
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
    const { blocks, positions } = doc.schematic;
    const placed = blocks.filter((_, b) => !Number.isNaN(positions[2 * b]!));
    const unplaced =
      placed.length > 0 && propose({ kind: 'place', elements: placed, positions: null }) !== null;
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

  buildPalette(doc.palette, (classId) => {
    const rect = stage.getBoundingClientRect();
    insertAt(classId, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  stage.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes(CLASS_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('drop', (event) => {
    const classId = event.dataTransfer?.getData(CLASS_MIME) ?? '';
    if (classId === '') return;
    event.preventDefault();
    insertAt(classId, event.clientX, event.clientY); // the document refuses a class it lacks
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

function buildPalette(
  palette: readonly Document.BlockClass[],
  add: (classId: string) => void,
): void {
  const container = document.getElementById('classes') as HTMLElement;
  const groups = new Map<string, Document.BlockClass[]>();
  for (const entry of palette) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  for (const [group, entries] of groups) {
    const section = document.createElement('section');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = group;
    section.append(label);
    for (const entry of entries) section.append(paletteItem(entry, add));
    container.append(section);
  }
}

function paletteItem(
  entry: Document.BlockClass,
  add: (classId: string) => void,
): HTMLButtonElement {
  const count = (flow: Document.BlockClass['ports'][number]['flow']): number =>
    entry.ports.filter((port) => port.flow === flow).length;
  const specs: readonly PortSpec[] = isClassName(entry.classId) ? CLASSES[entry.classId].ports : [];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'class';
  button.draggable = true;
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = entry.label;
  const shape = document.createElement('span');
  shape.className = 'ports';
  const parts = [`${count('in')} in`, `${count('out')} out`];
  if (count('bus') > 0) parts.push('bus');
  shape.textContent = parts.join(' / ');
  button.append(title, shape);
  button.title = entry.ports
    .map((port) => {
      const said = `${port.name} (${port.flow}${port.required ? ', required' : ''})`;
      const description = specs.find((spec) => spec.name === port.name)?.description;
      return description ? `${said}: ${description}` : said;
    })
    .join('\n');
  button.setAttribute('aria-label', `Add ${entry.label}: ${parts.join(', ')}`);
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(CLASS_MIME, entry.classId);
    event.dataTransfer?.setData('text/plain', entry.label);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  });
  button.addEventListener('click', () => add(entry.classId));
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
