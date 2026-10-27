/**
 * What an example page declares. A page is its settings, which the shell shows as controls, and an
 * `open` that builds its data and views. Each view's scene is a function of the settings, which the
 * shell draws again whenever one changes, so a page holds no code that restyles its views.
 */
import type { Camera, Data, Rect, Scene, View } from 'latkit';

/** One value of a page's settings and the control that sets it. */
export type Setting<T> = {
  readonly label: string;
  readonly value: T;
  /** The side panel section it shows in; `Settings` by default. */
  readonly section?: string;
  /** A key that changes it: a toggle flips, and a choice steps to its next option. */
  readonly key?: string;
} & (
  | { readonly kind: 'choice'; readonly options: readonly (readonly [string, T])[] }
  | { readonly kind: 'toggle' }
  | {
      readonly kind: 'range';
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly format: (value: number) => string;
    }
);

type Where = { section?: string; key?: string };

/** A dropdown of `options`, keyed by their labels; the first option by default. */
export function choice<const T>(
  label: string,
  options: Readonly<Record<string, T>>,
  where: Where & { value?: T } = {},
): Setting<T> {
  const entries = Object.entries(options);
  return {
    kind: 'choice',
    label,
    options: entries,
    value: where.value ?? entries[0]![1],
    ...where,
  };
}

/** A button that toggles; off by default. */
export function toggle(label: string, where: Where & { value?: boolean } = {}): Setting<boolean> {
  return { kind: 'toggle', label, ...where, value: where.value ?? false };
}

/** A slider. */
export function range(
  label: string,
  o: { min: number; max: number; step: number; value: number; format: (value: number) => string },
  where: Where = {},
): Setting<number> {
  return { kind: 'range', label, ...o, ...where };
}

export type Settings = Readonly<Record<string, Setting<unknown>>>;
/** The current values of `S`. */
export type Values<S extends Settings> = { -readonly [K in keyof S]: S[K]['value'] };

/** A button, also run by its key. */
export interface Action {
  readonly label: string;
  readonly key?: string;
  readonly run: () => void;
  /** Runs `run` on press and `release` on release, for an action held down. */
  readonly release?: () => void;
}

/** The recorded span of a dataset with an axis, played live, paused, or replayed. */
export interface Timeline {
  readonly mode: 'live' | 'playing' | 'paused';
  /** The axis coordinate every view of the page shows. */
  readonly at: number;
  /** Goes live, following the end of the data. */
  play(): void;
}

/** What a page can do while it is open. Everything it makes through it closes with it. */
export interface Context<V> {
  /** The current settings. */
  readonly settings: Readonly<V>;
  /** Aborted when the page closes. */
  readonly signal: AbortSignal;
  /**
   * Creates a view on the page's canvas, in `region`, drawing `scene` of the current settings and
   * again after each change. Without a camera, it frames everything drawn.
   */
  view(
    scene: (settings: V) => Scene,
    options?: { region?: Rect; camera?: Camera; label?: string },
  ): Promise<View>;
  /** Adds buttons to the side panel, in section `title`. */
  actions(title: string, actions: readonly Action[]): void;
  /**
   * Plays `data`'s axis in a timeline under the canvas. Live, it follows the end of the data and
   * forgets frames older than `keep` seconds; paused or replaying, it shows earlier frames. Every
   * view of the page shows the timeline's coordinate.
   */
  timeline(options: {
    data: Data;
    keep?: number;
    /** Plays back the last `seconds` at `rate`. */
    replay?: { seconds: number; rate: number };
    /** Called after the views move to coordinate `at`. */
    show?(at: number): void;
    /** Called when the timeline goes live or stops being live. */
    change?(live: boolean): void;
  }): Timeline;
  /** Calls `step` every animation frame while the page is live, with the seconds since the last. */
  frame(step: (dt: number) => void): void;
  /** Lists the colors of a view's series in the side panel. */
  series(title: string, items: readonly { label: string; color: string }[]): void;
  /** Shows short text in the header, such as the page's counts or what is loading. */
  detail(text: string): void;
  /** Credits the data's source under the canvas. */
  credit(text: string): void;
  /** Shows the page as failed with `error`, such as from work it finishes after opening. */
  fail(error: unknown): void;
}

/** Nothing, or a function to run once the views draw the new settings. */
export type Changed = void | (() => void);

/** What a page returns from `open`. */
export interface Opened<V> {
  /**
   * Called when setting `key` changes, before the views draw the new settings. It may return a
   * function to run once they do, such as one that frames what they now draw.
   */
  change?(settings: V, key: keyof V): Changed | Promise<Changed>;
}

export interface Page<S extends Settings = Settings> {
  readonly title: string;
  readonly settings?: S;
  /** Whether hovering or clicking a row shows its fields in the side panel; true by default. */
  readonly inspect?: boolean;
  open(context: Context<Values<S>>): Promise<Opened<Values<S>> | void>;
}

/** Declares a page, typing its settings' values. */
export function page<S extends Settings>(page: Page<S>): Page<S> {
  return page;
}
