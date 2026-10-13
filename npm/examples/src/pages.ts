import type { Page } from './ui/shell.js';

/** Every page of the suite, in the order the bar lists them. */
export const pages: readonly Page[] = [
  {
    id: 'bunny',
    title: 'Jelly bunny',
    summary:
      'A soft body streamed as sampled fields: a lit mesh you can grab and fling, its history on a plot, and every frame kept to replay.',
    load: () => import('./bunny/page.js'),
  },
  {
    id: 'grid',
    title: 'Grid playback',
    summary:
      'A synthetic grid of 3,600 buses with a minute of voltages, on a map, a globe, or a plane.',
    load: () => import('./grid/page.js'),
  },
];
