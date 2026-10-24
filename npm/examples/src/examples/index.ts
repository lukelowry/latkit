import type { Page } from '../ui/shell.js';

/** Names and modules for the example picker. IDs keep existing links working. */
export const examples: readonly Page[] = [
  { id: 'bunny', title: 'Soft body', load: () => import('./soft-body/index.js') },
  { id: 'network', title: 'Networks', load: () => import('./networks/index.js') },
  { id: 'operations', title: 'Power flow', load: () => import('./power-flow/index.js') },
  { id: 'telemetry', title: 'Live data', load: () => import('./live-data/index.js') },
  { id: 'signals', title: 'Linked views', load: () => import('./linked-views/index.js') },
  { id: 'diagram', title: 'Diagram', load: () => import('./diagram/index.js') },
  { id: 'colors', title: 'Colormaps', load: () => import('./colormaps/index.js') },
];
