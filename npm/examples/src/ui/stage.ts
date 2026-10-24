import type { Canvas, Gpu, Rect, Scene, View } from 'latkit';
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
  readonly #canvases: Canvas[] = [];
  readonly #keys = new Map<string, () => void>();

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
        const typing = (event.target as Element | null)?.closest?.(
          'input, select, textarea, button, summary, [contenteditable]',
        );
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

  /** Every canvas the page shows its views in, in the order they were made. */
  get canvases(): readonly Canvas[] {
    return this.#canvases;
  }

  /** A view in a canvas of its own, in `into`, the main region unless given. */
  view(scene: Scene, options: { label: string; into?: HTMLElement; height?: number }): View {
    return this.panels([scene], options)[0]!;
  }

  /**
   * Views sharing one canvas in `into`, the main region unless given: each `at` its x, y, width, and
   * height as fractions of the canvas, side by side unless given, and on a narrow screen one above
   * the other. Input goes to the view under it.
   */
  panels(
    scenes: readonly Scene[],
    {
      label,
      into = this.regions.main,
      height,
      at = scenes.map((_, i): Rect => [i / scenes.length, 0, 1 / scenes.length, 1]),
    }: { label: string; into?: HTMLElement; height?: number; at?: readonly Rect[] },
  ): View[] {
    const element = h('canvas', { tabindex: 0, 'aria-label': label });
    if (height) element.style.height = `${height}px`;
    into.append(element);
    const views = scenes.map((scene) => this.gpu.view(scene));
    const narrow = matchMedia('(max-width: 700px)');
    const layout = () =>
      views.map((view, i) => {
        const [x, y, width, height] = at[i]!;
        return {
          view,
          at: narrow.matches && views.length > 1 ? ([y, x, height, width] as const) : at[i],
        };
      });
    const canvas = this.gpu.canvas(element, { layout: layout() });
    this.#canvases.push(canvas);
    if (views.length > 1)
      narrow.addEventListener('change', () => (canvas.layout = layout()), { signal: this.signal });
    views.forEach((view) => {
      // What could not be fetched only goes undrawn; anything else stops the page.
      view.on('error', (error) =>
        error.code === 'io' ? this.detail(error.message) : this.fail(error),
      );
      this.#views.add(view);
    });
    return views;
  }

  /** Calls `step` every frame before the views draw, with the seconds since the last, at most 0.1. */
  frame(step: (dt: number) => void): void {
    let last: number | undefined;
    const stop = this.gpu.on('frame', (now) => {
      const dt = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      try {
        step(dt);
      } catch (error) {
        this.fail(error);
      }
    });
    this.signal.addEventListener('abort', stop);
  }

  /** Runs `action` when `key` is pressed outside a text field. */
  key(key: string, action: () => void): void {
    this.#keys.set(key.toLowerCase(), action);
  }

  /** A titled group of controls in the side panel. */
  section(title: string, open = true): Section {
    const section = new Section(this, title, open);
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

  /** Compact dataset information in the shared header. */
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
