import type { Gpu, Scene, View } from 'latkit';
import { Section } from './controls.js';
import { h } from './dom.js';
import { Legend } from './legend.js';
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
  view(
    scene: Scene,
    {
      label,
      into = this.regions.main,
      height,
    }: { label: string; into?: HTMLElement; height?: number },
  ): View {
    const canvas = h('canvas', { tabindex: 0, 'aria-label': label });
    if (height) canvas.style.height = `${height}px`;
    into.append(canvas);
    const view = this.gpu.view(canvas, scene);
    view.on('error', this.fail);
    this.#views.add(view);
    return view;
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

  /** A colormap ramp over the main view. */
  legend(): Legend {
    return new Legend(this);
  }

  /** A line under the page's summary, such as what its data holds. */
  detail(text: string): void {
    this.line.textContent = text;
  }

  close(): void {
    this.#abort.abort();
    for (const view of this.#views) view.destroy();
    for (const region of Object.values(this.regions)) region.replaceChildren();
    this.line.textContent = '';
  }
}
