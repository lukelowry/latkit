import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import { loadBorders } from '@latkit/network/borders';

import { defineShell, observeNear, type ShellDeps } from './element.js';
import { monitorSpec, type MonitorDeps } from './monitor.js';
import { networkSpec, type NetworkDeps } from './network.js';

export const NETWORK_TAG = 'latkit-network';
export const MONITOR_TAG = 'latkit-monitor';

/** Every seam the elements reach through; tests replace them. */
export type ElementDeps = ShellDeps & NetworkDeps & MonitorDeps;

const DEFAULT_DEPS: ElementDeps = {
  createNetwork,
  createMonitor,
  loadBorders,
  fetch: (url, init) => fetch(url, init),
  observeNear,
  warn: (message, error) => {
    if (error === undefined) console.warn(`@latkit/embed: ${message}`);
    else console.warn(`@latkit/embed: ${message}`, error);
  },
};

/** Build both element classes against one HTMLElement realm. */
export function createElementClasses(
  Base: typeof HTMLElement,
  deps: ElementDeps,
): { readonly network: CustomElementConstructor; readonly monitor: CustomElementConstructor } {
  return {
    network: defineShell(Base, networkSpec(deps), deps, 'network'),
    monitor: defineShell(Base, monitorSpec(deps), deps, 'monitor'),
  };
}

/** Define `latkit-network` and `latkit-monitor` in the current browser realm; idempotent. */
export function register(): void {
  const registry = globalThis.customElements;
  const Base = globalThis.HTMLElement;
  if (!registry || !Base) throw new Error('@latkit/embed: register() requires a browser DOM');
  if (registry.get(NETWORK_TAG) && registry.get(MONITOR_TAG)) return;
  const classes = createElementClasses(Base, DEFAULT_DEPS);
  if (!registry.get(NETWORK_TAG)) registry.define(NETWORK_TAG, classes.network);
  if (!registry.get(MONITOR_TAG)) registry.define(MONITOR_TAG, classes.monitor);
}
