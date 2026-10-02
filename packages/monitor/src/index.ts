/** Draw sampled fields over a coordinate such as time: live, progressive, and inspectable. */
export { createMonitor } from './monitor.js';
export type {
  Monitor,
  MonitorConfig,
  MonitorEvents,
  MonitorStats,
  Camera,
  PickOptions,
} from './monitor.js';
export type { Trace, Reading } from './data.js';
export type { AxisOptions, Tick, Limits as MonitorLimits } from './options.js';
export type { MonitorInput } from './input.js';
