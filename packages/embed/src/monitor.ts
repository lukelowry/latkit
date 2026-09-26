import { COLORMAPS, colormap, type ColormapName } from '@latkit/colormaps';
import { createSeries, validateSeries as checkSeries, type Series } from '@latkit/model';
import {
  OPTIONS,
  createMonitor,
  validateOptions,
  type Events,
  type Monitor,
  type Options,
} from '@latkit/monitor';

import { optionAttributes, parseOptionAttribute, type OptionAttribute } from './attributes.js';
import type { ElementSpec, ShellElement, Warn } from './element.js';
import { u32, f64, integer, optional, quote, record, required, type NumericJSON } from './json.js';

/** JSON-compatible series input accepted by {@link parseSeries}; signal-major samples, encoded. */
export interface SeriesJSON {
  readonly time: NumericJSON;
  readonly values: NumericJSON;
  readonly signalCount: number;
  readonly elementCount: number;
  readonly elements?: NumericJSON;
}

/** DOM events `latkit-monitor` dispatches; every controller event arrives with its payload as `detail`. */
export interface MonitorElementEventMap {
  /** The current data source is loaded. */
  load: Event;
  /** The current data source or the canvas failed; `ready` rejects with the same error. */
  error: CustomEvent<{ readonly error: unknown }>;
  hover: CustomEvent<Events['hover']>;
  select: CustomEvent<Events['select']>;
  attached: CustomEvent<Events['attached']>;
  deviceLost: CustomEvent<Events['deviceLost']>;
  valueRange: CustomEvent<Events['valueRange']>;
  rendered: Event;
}

/** The `latkit-monitor` element: a `Monitor` controller behind attributes and a data source. */
export interface MonitorElement extends ShellElement<Series> {
  /** The controller; every imperative verb lives here. */
  readonly monitor: Monitor;

  addEventListener<Key extends keyof MonitorElementEventMap>(
    type: Key,
    listener: ((this: MonitorElement, event: MonitorElementEventMap[Key]) => unknown) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<Key extends keyof MonitorElementEventMap>(
    type: Key,
    listener: ((this: MonitorElement, event: MonitorElementEventMap[Key]) => unknown) | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** What the monitor element reaches through; tests replace it. */
export interface MonitorDeps {
  createMonitor: typeof createMonitor;
}

/**
 * Parse and validate a JSON-compatible series.
 *
 * `time` and `values` decode to f64; number arrays may hold `null` for NaN, and
 * every slot also accepts a little-endian base64 object.
 */
export function parseSeries(input: unknown): Series {
  const source = record(input, 'root');
  const elements = optional(source, 'elements');
  return createSeries({
    time: f64(required(source, 'time', 'root'), 'time'),
    values: f64(required(source, 'values', 'root'), 'values'),
    signalCount: integer(required(source, 'signalCount', 'root'), 'signalCount'),
    elementCount: integer(required(source, 'elementCount', 'root'), 'elementCount'),
    ...(elements === undefined ? {} : { elements: u32(elements, 'elements') }),
  });
}

/** Validate an already-decoded series, as the data property receives it. */
export function validateSeries(input: unknown): Series {
  checkSeries(input as Series);
  return input as Series;
}

const OPTION_ATTRIBUTES = optionAttributes(OPTIONS);
const OPTION_BY_ATTRIBUTE: ReadonlyMap<string, OptionAttribute<keyof Options>> = new Map(
  OPTION_ATTRIBUTES.map((entry) => [entry.attribute, entry]),
);

/** Attributes in application order: options, colormap, signal. */
const ATTRIBUTES: readonly string[] = Object.freeze([
  ...OPTION_ATTRIBUTES.map((entry) => entry.attribute),
  'colormap',
  'signal',
]);

const EVENTS: readonly (keyof Events)[] = Object.freeze([
  'hover',
  'select',
  'attached',
  'deviceLost',
  'valueRange',
  'rendered',
  'error',
]);

/** The element spec for `latkit-monitor`. */
export function monitorSpec(deps: MonitorDeps): ElementSpec<Monitor, Series> {
  return {
    role: 'img',
    attributes: ATTRIBUTES,
    events: EVENTS,

    create() {
      return deps.createMonitor();
    },

    parse: parseSeries,
    validate: validateSeries,

    load(context) {
      const series = context.data!;
      const signal = signalValue(context.host.getAttribute('signal'), series, context.warn);
      context.controller.load(series, signal);
    },

    apply(context, name, value) {
      const option = OPTION_BY_ATTRIBUTE.get(name);
      if (option) {
        context.controller.setOptions({
          [option.option]: optionValue(option, value, context.host, context.warn),
        } as Options);
        return;
      }
      if (name === 'colormap') {
        context.controller.setOptions({ colormap: colormapValue(value, context.warn) });
        return;
      }
      if (name === 'signal' && context.data) {
        context.controller.setSignal(signalValue(value, context.data, context.warn));
      }
    },
  };
}

function optionValue(
  entry: OptionAttribute<keyof Options>,
  raw: string | null,
  host: HTMLElement,
  warn: Warn,
): unknown {
  if (raw === null) return entry.definition.default;
  const parsed = parseOptionAttribute(entry.definition, raw, host);
  if (parsed !== undefined) {
    try {
      validateOptions({ [entry.option]: parsed } as Options);
      return parsed;
    } catch {
      // Invalid author values warn and resolve to the Monitor default.
    }
  }
  warn(`Invalid ${entry.attribute} ${quote(raw)}; using the Monitor default.`);
  return entry.definition.default;
}

function colormapValue(raw: string | null, warn: Warn): NonNullable<Options['colormap']> {
  if (raw === null) return OPTIONS.colormap.default;
  if (Object.hasOwn(COLORMAPS, raw)) return colormap(raw as ColormapName);
  warn(`Unknown colormap ${quote(raw)}; using the Monitor default.`);
  return OPTIONS.colormap.default;
}

/** The `signal` attribute as an index into `series`, or signal 0. */
function signalValue(raw: string | null, series: Series, warn: Warn): number {
  if (raw === null) return 0;
  const signal = Number(raw.trim());
  if (Number.isInteger(signal) && signal >= 0 && signal < series.signalCount) return signal;
  warn(`Invalid signal ${quote(raw)}; showing signal 0.`);
  return 0;
}

declare global {
  interface HTMLElementTagNameMap {
    'latkit-monitor': MonitorElement;
  }
}
