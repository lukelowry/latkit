import type { Canvas, Gpu, Panel, Scene, View } from 'latkit';
import { Section } from './controls.js';
import { h } from './dom.js';
import { Legend } from './legend.js';
import { Menu } from './menu.js';
import { Meter } from './meter.js';
import { Playback, type PlaybackOptions } from './playback.js';

/** Where a page draws: the main view, the side panel, and the timeline. */
export interface Regions {
  main: HTMLElement;
  side: HTMLElement;
  timeline: HTMLElement;
}

/** What a page draws with. Everything made through it goes when the page closes. */
export class Stage {
  readonly #abort = new AbortController();
  /** Aborted when the page closes: pass it to listeners the page adds itself. */
  readonly signal = this.#abort.signal;
  readonly #views = new Set<View>();
  readonly #canvases = new Set<Canvas>();
  /** Each view a canvas of the page shows, its element, and the panel of it the view fills, in the
   * order they were made. */
  readonly shown: { view: View; element: HTMLCanvasElement; panel: Panel }[] = [];
  readonly #keys = new Map<string, () => void>();
  #holding = 0;

  constructor(
    readonly gpu: Gpu,
    readonly regions: Regions,
    private readonly line: HTMLElement,
    readonly fail: (error: unknown) => void,
  ) {
    addEventListener(
      'keydown',
      (event) => {
        const action = this.#keys.get(event.key.toLowerCase());
        const typing = (event.target as Element | null)?.closest?.('input, select, textarea');
        if (!action || typing || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        action();
      },
      { signal: this.signal },
    );
  }

  /** Every view the page made. */
  get views(): View[] {
    return [...this.#views];
  }

  /** A view in a canvas of its own, in `into`, the main region unless given. */
  view(scene: Scene, options: { label: string; into?: HTMLElement; height?: number }): View {
    return this.panels([scene], options)[0]!;
  }

  /**
   * Views sharing one canvas in `into`, the main region unless given: each in its panel, its x, y,
   * width, and height as fractions of the canvas, side by side unless given. Input goes to the view
   * under it.
   */
  panels(
    scenes: readonly Scene[],
    {
      label,
      into = this.regions.main,
      height,
      panels = scenes.map((_, i) => [i / scenes.length, 0, 1 / scenes.length, 1] as const),
    }: { label: string; into?: HTMLElement; height?: number; panels?: readonly Panel[] },
  ): View[] {
    const canvas = h('canvas', { tabindex: 0, 'aria-label': label });
    if (height) canvas.style.height = `${height}px`;
    into.append(canvas);
    const views = scenes.map((scene) => this.gpu.view(scene));
    this.#canvases.add(this.gpu.canvas(canvas, { panels }).show(views));
    views.forEach((view, i) => {
      this.shown.push({ view, element: canvas, panel: panels[i]! });
      // What could not be fetched only goes undrawn; anything else stops the page.
      view.on('error', (error) =>
        error.code === 'load' ? this.detail(error.message) : this.fail(error),
      );
      this.#views.add(view);
    });
    return views;
  }

  /** Calls `step` every frame before the views draw, with the seconds since the last, at most 0.1;
   * not while the page holds still. */
  frame(step: (dt: number) => void): void {
    let last: number | undefined;
    const stop = this.gpu.on('frame', (now) => {
      const dt = last === undefined || this.#holding ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.#holding) return;
      try {
        step(dt);
      } catch (error) {
        this.fail(error);
      }
    });
    this.signal.addEventListener('abort', stop);
  }

  /** Holds the page's frame steps still while `work` runs, as a picture of it waits for stillness. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.#holding++;
    try {
      return await work();
    } finally {
      this.#holding--;
    }
  }

  /** Runs `action` when `key` is pressed outside a text field. */
  key(key: string, action: () => void): void {
    this.#keys.set(key.toLowerCase(), action);
  }

  /** A titled group of controls in the side panel. */
  section(title: string): Section {
    const section = new Section(this, title);
    this.regions.side.append(section.element);
    return section;
  }

  /** The transport: live, paused, or playing a recorded span. */
  playback(options: PlaybackOptions): Playback {
    return new Playback(this, options);
  }

  /** A readout over `view`: frames per second, its frame time, and the page's own measures. */
  meter(view: View): Meter {
    return new Meter(this, view);
  }

  /** A menu over the main view, opened where a view asks for one. */
  menu(): Menu {
    return new Menu(this);
  }

  /** A colormap ramp over the main view: at its foot, or its top over a plot's axes. */
  legend(place: 'foot' | 'top' = 'foot'): Legend {
    return new Legend(this, place);
  }

  /** A line under the main view crediting where its data comes from. */
  credit(): HTMLElement {
    const line = h('p', { class: 'credit' });
    this.regions.main.append(line);
    return line;
  }

  /** A line under the page's summary, such as what its data holds. */
  detail(text: string): void {
    this.line.textContent = text;
  }

  close(): void {
    this.#abort.abort();
    for (const canvas of this.#canvases) canvas.destroy();
    for (const view of this.#views) view.destroy();
    const { main, side, timeline } = this.regions;
    for (const region of [main, side, timeline]) region.replaceChildren();
    this.line.textContent = '';
  }
}
