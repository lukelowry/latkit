import { COLORMAPS, colormap, type ColormapName } from '@latkit/colormaps';
import { validateTopology, type Domain, type Topology } from '@latkit/model';
import {
  CHANNELS,
  OPTIONS,
  PROJECTIONS,
  createNetwork,
  validateOptions,
  type Borders,
  type Channel,
  type Events,
  type Network,
  type Options,
  type Projection,
} from '@latkit/network';

import {
  decimalPair,
  htmlName,
  optionAttributes,
  parseOptionAttribute,
  type OptionAttribute,
} from './attributes.js';
import type { Context, ElementSpec, ShellElement, Warn } from './element.js';
import {
  f32,
  fail,
  integer,
  isTypedArray,
  optional,
  quote,
  record,
  required,
  string,
  u32,
  type NumericJSON,
} from './json.js';

/** One static scalar field over network vertices or edges, bound to channels by id. */
export interface NetworkField {
  readonly id: string;
  readonly scope: 'vertex' | 'edge';
  readonly values: Float32Array;
}

/** Decoded, renderer-ready network input. */
export interface NetworkData {
  readonly topology: Topology;
  readonly fields?: readonly NetworkField[];
}

/** JSON-compatible network input accepted by {@link parseNetwork}. */
export interface NetworkJSON {
  readonly topology: {
    readonly vertexCount: number;
    readonly vertexCoords?: NumericJSON;
    readonly coordinateSpace?: 'cartesian' | 'geographic';
    readonly edges: NumericJSON;
    readonly polylineStart?: NumericJSON;
    readonly polylinePoints?: NumericJSON;
  };
  readonly fields?: readonly {
    readonly id: string;
    readonly scope: 'vertex' | 'edge';
    readonly values: NumericJSON;
  }[];
}

/** DOM events `latkit-network` dispatches; every controller event arrives with its payload as `detail`. */
export interface NetworkElementEventMap {
  /** The current data source is loaded. */
  load: Event;
  /** The current data source or the canvas failed; `ready` rejects with the same error. */
  error: CustomEvent<{ readonly error: unknown }>;
  hover: CustomEvent<Events['hover']>;
  select: CustomEvent<Events['select']>;
  fit: CustomEvent<Events['fit']>;
  orbit: CustomEvent<Events['orbit']>;
  attached: CustomEvent<Events['attached']>;
  deviceLost: CustomEvent<Events['deviceLost']>;
  pipelineError: CustomEvent<Events['pipelineError']>;
}

/** The `latkit-network` element: a `Network` controller behind attributes and a data source. */
export interface NetworkElement extends ShellElement<NetworkData> {
  /** The controller; every imperative verb lives here. Created on first access with the `msaa` attribute. */
  readonly network: Network;

  addEventListener<Key extends keyof NetworkElementEventMap>(
    type: Key,
    listener: ((this: NetworkElement, event: NetworkElementEventMap[Key]) => unknown) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<Key extends keyof NetworkElementEventMap>(
    type: Key,
    listener: ((this: NetworkElement, event: NetworkElementEventMap[Key]) => unknown) | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** What the network element reaches through; tests replace both. */
export interface NetworkDeps {
  createNetwork: typeof createNetwork;
  loadBorders(signal?: AbortSignal): Promise<Borders>;
}

/**
 * Parse and validate JSON-compatible network data.
 *
 * Numeric slots accept number arrays or little-endian base64 objects. The returned arrays are
 * newly owned typed arrays; `polylineStart` defaults to straight edges.
 */
export function parseNetwork(input: unknown): NetworkData {
  const root = record(input, 'root');
  const topology = parseTopology(required(root, 'topology', 'root'));
  const fieldsSlot = optional(root, 'fields');
  const data: NetworkData =
    fieldsSlot === undefined ? { topology } : { topology, fields: parseFields(fieldsSlot) };
  return validateNetworkData(data);
}

/** Validate already-decoded network data, as the `data` property receives it. */
export function validateNetworkData(input: unknown): NetworkData {
  const data = record(input, 'data');
  const topology = record(data.topology, 'topology') as unknown as Topology;
  validateTopology(topology);
  const fields = data.fields;
  if (fields === undefined) return data as unknown as NetworkData;
  if (!Array.isArray(fields)) fail('fields', 'must be an array');
  const ids = new Set<string>();
  for (let index = 0; index < fields.length; index++) {
    const path = `fields[${index}]`;
    const field = record(fields[index], path);
    const id = string(field.id, `${path}.id`);
    if (id.trim().length === 0) fail(`${path}.id`, 'must not be empty');
    if (ids.has(id)) fail(`${path}.id`, `duplicates ${quote(id)}`);
    ids.add(id);
    const scope = field.scope;
    if (scope !== 'vertex' && scope !== 'edge') fail(`${path}.scope`, 'must be "vertex" or "edge"');
    if (!isTypedArray(field.values, 'Float32Array')) {
      fail(`${path}.values`, 'must be a Float32Array');
    }
    const expected = scope === 'vertex' ? topology.vertexCount : topology.edges.length / 2;
    const length = (field.values as Float32Array).length;
    if (length !== expected) fail(`${path}.values`, `length ${length} != ${expected}`);
  }
  return data as unknown as NetworkData;
}

function parseTopology(input: unknown): Topology {
  const source = record(input, 'topology');
  const vertexCount = integer(required(source, 'vertexCount', 'topology'), 'topology.vertexCount');
  const coordsSlot = optional(source, 'vertexCoords');
  const spaceSlot = optional(source, 'coordinateSpace');
  if (spaceSlot !== undefined && spaceSlot !== 'cartesian' && spaceSlot !== 'geographic') {
    fail('topology.coordinateSpace', 'must be "cartesian" or "geographic"');
  }
  const edges = u32(required(source, 'edges', 'topology'), 'topology.edges');
  const pointsSlot = optional(source, 'polylinePoints');
  const startSlot = optional(source, 'polylineStart');
  return {
    vertexCount,
    ...(coordsSlot === undefined ? {} : { vertexCoords: f32(coordsSlot, 'topology.vertexCoords') }),
    ...(spaceSlot === undefined ? {} : { coordinateSpace: spaceSlot }),
    edges,
    polylineStart:
      startSlot === undefined
        ? new Uint32Array(Math.floor(edges.length / 2) + 1)
        : u32(startSlot, 'topology.polylineStart'),
    ...(pointsSlot === undefined
      ? {}
      : { polylinePoints: f32(pointsSlot, 'topology.polylinePoints') }),
  };
}

function parseFields(input: unknown): readonly NetworkField[] {
  if (!Array.isArray(input)) fail('fields', 'must be an array');
  return input.map((item, index) => {
    const path = `fields[${index}]`;
    const source = record(item, path);
    const scope = string(required(source, 'scope', path), `${path}.scope`);
    if (scope !== 'vertex' && scope !== 'edge') fail(`${path}.scope`, 'must be "vertex" or "edge"');
    return {
      id: string(required(source, 'id', path), `${path}.id`),
      scope,
      values: f32(required(source, 'values', path), `${path}.values`),
    };
  });
}

const OPTION_ATTRIBUTES = optionAttributes(OPTIONS);
const OPTION_BY_ATTRIBUTE: ReadonlyMap<string, OptionAttribute<keyof Options>> = new Map(
  OPTION_ATTRIBUTES.map((entry) => [entry.attribute, entry]),
);

interface ChannelAttribute {
  readonly key: Channel;
  readonly attribute: string;
  readonly domainAttribute: string | null;
}

const CHANNEL_ATTRIBUTES: readonly ChannelAttribute[] = (Object.keys(CHANNELS) as Channel[]).map(
  (key) => ({
    key,
    attribute: htmlName(key),
    domainAttribute: CHANNELS[key].normalized ? `${htmlName(key)}-domain` : null,
  }),
);
const CHANNEL_BY_ATTRIBUTE = new Map(CHANNEL_ATTRIBUTES.map((entry) => [entry.attribute, entry]));
const CHANNEL_BY_DOMAIN_ATTRIBUTE = new Map(
  CHANNEL_ATTRIBUTES.flatMap((entry) =>
    entry.domainAttribute ? [[entry.domainAttribute, entry] as const] : [],
  ),
);

/** Attributes in application order: options, colormap, channels, their domains, projection. */
const ATTRIBUTES: readonly string[] = Object.freeze([
  ...OPTION_ATTRIBUTES.map((entry) => entry.attribute),
  'colormap',
  ...CHANNEL_ATTRIBUTES.map((entry) => entry.attribute),
  ...CHANNEL_BY_DOMAIN_ATTRIBUTE.keys(),
  'projection',
]);

const EVENTS: readonly (keyof Events)[] = Object.freeze([
  'hover',
  'select',
  'fit',
  'orbit',
  'attached',
  'deviceLost',
  'pipelineError',
]);

interface BorderState {
  request: AbortController | null;
  applied: boolean;
}

/** The element spec for `latkit-network`. */
export function networkSpec(deps: NetworkDeps): ElementSpec<Network, NetworkData> {
  const borders = new WeakMap<HTMLElement, BorderState>();

  function borderState(host: HTMLElement): BorderState {
    let state = borders.get(host);
    if (!state) borders.set(host, (state = { request: null, applied: false }));
    return state;
  }

  /** Load the packaged borders once the attribute asks and the topology is geographic. */
  function syncBorders(context: Context<Network, NetworkData>, on: boolean): void {
    const state = borderState(context.host);
    if (!on) {
      state.request?.abort();
      state.request = null;
      if (state.applied) {
        context.controller.setBorders(null);
        state.applied = false;
      }
      return;
    }
    if (state.applied || state.request || !context.controller.geographic) return;
    const request = new AbortController();
    state.request = request;
    deps.loadBorders(request.signal).then(
      (payload) => {
        if (state.request !== request) return;
        state.request = null;
        context.controller.setBorders(payload);
        state.applied = true;
      },
      (error: unknown) => {
        if (state.request !== request) return;
        state.request = null;
        context.warn('Natural Earth borders could not be loaded; continuing without them.', error);
      },
    );
  }

  return {
    role: 'application',
    attributes: ATTRIBUTES,
    events: EVENTS,

    create(host, warn) {
      const raw = host.getAttribute('msaa');
      let msaa: 1 | 4 | undefined;
      if (raw === '1' || raw === '4') msaa = Number(raw) as 1 | 4;
      else if (raw !== null) warn(`Invalid msaa ${quote(raw)}; using the Network default.`);
      return deps.createNetwork(msaa === undefined ? {} : { msaa });
    },

    parse: parseNetwork,
    validate: validateNetworkData,

    load(context) {
      context.controller.load(context.data!.topology);
    },

    apply(context, name, value) {
      const option = OPTION_BY_ATTRIBUTE.get(name);
      if (option) {
        if (!option.definition.live) {
          context.warn(
            `${name} is read when the network is created; set it before the element connects.`,
          );
          return;
        }
        const resolved = optionValue(option, value, context.warn);
        context.controller.setOptions({ [option.option]: resolved } as Options);
        if (option.option === 'borders') syncBorders(context, value !== null && resolved === true);
        return;
      }
      if (name === 'colormap') {
        context.controller.setOptions({ colormap: colormapValue(value, context.warn) });
        return;
      }
      if (name === 'projection') {
        if (value === null) return;
        if ((PROJECTIONS as readonly string[]).includes(value)) {
          context.controller.setProjection(value as Projection, true);
        } else {
          context.warn(`Unknown projection ${quote(value)}; keeping the current one.`);
        }
        return;
      }
      const channel = CHANNEL_BY_ATTRIBUTE.get(name);
      if (channel) {
        bindChannel(context, channel, value);
        return;
      }
      const domainOf = CHANNEL_BY_DOMAIN_ATTRIBUTE.get(name);
      if (domainOf) {
        context.controller.setChannelDomain(domainOf.key, domainValue(name, value, context.warn));
      }
    },
  };
}

/** Resolve one option attribute through the registry's kind and Network's validation. */
function optionValue(
  entry: OptionAttribute<keyof Options>,
  raw: string | null,
  warn: Warn,
): unknown {
  if (raw === null) return entry.definition.default;
  const parsed = parseOptionAttribute(entry.definition, raw);
  if (parsed !== undefined) {
    try {
      validateOptions({ [entry.option]: parsed } as Options);
      return parsed;
    } catch {
      // Invalid author values warn and resolve to the Network default.
    }
  }
  warn(`Invalid ${entry.attribute} ${quote(raw)}; using the Network default.`);
  return entry.definition.default;
}

function colormapValue(raw: string | null, warn: Warn): NonNullable<Options['colormap']> {
  if (raw === null) return OPTIONS.colormap.default;
  if (Object.hasOwn(COLORMAPS, raw)) return colormap(raw as ColormapName);
  warn(`Unknown colormap ${quote(raw)}; using the Network default.`);
  return OPTIONS.colormap.default;
}

function domainValue(attribute: string, raw: string | null, warn: Warn): Domain | null {
  if (raw === null) return null;
  const pair = decimalPair(raw);
  if (pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[0] <= pair[1]) {
    return pair;
  }
  warn(`Invalid ${attribute} ${quote(raw)}; ignoring it.`);
  return null;
}

function bindChannel(
  context: Context<Network, NetworkData>,
  channel: ChannelAttribute,
  value: string | null,
): void {
  const id = value?.trim() ?? '';
  if (id === '') {
    context.controller.setChannel(channel.key, null);
    return;
  }
  if (!context.data) return; // applied again once the data source loads
  const scope = CHANNELS[channel.key].scope;
  const field = context.data.fields?.find((entry) => entry.id === id && entry.scope === scope);
  if (!field) {
    context.warn(`No ${scope} field ${quote(id)} for ${channel.attribute}; leaving it unbound.`);
    context.controller.setChannel(channel.key, null);
    return;
  }
  const domain = channel.domainAttribute
    ? domainValue(
        channel.domainAttribute,
        context.host.getAttribute(channel.domainAttribute),
        context.warn,
      )
    : null;
  context.controller.setChannel(channel.key, field.values, domain);
}

declare global {
  interface HTMLElementTagNameMap {
    'latkit-network': NetworkElement;
  }
}
