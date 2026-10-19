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
  {
    id: 'network',
    title: 'Grid at scale',
    summary:
      'Synthetic grids up to 70,000 buses and lattices up to a million over a globe or map, lit by daylight: states colored by the grid, vector tiles, a simulated fault to play.',
    load: () => import('./network/page.js'),
  },
  {
    id: 'operations',
    title: 'Grid operations',
    summary:
      'A state’s grid as a control room watches it: gauges of every plant and load, branches by loading with comets along their flow, solved every tick; push demand or trip a line and watch it cascade.',
    load: () => import('./operations/page.js'),
  },
  {
    id: 'telemetry',
    title: 'Telemetry',
    summary:
      'Thousands of live voltage traces in a rolling window: appended every frame, forgotten after two minutes, read under the pointer.',
    load: () => import('./telemetry/page.js'),
  },
  {
    id: 'signals',
    title: 'Signals',
    summary:
      'One record in two views on one canvas: a lattice standing on poles as high as its signals, and the signals traced, under one playhead.',
    load: () => import('./signals/page.js'),
  },
  {
    id: 'diagram',
    title: 'Diagram studio',
    summary:
      'Blocks with typed ports in nested groups, wired by signals routed around them on a sheet that zooms as one picture: add, move, rename, wire, delete, undo.',
    load: () => import('./diagram/page.js'),
  },
  {
    id: 'colors',
    title: 'Colors',
    summary:
      'The colormap catalog on a field of hexagons drawn as areas, beside the same colormaps as CSS ramps.',
    load: () => import('./colors/page.js'),
  },
];
