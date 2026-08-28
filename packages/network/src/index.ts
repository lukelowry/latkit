/** Creates a WebGPU network renderer on a caller-owned canvas. */
export { createNetwork } from './controller.js';

/** Public network controller types and construction options. */
export type { Network, Events, Item, RevealOptions } from './controller.js';

/** Canonical renderer options, defaults, validation kinds, and mutation lifecycle. */
export { DEFAULT_OPTIONS, OPTION_DEFINITIONS, validateOption, validateOptions } from './options.js';
export type {
  ConstructionOption,
  NetworkColormap,
  OptionDefinition,
  OptionKeyByLifecycle,
  Options,
  ResolvedOptions,
  RuntimeOptionDefinition,
  RuntimeOption,
} from './options.js';

/** Rendering-channel names and normalization options. */
export { CHANNEL_DEFINITIONS, channelNormalizes } from './channels.js';
export type { Channel, ChannelDefinition, ChannelMap, ChannelScope } from './channels.js';

/** Channel-domain measurement shared by channel-binding consumers. */
export { finiteExtent, validateChannelRange } from './range.js';
export type { ChannelRange } from './range.js';

/** Projection mode names accepted by the network controller. */
export { PROJECTION_MODES } from './projections.js';
export type { PipelineMode, ProjectionMode } from './projections.js';

/** Shared view-style primitives used by renderer option consumers. */
export type { FocusEndpointMode, RGBA } from './focus-state.js';

/** Input graph topology format passed to {@link Network.load}. */
export type { Topology } from './topology/types.js';

/** Validate graph topology without creating renderer resources. */
export { validateTopology } from './topology/validate.js';

/** Optional geographic border overlay payload. */
export { validateBorders } from './borders.js';
export type { Borders } from './borders.js';
