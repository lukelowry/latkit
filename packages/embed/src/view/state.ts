import { COLORMAPS, colormap, type Colormap, type ColormapName } from '@latkit/colormaps';
import {
  PROJECTIONS,
  type Borders,
  type Channel,
  type Domain,
  type Item,
  type Network,
  type Options,
  type Projection,
} from '@latkit/network';

import type { NetworkData } from '../data/types.js';
import type { DirectChannelBinding, InputRevision } from '../source.js';
import {
  CHANNEL_ATTRIBUTES,
  OPTION_ATTRIBUTES,
  parseControls,
  parseDomain,
  parseOptionAttribute,
  quote,
  warning,
  type Control,
  type ControlSelection,
  type RuntimeAttributeOption,
  type ViewWarning,
} from './attributes.js';
import { fieldsFor, type FieldCatalog, type FieldEntry } from './fields.js';

/** Live Network options represented directly by Embed view state, fully resolved. */
export type ResolvedRuntimeOptions = Readonly<{
  [Key in RuntimeAttributeOption]: NonNullable<Options[Key]>;
}>;

/** Element-owned nonserializable configuration that survives activations. */
export interface ElementConfiguration {
  customColormap: Colormap | null;
  customColormapRevision: number;
  customBorders: Borders | null | undefined;
  customBordersRevision: number;
  consumerPaused: boolean;
  lastProjection: Projection;
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

/**
 * One resolved declarative field or direct-array channel source.
 *
 * `baseDomain` is the input domain handed to Network with the values: a field's finite extent,
 * a direct binding's retained domain, or `null`/`undefined` to let Network scan or default.
 */
export type ChannelBinding =
  | {
      readonly kind: 'field';
      readonly entry: FieldEntry;
      readonly baseDomain: Domain | null;
      readonly domainOverride: Domain | null;
    }
  | {
      readonly kind: 'direct';
      readonly source: DirectChannelBinding;
      readonly values: Float32Array;
      readonly baseDomain?: Domain | null;
      readonly domainOverride: Domain | null;
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
  readonly requestedProjection: Projection;
  readonly projection: Projection;
  readonly channels: Readonly<Record<Channel, ChannelBinding | null>>;
  readonly controls: ReadonlySet<Control>;
  readonly controlsMode: ControlSelection['mode'];
}

/** Interaction state used by captions, navigation, and durable selection. */
export interface InteractionState {
  readonly hover: Item | null;
  readonly selected: Item | null;
  readonly atFitView: boolean;
}

const DEFAULT_FIELD_CHANNEL: Channel = 'vertexColor';

/** Resolve construction/runtime options without requiring loaded topology. */
export function resolveOptionState(
  attributes: AttributeValues,
  configuration: ElementConfiguration,
): OptionState {
  const warnings: ViewWarning[] = [];
  const runtime = {} as Record<RuntimeAttributeOption, unknown>;
  let msaa: OptionState['msaa'] = undefined;

  for (const entry of OPTION_ATTRIBUTES) {
    const value = parseOptionAttribute(entry, valueOf(attributes, entry.attribute), warnings);
    if (entry.definition.live) {
      (runtime as Record<string, unknown>)[entry.option] = value;
    } else if (entry.option === 'msaa') {
      msaa = value as OptionState['msaa'];
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
      definition,
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
export function effectiveChannelDomain(binding: ChannelBinding): Domain {
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
  if (Object.hasOwn(COLORMAPS, name)) {
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
): Projection {
  const raw = valueOf(attributes, 'projection');
  if (raw === null) return 'flat';
  if ((PROJECTIONS as readonly string[]).includes(raw)) return raw as Projection;
  warnings.push(
    warning('projection', raw, `Unknown projection ${quote(raw)}; using ${quote('flat')}.`),
  );
  return 'flat';
}

function resolveEffectiveProjection(
  requested: Projection,
  previous: Projection,
  available: Network['projections'],
): Projection {
  if (available[requested]) return requested;
  if (available[previous]) return previous;
  return 'flat';
}

function resolveChannel(
  definition: (typeof CHANNEL_ATTRIBUTES)[number],
  fields: FieldCatalog,
  attributes: AttributeValues,
  direct: DirectChannelBinding | undefined,
  warnings: ViewWarning[],
): ChannelBinding | null {
  const channel = definition.key;
  const domainOverride = definition.domainAttribute
    ? parseDomain(
        definition.domainAttribute,
        valueOf(attributes, definition.domainAttribute),
        warnings,
      )
    : null;

  if (direct) {
    return Object.freeze({
      kind: 'direct',
      source: direct,
      values: direct.values,
      baseDomain: definition.normalized ? copyOptionalDomain(direct.baseDomain) : null,
      domainOverride,
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
    baseDomain: definition.normalized ? (copyOptionalDomain(entry.extent) ?? null) : null,
    domainOverride,
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
  if (PROJECTIONS.filter((mode) => available[mode]).length >= 2) controls.add('projection');

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

function copyOptionalDomain(domain: Domain | null | undefined): Domain | null | undefined {
  return domain === undefined ? undefined : domain === null ? null : [domain[0], domain[1]];
}
