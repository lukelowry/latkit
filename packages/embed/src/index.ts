/** Parse and validate serialized network data. */
export { parseNetwork } from './data/parse.js';

/** Register the latkit-network custom element in the current browser realm. */
export { register } from './element.js';

/** Decoded and serialized network data accepted by the embed package. */
export type { NetworkData, NetworkJSON } from './data/types.js';

/** Public DOM interface and typed event map implemented by latkit-network. */
export type { NetworkElement, NetworkElementEventMap } from './element.js';
