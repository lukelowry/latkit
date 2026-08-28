/** Parse and validate serialized network data. */
export { parseNetwork } from './data/parse.js';

/** Register the latkit-network custom element in the current browser realm. */
export { register } from './element.js';

/** Network data types accepted by the embed package. */
export type {
  NetworkData,
  NetworkField,
  NetworkFieldJSON,
  NetworkJSON,
  NetworkLabels,
  NetworkTopologyJSON,
  NumericJSON,
} from './data/types.js';

/** Public DOM interface and exact event details implemented by latkit-network. */
export type {
  NetworkDeviceLostEventDetail,
  NetworkElement,
  NetworkElementEventMap,
  NetworkItemEventDetail,
  NetworkPipelineErrorEventDetail,
  NetworkZoomEventDetail,
} from './element.js';
