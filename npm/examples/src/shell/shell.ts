/**
 * The examples' shell: the layout every page shares, and everything a page does not declare
 * itself. It shows a page's settings as controls and draws each view's scene again when one
 * changes, runs the page's frames and timeline, and gives every page an inspector, a performance
 * readout, and picture and video export.
 */
import {
  Shot,
  View,
  load,
  type Camera,
  type Gpu,
  type Rect,
  type Row,
  type Scene,
  type Value,
} from 'latkit';
import { h } from './dom.js';
import type { Action, Context, Opened, Page, Setting, Settings } from './page.js';
import { Timeline, type TimelineOptions } from './timeline.js';

declare global {
  interface Window {
    /** The open page's views and their GPU, for the browser gate. */
    stage?: { views: View[]; gpu?: Gpu };
  }
}

/** A page in the picker: its id in the URL, and its module. */
export interface Entry {
  readonly id: string;
  readonly title: string;
  load(): Promise<{ default: Page }>;
}

/** Fields the inspector leaves out: positions, which the view already shows. */
const HIDDEN = /^(lon|lat|x|y|z|geometry|position)$/;
const MB = 1 << 20;

/** Starts the examples: the shared layout, and the page the URL names. */
export function start(pages: readonly Entry[]): void {
  const picker = h('select', { 'aria-label': 'Example' });
  picker.append(...pages.map(({ id, title }) => h('option', { value: id }, title)));
  picker.addEventListener('change', () => (location.hash = picker.value));
  const regions = {
    detail: h('p', { class: 'detail' }),
    error: h('div', { role: 'alert', class: 'error', hidden: true }),
    main: h('main', { id: 'example' }),
    side: h('aside', { id: 'controls', 'aria-label': 'Controls' }),
    footer: h('footer', { 'aria-label': 'Playback' }),
  };
  const toggle = h(
    'button',
    { type: 'button', class: 'controls-toggle', 'aria-expanded': 'true' },
    'Controls',
  );
  toggle.addEventListener('click', () => {
    regions.side.hidden = !regions.side.hidden;
    toggle.setAttribute('aria-expanded', String(!regions.side.hidden));
  });
  document.body.append(
    h(
      'header',
      {},
      h('a', { class: 'brand', href: `#${pages[0]!.id}` }, 'latkit'),
      h('label', { class: 'example-picker' }, h('span', {}, 'Examples'), picker),
      regions.detail,
      toggle,
    ),
    regions.error,
    regions.main,
    regions.side,
    regions.footer,
  );

  let open: OpenPage | undefined;
  let opening = 0;
  const show = async () => {
    const id = location.hash.slice(1).split('?')[0];
    const entry = pages.find((p) => p.id === id) ?? pages[0]!;
    const opened = ++opening;
    open?.close();
    open = undefined;
    regions.error.hidden = true;
    picker.value = entry.id;
    document.title = `${entry.title} · latkit`;
    regions.detail.textContent = 'Loading…';
    try {
      const [{ default: page }] = await Promise.all([entry.load(), load()]);
      if (opened !== opening) return;
      open = new OpenPage(page, regions, (error) => opened === opening && fail(error));
      await open.start();
    } catch (error) {
      if (opened === opening) fail(error);
    }
  };
  const fail = (error: unknown) => {
    const unsupported = (error as { code?: string }).code === 'unsupported';
    regions.error.hidden = false;
    regions.error.replaceChildren(
      h(
        'p',
        {},
        unsupported
          ? 'WebGPU is unavailable. Open these examples in a browser with WebGPU enabled.'
          : `Could not run this example. ${String(error)}`,
      ),
    );
    console.error(error);
  };
  // Settings keep the URL in step without firing this, so a change here comes from a link or the
  // address bar: the page opens again with the settings it gives.
  addEventListener('hashchange', () => void show());
  void show();
}

type Regions = {
  detail: HTMLElement;
  error: HTMLElement;
  main: HTMLElement;
  side: HTMLElement;
  footer: HTMLElement;
};

/** An open page, and the context it runs in. */
class OpenPage implements Context<Record<string, unknown>> {
  readonly id: string;
  readonly settings: Record<string, unknown> = {};
  readonly #abort = new AbortController();
  readonly signal = this.#abort.signal;
  readonly #views: { view: View; scene: (settings: never) => Scene; region: Rect }[] = [];
  /** The page's steps, run while it is live, and the shell's, run every frame. */
  readonly #steps: ((dt: number) => void)[] = [];
  readonly #ticks: (() => void)[] = [];
  readonly #keys = new Map<string, () => void>();
  readonly #actions = h('div');
  readonly #panel = h('div');
  #canvas?: HTMLCanvasElement;
  #timeline?: Timeline;
  #opened?: Opened<Record<string, unknown>>;
  #stepMs = 0;

  constructor(
    private readonly page: Page,
    private readonly regions: Regions,
    readonly fail: (error: unknown) => void,
  ) {
    this.id = location.hash.slice(1).split('?')[0] ?? '';
    const given = new URLSearchParams(location.hash.split('?')[1]);
    for (const [name, setting] of Object.entries(page.settings ?? {})) {
      this.settings[name] = valueFrom(setting, given.get(name)) ?? setting.value;
    }
    regions.side.replaceChildren(this.#actions, this.#panel);
    regions.side.hidden = false;
    this.#controls(page.settings ?? {});
    addEventListener(
      'keydown',
      (event) => {
        const typing = (event.target as Element).closest?.('input, select, textarea, button');
        const action = this.#keys.get(event.key.toLowerCase());
        if (!action || typing || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        action();
      },
      { signal: this.signal },
    );
  }

  async start(): Promise<void> {
    this.#opened = (await this.page.open(this as never)) ?? undefined;
    if (this.signal.aborted) return;
    const views = this.#views.map(({ view }) => view);
    window.stage = { views, gpu: views[0]?.gpu };
    if (this.page.inspect !== false) this.#inspector();
    if (views[0]) {
      this.#meter(views[0]);
      this.#export(views[0]);
    }
    let last: number | undefined;
    const stop = views[0]?.gpu.on('frame', (now) => {
      const dt = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      try {
        if (!this.#timeline || this.#timeline.mode === 'live') {
          const start = performance.now();
          for (const step of this.#steps) step(dt);
          this.#stepMs = this.#stepMs * 0.9 + (performance.now() - start) * 0.1;
        }
        this.#timeline?.tick(dt);
        for (const tick of this.#ticks) tick();
      } catch (error) {
        this.fail(error);
      }
    });
    if (stop) this.signal.addEventListener('abort', stop);
    if (this.regions.detail.textContent === 'Loading…') this.regions.detail.textContent = '';
  }

  close(): void {
    this.#abort.abort();
    for (const { view } of this.#views) view.destroy();
    for (const region of [this.regions.main, this.regions.side, this.regions.footer])
      region.replaceChildren();
    this.regions.detail.textContent = '';
    window.stage = undefined;
  }

  // The context a page runs in. Its functions are bound, so a page can destructure them.

  view = async (
    scene: (settings: never) => Scene,
    options: { region?: Rect; camera?: Camera; label?: string } = {},
  ): Promise<View> => {
    this.#canvas ??= this.regions.main.appendChild(
      h('canvas', { tabindex: 0, 'aria-label': options.label ?? this.page.title }),
    );
    const region = options.region ?? [0, 0, 1, 1];
    const view = await View.create(this.#canvas, scene(this.settings as never), {
      region: this.#fitted(region),
      ...(options.camera ? { camera: options.camera } : {}),
    });
    view.on('error', (error) =>
      error.code === 'io' ? this.detail(error.message) : this.fail(error),
    );
    this.#views.push({ view, scene, region });
    return view;
  };

  actions = (title: string, actions: readonly Action[]): void => {
    const row = h('div', { class: 'actions' });
    for (const action of actions) {
      const button = h('button', { type: 'button' }, action.label, ...kbd(action.key));
      if (action.release) {
        button.addEventListener('pointerdown', () => action.run(), { signal: this.signal });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
          button.addEventListener(type, () => action.release!(), { signal: this.signal });
      } else button.addEventListener('click', () => action.run(), { signal: this.signal });
      if (action.key) this.#keys.set(action.key.toLowerCase(), action.run);
      row.append(button);
    }
    this.#actions.append(section(title, true, row));
  };

  timeline = (options: TimelineOptions): Timeline => {
    this.#timeline = new Timeline(
      options,
      this.regions.footer,
      (key, run) => this.#keys.set(key, run),
      (at) => this.#views.forEach(({ view }) => (view.at = at)),
      this.signal,
    );
    return this.#timeline;
  };

  frame = (step: (dt: number) => void): void => {
    this.#steps.push(step);
  };

  series = (title: string, items: readonly { label: string; color: string }[]): void => {
    const swatches = items.map(({ label, color }) =>
      h('span', { style: `--swatch: ${color}` }, label),
    );
    this.#panel.append(section(title, true, h('p', { class: 'series' }, ...swatches)));
  };

  detail = (text: string): void => {
    this.regions.detail.textContent = text;
  };

  credit = (text: string): void => {
    const line = this.regions.main.querySelector('.credit') ?? h('p', { class: 'credit' });
    line.textContent = text;
    this.regions.main.append(line);
  };

  // What the shell adds to every page.

  /** Shows each setting as a control in its section, and applies changes. */
  #controls(settings: Settings): void {
    const sections = new Map<string, HTMLElement>();
    for (const [name, setting] of Object.entries(settings)) {
      const title = setting.section ?? 'Settings';
      let body = sections.get(title);
      if (!body) {
        const group = this.#panel.appendChild(section(title, true));
        sections.set(title, (body = group.lastElementChild as HTMLElement));
      }
      const set = (value: unknown) => void this.#change(name, value);
      body.append(this.#control(setting, this.settings[name], set));
    }
  }

  #control(setting: Setting<unknown>, value: unknown, set: (value: unknown) => void): HTMLElement {
    if (setting.kind === 'toggle') {
      const button = h('button', { type: 'button', 'aria-pressed': String(value) }, setting.label);
      button.append(...kbd(setting.key));
      const flip = () => {
        const on = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(on));
        set(on);
      };
      button.addEventListener('click', flip, { signal: this.signal });
      if (setting.key) this.#keys.set(setting.key, flip);
      return button;
    }
    if (setting.kind === 'range') {
      const input = h('input', {
        type: 'range',
        min: setting.min,
        max: setting.max,
        step: setting.step,
      });
      input.value = String(value);
      const output = h('output', {}, setting.format(value as number));
      input.addEventListener(
        'input',
        () => {
          output.value = setting.format(input.valueAsNumber);
          set(input.valueAsNumber);
        },
        { signal: this.signal },
      );
      return h('label', { class: 'field' }, h('span', {}, setting.label, output), input);
    }
    const options = setting.options;
    const select = h(
      'select',
      {},
      ...options.map(([label, v], i) => h('option', { value: i, selected: v === value }, label)),
    );
    select.addEventListener('change', () => set(options[select.selectedIndex]![1]), {
      signal: this.signal,
    });
    if (setting.key)
      this.#keys.set(setting.key, () => {
        select.selectedIndex = (select.selectedIndex + 1) % options.length;
        set(options[select.selectedIndex]![1]);
      });
    return h(
      'label',
      { class: 'field' },
      h('span', {}, setting.label, ...kbd(setting.key)),
      select,
    );
  }

  /** Sets `name` to `value`, keeps the URL in step, and draws every view's scene again. */
  async #change(name: string, value: unknown): Promise<void> {
    this.settings[name] = value;
    const query = new URLSearchParams();
    for (const [key, setting] of Object.entries(this.page.settings ?? {}))
      if (this.settings[key] !== setting.value) query.set(key, String(this.settings[key]));
    history.replaceState(null, '', `#${this.id}${query.size ? `?${query}` : ''}`);
    try {
      const after = await this.#opened?.change?.(this.settings, name);
      if (this.signal.aborted) return;
      for (const { view, scene } of this.#views) view.scene = scene(this.settings as never);
      after?.();
    } catch (error) {
      this.fail(error);
    }
  }

  /** A view's region, its axes swapped on narrow screens so side-by-side views stack. */
  #fitted(region: Rect): Rect {
    const [x, y, width, height] = region;
    return matchMedia('(max-width: 700px)').matches ? [y, x, height, width] : region;
  }

  /** The Inspect section: the fields of the row under the pointer, or of the last one clicked. */
  #inspector(): void {
    const title = h('p', { class: 'note' }, 'Hover or click a row.');
    const fields = h('dl', { class: 'fields' });
    this.#panel.append(section('Inspect', true, title, fields));
    let pinned: { view: View; row: Row } | undefined;
    const read = (view: View, row: Row) => {
      const data = view.snapshot(row.data);
      if (!data) return;
      try {
        const table = data.describe().tables.find((t) => t.name === row.table);
        title.textContent = `${row.table} ${row.id}`;
        fields.replaceChildren();
        for (const { name } of table?.fields ?? []) {
          if (HIDDEN.test(name)) continue;
          const value = data.get(row.table, row.id, name, { at: view.at });
          if (value === null) continue;
          fields.append(h('dt', {}, name), h('dd', {}, format(value)));
        }
      } finally {
        data.destroy();
      }
    };
    for (const { view } of this.#views) {
      view.on('hovered', ({ hit }) => {
        if (hit) read(view, hit.row);
        else if (pinned) read(pinned.view, pinned.row);
      });
      view.on('click', ({ hit }) => {
        pinned = { view, row: hit.row };
        read(view, hit.row);
      });
    }
  }

  /** The Performance section: frame rate and times, GPU work and memory, and the GPU's budget. */
  #meter(view: View): void {
    const line = h('p', { class: 'meter', 'aria-live': 'off' });
    const gpu = view.gpu;
    const given = gpu.budget;
    this.signal.addEventListener('abort', () => (gpu.budget = given));
    const memory = h(
      'select',
      {},
      ...[given.bytes, 256 * MB, 64 * MB, 16 * MB].map((bytes, i) =>
        h('option', { value: bytes }, i ? `${bytes / MB} MB` : 'Default'),
      ),
    );
    memory.addEventListener(
      'change',
      () => (gpu.budget = { ...gpu.budget, bytes: Number(memory.value) }),
    );
    this.#panel.append(
      section(
        'Performance',
        false,
        line,
        h('label', { class: 'field' }, h('span', {}, 'GPU memory'), memory),
      ),
    );
    let frames = 0;
    let since = performance.now();
    this.#ticks.push(() => {
      frames++;
      const now = performance.now();
      if (now - since < 500) return;
      const stats = view.stats;
      line.textContent = [
        `${((frames * 1000) / (now - since)).toFixed(0)} fps`,
        `frame ${stats.cpuMs.toFixed(1)} ms${stats.gpuMs ? ` · GPU ${stats.gpuMs.toFixed(2)} ms` : ''}`,
        `${stats.drawn.toLocaleString()} rows drawn · ${stats.draws} draws`,
        `${(gpu.resident / MB).toFixed(0)} of ${(gpu.budget.bytes / MB).toFixed(0)} MB on the GPU`,
        ...(this.#stepMs > 0.05 ? [`page ${this.#stepMs.toFixed(1)} ms a frame`] : []),
        ...(view.waiting.length ? [`waiting on ${view.waiting.join(', ')}`] : []),
      ].join('\n');
      frames = 0;
      since = now;
    });
  }

  /** The Export section: a PNG of the canvas, or six seconds of it as MP4. */
  #export(view: View): void {
    const status = h('p', { class: 'note', role: 'status' });
    const save = (name: string, file: Blob) => {
      const url = URL.createObjectURL(file);
      h('a', { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    const scale = () => Math.min(2, devicePixelRatio);
    const picture = async () => {
      const image = await Shot.of(view, { scale: scale(), capture: 'now' }).image();
      const png = await image.encode('png');
      save('views.png', new Blob([png.slice()], { type: 'image/png' }));
      status.textContent = `Saved views.png, ${image.width}×${image.height}`;
      image.destroy();
    };
    let recording = false;
    const video = async () => {
      if (recording || typeof VideoEncoder !== 'function') return;
      recording = true;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const output = new WritableStream<Uint8Array>({
        write: (chunk) => void chunks.push(chunk.slice()),
      });
      const started = performance.now();
      try {
        // Each frame waits for the page to reach its time, so the video plays at the page's speed.
        await Shot.of(view, { scale: scale() })
          .video({ fps: 30, output })
          .record(async (time) => {
            while (performance.now() - started < time * 1000)
              await new Promise((resolve) => requestAnimationFrame(resolve));
            status.textContent = `Recording ${time.toFixed(1)} of 6 s`;
            return time < 6;
          });
        save('views.mp4', new Blob(chunks, { type: 'video/mp4' }));
        status.textContent = 'Saved views.mp4';
      } finally {
        recording = false;
      }
    };
    const run = (act: () => Promise<void>) => () =>
      void act().catch(
        (error: unknown) => (status.textContent = `Could not export: ${String(error)}`),
      );
    const row = h('div', { class: 'actions' });
    for (const [label, key, act] of [
      ['Picture', 'x', picture],
      ['Video', 'v', video],
    ] as const) {
      const button = h('button', { type: 'button' }, label, ...kbd(key));
      button.addEventListener('click', run(act), { signal: this.signal });
      this.#keys.set(key, run(act));
      row.append(button);
    }
    this.#panel.append(section('Export', false, row, status));
  }
}

/** A collapsible titled group of the side panel. */
function section(title: string, open: boolean, ...children: Node[]): HTMLElement {
  return h(
    'details',
    { class: 'section', open },
    h('summary', {}, title),
    h('div', { class: 'section-body' }, ...children),
  );
}

/** The key label of a button, if it has a key. */
function kbd(key: string | undefined): HTMLElement[] {
  return key ? [h('kbd', {}, key === ' ' ? 'Space' : key.toUpperCase())] : [];
}

/** A setting's value from its URL parameter, or `undefined` when absent or not one of its values. */
function valueFrom(setting: Setting<unknown>, given: string | null): unknown {
  if (given === null) return undefined;
  if (setting.kind === 'toggle') return given === 'true';
  if (setting.kind === 'range') return Number.isFinite(Number(given)) ? Number(given) : undefined;
  return setting.options.find(([, v]) => String(v) === given)?.[1];
}

/** A field's value for the inspector: a number, a text, a point, or the word for a longer geometry. A
 * reference reads as the id of the row it references. */
function format(value: Value): string {
  if (typeof value === 'number')
    return Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(4);
  if (Array.isArray(value))
    return typeof value[0] === 'number'
      ? value.map((v) => format(v as number)).join(', ')
      : 'geometry';
  return String(value);
}
