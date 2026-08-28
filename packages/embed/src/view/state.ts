import { COLORMAP_NAMES, colormap, type Colormap, type ColormapName } from '@latkit/colormaps';
import {
  PROJECTION_MODES,
  channelNormalizes,
  finiteExtent,
  type Borders,
  type Channel,
  type ChannelRange,
  type Network,
  type ProjectionMode,
  type ResolvedOptions,
} from '@latkit/network';

import type { NetworkData } from '../data/types.js';
import type { DirectChannelBinding, InputRevision } from '../source.js';
import {
  CHANNEL_ATTRIBUTES,
  OPTION_ATTRIBUTES,
  parseControls,
  parseOptionAttribute,
  parseRange,
  quote,
  channelAttribute,
  warning,
  type Control,
  type ControlSelection,
  type RuntimeAttributeOption,
  type ViewWarning,
} from './attributes.js';
import { fieldsFor, type FieldCatalog, type FieldEntry } from './fields.js';

/** Runtime Network options represented directly by Embed view state. */
export type ResolvedRuntimeOptions = Readonly<Pick<ResolvedOptions, RuntimeAttributeOption>>;

/** Element-owned nonserializable configuration that survives activations. */
export interface ElementConfiguration {
  customColormap: Colormap | null;
  customColormapRevision: number;
  customBorders: Borders | null | undefined;
  customBordersRevision: number;
  consumerPaused: boolean;
  lastProjection: ProjectionMode;
}

/** Raw values captured from the element for one pure resolution pass. */
export type AttributeValues = ReadonlyMap<string, string | null>;

/** Resolved named or custom colormap. */
export type ColormapBinding =
  | { readonly kind: 'named'; readonly name: ColormapName; readonly fn: Colormap }
  | { readonly kind: 'custom'; readonly fn: Colormap; readonly revision: number };

/** Resolved disabled, packaged, or custom border source. */
export type BorderBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'natural-earth' }
  | { readonly kind: 'custom'; readonly data: Borders; readonly revision: number };

/** One resolved declarative field or direct-array channel source. */
export type ChannelBinding =
  | {
      readonly kind: 'field';
      readonly entry: FieldEntry;
      readonly baseDomain: ChannelRange | null;
      readonly domainOverride: ChannelRange | null;
      readonly outputRange?: ChannelRange;
    }
  | {
      readonly kind: 'direct';
      readonly source: DirectChannelBinding;
      readonly values: Float32Array;
      readonly baseDomain?: ChannelRange | null;
      readonly domainOverride: ChannelRange | null;
      readonly outputRange?: ChannelRange;
    };

/** Renderer-independent option state available before topology load. */
export interface OptionState {
  readonly msaa: 1 | 4 | undefined;
  readonly options: ResolvedRuntimeOptions;
  readonly colormap: ColormapBinding;
  readonly borders: BorderBinding;
  readonly warnings: readonly ViewWarning[];
}

/** Complete effective element state applied to one loaded Network. */
export interface ViewState extends OptionState {
  readonly requestedProjection: ProjectionMode;
  readonly projection: ProjectionMode;
  readonly channels: Readonly<Record<Channel, ChannelBinding | null>>;
  readonly controls: ReadonlySet<Control>;
  readonly controlsMode: ControlSelection['mode'];
}

/** Interaction state used by captions, navigation, and durable selection. */
export interface InteractionState {
  readonly hover: readonly ['vertex' | 'edge', number] | null;
  readonly selected: readonly ['vertex' | 'edge', number] | null;
  readonly atFitView: boolean;
}

const COLORMAPS = new Set<string>(COLORMAP_NAMES);
const DEFAULT_FIELD_CHANNEL: Channel = 'vertexColor';

/** Resolve construction/runtime options without requiring loaded topology. */
export function resolveOptionState(
  attributes: AttributeValues,
  configuration: ElementConfiguration,
): OptionState {
  const warnings: ViewWarning[] = [];
  const runtime = {} as Record<RuntimeAttributeOption, unknown>;
  let msaa: ResolvedOptions['msaa'] = undefined;

  for (const entry of OPTION_ATTRIBUTES) {
    const value = parseOptionAttribute(entry, valueOf(attributes, entry.attribute), warnings);
    if (entry.definition.lifecycle === 'construction') {
      if (entry.option === 'msaa') msaa = value as ResolvedOptions['msaa'];
    } else {
      (runtime as Record<string, unknown>)[entry.option] = value;
    }
  }

  return Object.freeze({
    msaa,
    options: Object.freeze(runtime) as unknown as ResolvedRuntimeOptions,
    colormap: resolveColormap(attributes, configuration, warnings),
    borders: resolveBorders(attributes, configuration, warnings),
    warnings: Object.freeze(warnings),
  });
}

/** Resolve complete renderer/chrome state from one source revision and attribute snapshot. */
export function resolveView(
  data: NetworkData,
  attributes: AttributeValues,
  available: Network['projections'],
  configuration: ElementConfiguration,
  input: InputRevision,
): ViewState {
  const optionState = resolveOptionState(attributes, configuration);
  const warnings = [...optionState.warnings];
  const fields = fieldsFor(data);
  const channels = {} as Record<Channel, ChannelBinding | null>;

  for (const definition of CHANNEL_ATTRIBUTES) {
    channels[definition.key] = resolveChannel(
      definition.key,
      fields,
      attributes,
      input.directChannels[definition.key],
      warnings,
    );
  }

  const requestedProjection = resolveRequestedProjection(attributes, warnings);
  const projection = resolveEffectiveProjection(
    requestedProjection,
    configuration.lastProjection,
    available,
  );
  const selection = parseControls(valueOf(attributes, 'controls'), warnings);
  const controls = resolveControls(selection, fields, channels, available, input);

  return Object.freeze({
    ...optionState,
    requestedProjection,
    projection,
    channels: Object.freeze(channels),
    controls,
    controlsMode: selection.mode,
    warnings: Object.freeze(warnings),
  });
}

/** Return the effective normalized input domain used by a bound channel. */
export function effectiveChannelDomain(binding: ChannelBinding): ChannelRange {
  return binding.domainOverride ?? binding.baseDomain ?? [0, 1];
}

/** Return the values behind either binding representation. */
export function channelValues(binding: ChannelBinding): Float32Array {
  return binding.kind === 'field' ? binding.entry.field.values : binding.values;
}

/** Validate deferred direct binding cardinality against resolved topology. */
export function validateDirectChannelLengths(data: NetworkData, input: InputRevision): void {
  const edgeCount = data.topology.edges.length / 2;
  for (const definition of CHANNEL_ATTRIBUTES) {
    const binding = input.directChannels[definition.key];
    if (!binding) continue;
    const expected = definition.scope === 'vertex' ? data.topology.vertexCount : edgeCount;
    if (binding.values.length !== expected) {
      throw new Error(
        `@latkit/embed: network channel ${definition.key} length ${binding.values.length} != ${expected}`,
      );
    }
  }
}

function resolveColormap(
  attributes: AttributeValues,
  configuration: ElementConfiguration,
  warnings: ViewWarning[],
): ColormapBinding {
  if (configuration.customColormap) {
    return Object.freeze({
      kind: 'custom',
      fn: configuration.customColormap,
      revision: configuration.customColormapRevision,
    });
  }

  const raw = valueOf(attributes, 'colormap');
  const name = raw === null ? 'viridis' : raw;
  if (COLORMAPS.has(name)) {
    const typedName = name as ColormapName;
    return Object.freeze({ kind: 'named', name: typedName, fn: colormap(typedName) });
  }

  warnings.push(
    warning('colormap', raw!, `Unknown colormap ${quote(raw!)}; using ${quote('viridis')}.`),
  );
  return Object.freeze({ kind: 'named', name: 'viridis', fn: colormap('viridis') });
}

function resolveBorders(
  attributes: AttributeValues,
  configuration: ElementConfiguration,
  warnings: ViewWarning[],
): BorderBinding {
  if (configuration.customBorders !== undefined) {
    return configuration.customBorders === null
      ? Object.freeze({ kind: 'none' })
      : Object.freeze({
          kind: 'custom',
          data: configuration.customBorders,
          revision: configuration.customBordersRevision,
        });
  }

  const raw = valueOf(attributes, 'border-source');
  if (raw === null || raw === 'none') return Object.freeze({ kind: 'none' });
  if (raw === 'natural-earth') return Object.freeze({ kind: 'natural-earth' });
  warnings.push(
    warning('border-source', raw, `Unknown border source ${quote(raw)}; using ${quote('none')}.`),
  );
  return Object.freeze({ kind: 'none' });
}

function resolveRequestedProjection(
  attributes: AttributeValues,
  warnings: ViewWarning[],
): ProjectionMode {
  const raw = valueOf(attributes, 'projection');
  if (raw === null) return 'flat';
  if ((PROJECTION_MODES as readonly string[]).includes(raw)) return raw as ProjectionMode;
  warnings.push(
    warning('projection', raw, `Unknown projection ${quote(raw)}; using ${quote('flat')}.`),
  );
  return 'flat';
}

function resolveEffectiveProjection(
  requested: ProjectionMode,
  previous: ProjectionMode,
  available: Network['projections'],
): ProjectionMode {
  if (available[requested]) return requested;
  if (available[previous]) return previous;
  return 'flat';
}

function resolveChannel(
  channel: Channel,
  fields: FieldCatalog,
  attributes: AttributeValues,
  direct: DirectChannelBinding | undefined,
  warnings: ViewWarning[],
): ChannelBinding | null {
  const definition = channelAttribute(channel);
  const normalizes = channelNormalizes(definition);
  const domainOverride = definition.domainAttribute
    ? parseRange(
        definition.domainAttribute,
        valueOf(attributes, definition.domainAttribute),
        warnings,
      )
    : null;
  const rangeOverride = definition.rangeAttribute
    ? parseRange(
        definition.rangeAttribute,
        valueOf(attributes, definition.rangeAttribute),
        warnings,
      )
    : null;

  if (direct) {
    const baseDomain = normalizes
      ? definition.map === 'height' && direct.baseDomain == null
        ? (finiteExtent(direct.values) ?? ([0, 1] as const))
        : copyOptionalRange(direct.baseDomain)
      : null;
    return Object.freeze({
      kind: 'direct',
      source: direct,
      values: direct.values,
      baseDomain,
      domainOverride,
      ...(definition.map === 'height'
        ? { outputRange: rangeOverride ?? copyRange(direct.outputRange ?? [0, 1]) }
        : {}),
    });
  }

  const raw = valueOf(attributes, definition.attribute);
  let entry: FieldEntry | null;
  if (raw === null) {
    entry = channel === DEFAULT_FIELD_CHANNEL ? (fields[definition.scope][0] ?? null) : null;
  } else if (raw === '') {
    entry = null;
  } else {
    entry = fields.byId.get(raw) ?? null;
    if (!entry) {
      warnings.push(
        warning(
          definition.attribute,
          raw,
          `Unknown field ${quote(raw)} for ${definition.attribute}; leaving ${channel} unbound.`,
        ),
      );
    } else if (entry.field.scope !== definition.scope) {
      warnings.push(
        warning(
          definition.attribute,
          raw,
          `Field ${quote(raw)} is ${entry.field.scope}-scoped and cannot bind ${channel}.`,
        ),
      );
      entry = null;
    }
  }

  if (!entry) return null;
  return Object.freeze({
    kind: 'field',
    entry,
    baseDomain: normalizes ? (copyOptionalRange(entry.extent) ?? null) : null,
    domainOverride,
    ...(definition.map === 'height' ? { outputRange: rangeOverride ?? ([0, 1] as const) } : {}),
  });
}

function resolveControls(
  selection: ControlSelection,
  fields: FieldCatalog,
  channels: Readonly<Record<Channel, ChannelBinding | null>>,
  available: Network['projections'],
  input: InputRevision,
): ReadonlySet<Control> {
  if (selection.mode === 'none') return new Set();
  if (selection.mode === 'explicit') return new Set(selection.controls);

  const controls = new Set<Control>(['caption', 'fit', 'zoom']);
  if (PROJECTION_MODES.filter((mode) => available[mode]).length >= 2) controls.add('projection');

  let colorPicker = false;
  let colorBinding = false;
  for (const definition of CHANNEL_ATTRIBUTES) {
    const meaningful =
      fields[definition.scope].length > 0 || input.directChannels[definition.key] !== undefined;
    if (meaningful) {
      controls.add(definition.attribute);
      if (definition.map === 'colormap') colorPicker = true;
    }
    if (definition.map === 'colormap' && channels[definition.key]) {
      colorBinding = true;
      controls.add(`${definition.attribute}-legend` as Control);
    }
  }
  if (colorPicker || colorBinding) controls.add('colormap');
  return controls;
}

function valueOf(attributes: AttributeValues, name: string): string | null {
  return attributes.get(name) ?? null;
}

function copyOptionalRange(
  range: ChannelRange | null | undefined,
): ChannelRange | null | undefined {
  return range === undefined ? undefined : range === null ? null : copyRange(range);
}

function copyRange(range: ChannelRange): ChannelRange {
  return [range[0], range[1]];
}
