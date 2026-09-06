/**
 * `@latkit/embed` — `latkit-network` and `latkit-monitor`, the declarative form of the Latkit
 * controllers: a canvas that fills the element, a data source, attributes for every option, and
 * the controller itself at `element.network` or `element.monitor`. No chrome.
 *
 * @packageDocumentation
 */

/** Define both elements in the current browser realm. */
export { register } from './define.js';

/** Parse and validate serialized data. */
export { parseNetwork } from './network.js';
export { parseSeries } from './monitor.js';

/** Element interfaces and the data each accepts. */
export type { NetworkData, NetworkElement, NetworkJSON } from './network.js';
export type { MonitorElement, SeriesJSON } from './monitor.js';
