import type { Network } from '@latkit/network';

import type { NetworkData } from '../src/data/types.js';
import {
  createInputRevision,
  type DirectChannelBinding,
  type InputRevision,
} from '../src/source.js';
import { VIEW_ATTRIBUTES } from '../src/view/attributes.js';
import {
  resolveView,
  type AttributeValues,
  type ElementConfiguration,
  type InteractionState,
  type ViewState,
} from '../src/view/state.js';

export const ALL_PROJECTIONS: Network['projections'] = Object.freeze({
  flat: true,
  tilt: true,
  globe: true,
});

export const NO_INTERACTION: InteractionState = Object.freeze({
  hover: null,
  selected: null,
  atFitView: true,
});

export function attributeValues(
  overrides: Readonly<Record<string, string | null | undefined>> = {},
): AttributeValues {
  const values = new Map<string, string | null>(
    VIEW_ATTRIBUTES.map((name) => [name, null] as const),
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) values.set(name, value);
  }
  return values;
}

export function elementConfiguration(
  overrides: Partial<ElementConfiguration> = {},
): ElementConfiguration {
  return {
    customColormap: null,
    customColormapRevision: 0,
    customBorders: undefined,
    customBordersRevision: 0,
    consumerPaused: false,
    lastProjection: 'flat',
    ...overrides,
  };
}

export function inputRevision(
  data: NetworkData,
  directChannels: InputRevision['directChannels'] = {},
): InputRevision {
  const input = createInputRevision({ kind: 'inline' });
  input.decoded = data;
  Object.assign(input.directChannels, directChannels);
  return input;
}

export function direct(values: Float32Array, binding: Omit<DirectChannelBinding, 'values'> = {}) {
  return { values, ...binding } satisfies DirectChannelBinding;
}

export function resolvedView(
  data: NetworkData,
  attributes: Readonly<Record<string, string | null | undefined>> = {},
  options: {
    readonly projections?: Network['projections'];
    readonly configuration?: Partial<ElementConfiguration>;
    readonly input?: InputRevision;
  } = {},
): ViewState {
  const input = options.input ?? inputRevision(data);
  return resolveView(
    data,
    attributeValues(attributes),
    options.projections ?? ALL_PROJECTIONS,
    elementConfiguration(options.configuration),
    input,
  );
}
