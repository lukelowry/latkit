import type { Canvas, Gpu, Rect, Scene, View } from 'latkit';
import { Section } from './controls.js';
import { h } from './dom.js';
import { Legend } from './legend.js';
import { Menu } from './menu.js';
import { Meter } from './meter.js';
import { Playback, type PlaybackOptions } from './playback.js';

/** The page regions an example fills: the main view, the side panel, and the timeline. */
export interface Regions {
  main: HTMLElement;
  side: HTMLElement;
  timeline: HTMLElement;
}

/** Creates an example page's views, canvases, and controls. Everything made through it is
 * destroyed when the page closes. */
export class Stage {
  readonly #abort = new AbortController();
  /** Aborted when the page closes. Pass it to any listener the page adds itself. */
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

  /** The page's canvases, in creation order. */
  get canvases(): readonly Canvas[] {
    return this.#canvases;
  }

  /** Creates a view in its own canvas, appended to `into` (the main region by default). */
  view(scene: Scene, options: { label: string; into?: HTMLElement; height?: number }): View {
    return this.panels([scene], options)[0]!;
  }

  /**
   * Creates views that share one canvas, appended to `into` (the main region by default). Each
   * view fills its `at` rectangle: x, y, width, and height as fractions of the canvas. By default
   * the views sit side by side. On screens 700 px wide or less, each rectangle's axes swap, so the
   * views stack. Input goes to the view under the pointer.
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
      // A failed fetch (`io`) only leaves that data undrawn and is reported in the header. Any
      // other error stops the page.
      view.on('error', (error) =>
        error.code === 'io' ? this.detail(error.message) : this.fail(error),
      );
      this.#views.add(view);
    });
    return views;
  }

  /** Calls `step` every frame before the views draw, with the seconds since the previous frame,
   * capped at 0.1. */
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

  /** Runs `action` when `key` is pressed without modifiers, unless focus is in a form control. */
  key(key: string, action: () => void): void {
    this.#keys.set(key.toLowerCase(), action);
  }

  /** Adds a titled group of controls to the side panel. */
  section(title: string, open = true): Section {
    const section = new Section(this, title, open);
    this.regions.side.append(section.element);
    return section;
  }

  /** Adds the playback controls: live, paused, or playing a recorded span. */
  playback(options: PlaybackOptions): Playback {
    return new Playback(this, options);
  }

  /** Adds a performance readout for `view`, with frame rate, frame times, and the page's own
   * measurements. */
  meter(view: View): Meter {
    return new Meter(this, view);
  }

  /** Creates a context menu over the main view, to open where a view requests one. */
  menu(): Menu {
    return new Menu(this);
  }

  /** Adds a colormap legend over the main view, at the bottom, or at the top (`'top'`) so it does
   * not cover a plot's axes. */
  legend(place: 'foot' | 'top' = 'foot'): Legend {
    return new Legend(this, place);
  }

  /** Adds a line under the main view that credits the data source. */
  credit(): HTMLElement {
    const line = h('p', { class: 'credit' });
    this.regions.main.append(line);
    return line;
  }

  /** Shows short dataset information in the shared header. */
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
