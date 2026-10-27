/**
 * Power grids on the earth: synthetic cases from WECC 240 buses to ACTIVSg70k, and a grid of North
 * America's two million buses built in the page, over coasts and borders, states, or
 * OpenStreetMap. Color buses by voltage level, load, or generation, raise them by their voltage, or
 * lay the grid out by its topology instead of its geography and watch every bus ease to its place.
 */
import { field, when, zoom, type Mark, type Scene } from 'latkit';
import { choice, page, toggle } from '../../shell/page.js';
import { extent, loadCase, megabytes, type Case } from './cases.js';
import { CONTINENTS, continent } from './continent.js';
import { LEVELS } from './format.js';
import { LOOK, MAPS, NO_MAP, type Basemap } from './maps.js';

/** Each voltage level's color, from below 100 kV to 765 kV. */
const LEVEL_COLORS = ['#56657a', '#2fa49b', '#7fc97f', '#e6c84f', '#f08a3c', '#e5486f'];
/** Noon at midsummer over the western US, in seconds since the epoch. */
const NOON = Date.UTC(2026, 5, 21, 19) / 1000;

/** A grid's case and its largest load and generation, which their colormaps span. */
interface Grid extends Case {
  readonly peak: { readonly load: number; readonly generation: number };
}

/** Loads case `id`, or builds the synthetic continent, reporting progress to `detail`. */
async function load(
  id: string,
  signal: AbortSignal,
  detail: (text: string) => void,
): Promise<Grid> {
  detail(`Loading ${id}…`);
  const found =
    id in CONTINENTS
      ? continent(id)
      : await loadCase(id, signal, (got, total) =>
          detail(`Loading ${id}, ${megabytes(got, total)}`),
        );
  const peak = (values: Float32Array) => values.reduce((most, v) => Math.max(most, v), 1);
  detail(
    `${found.name} · ${found.buses.toLocaleString()} buses · ${found.lines.toLocaleString()} lines`,
  );
  return { ...found, peak: { load: peak(found.load), generation: peak(found.generation) } };
}

export default page({
  title: 'Power grids',
  settings: {
    grid: choice(
      'Grid',
      {
        'WECC 240': 'wecc240',
        ACTIVSg2000: 'activsg2000',
        ACTIVSg10k: 'activsg10k',
        ACTIVSg25k: 'activsg25k',
        ACTIVSg70k: 'activsg70k',
        'North America · 2M': 'continent-2m',
      },
      { value: 'activsg25k' },
    ),
    color: choice('Color', { 'Voltage level': 'level', Load: 'load', Generation: 'generation' }),
    height: choice('Height', { Flat: 'flat', 'Voltage (kV)': 'kv' }, { key: 'h' }),
    layout: choice('Layout', { Geography: 'geography', Topology: 'topology' }, { key: 't' }),
    labels: toggle('Labels', { value: true, key: 'l' }),
    comets: toggle('Comets', { key: 'c' }),
    map: choice(
      'Map',
      {
        'Coasts and borders': 'borders',
        'States and provinces': 'states',
        OpenStreetMap: 'planet',
        None: 'none',
      },
      { section: 'Earth' },
    ),
    globe: toggle('Globe', { value: true, key: 'g', section: 'Earth' }),
    light: choice('Light', { Noon: 'noon', Now: 'now', Even: 'even' }, { section: 'Earth' }),
  },

  async open({ settings, signal, view, detail, credit, fail }) {
    let grid = await load(settings.grid, signal, detail);
    // The map joins the scene once its datasets are read, so the grid draws first.
    let map: Basemap = NO_MAP;

    const scene = (s: typeof settings): Scene => {
      const geography = s.layout === 'geography';
      const data = grid.data;
      const big = grid.buses > 20_000;
      const level = field('level').colormap({
        kind: 'categorical',
        colors: LEVEL_COLORS,
        categories: [...LEVELS],
      });
      // On the earth, height is a fraction of its radius: 765 kV stands about 140 km high. Laid out
      // by topology, it is in the layout's units.
      const height = s.height === 'kv' ? field('kv').mul(geography ? 2.5e-5 : 0.15) : 0;
      const where = geography ? { position: ['$lon', '$lat'] as ['$lon', '$lat'] } : {};
      const marks: Mark[] = [
        ...(geography ? map.marks : []),
        {
          edges: data.table('Line'),
          ends: ['from', 'to'],
          // Higher-voltage lines draw on top, and stay visible as the camera zooms out.
          priority: '$level',
          color: level,
          width: field('level')
            .scale(big ? 0.5 : 0.8, big ? 1.8 : 2.8)
            .domain(0, 5),
          dash: '$transformer',
          flow: s.comets ? field('level').mul(6).add(8) : 0,
        },
        {
          vertices: data.table('Bus'),
          ...where,
          elevation: height,
          priority: '$level',
          color:
            s.color === 'level'
              ? level
              : field(s.color)
                  .colormap(s.color === 'load' ? 'mako' : 'amber')
                  .domain(0, grid.peak[s.color]),
          radius: big ? field('level').scale(0.8, 2.6).domain(0, 5) : grid.buses > 5000 ? 2 : 3,
          legend:
            s.color === 'level'
              ? 'Voltage level'
              : s.color === 'load'
                ? 'Load (MW)'
                : 'Generation (MW)',
          // A crowded grid names its buses only once zoomed in.
          ...(s.labels && grid.named
            ? {
                label: {
                  text: when(zoom().ge(geography ? 5.5 : 3))
                    .then(field('name'))
                    .otherwise(null),
                  size: 10,
                },
              }
            : {}),
        },
      ];
      if (geography && grid.machines)
        marks.push({
          vertices: data.table('Machine'),
          position: ['$lon', '$lat'],
          elevation: height,
          marker: 'diamond',
          color: '#ebf0f7',
          radius: field('power')
            .scale(big ? 2 : 3, big ? 5 : 8)
            .domain(0, grid.peak.generation),
        });
      return {
        space: geography
          ? {
              earth: {
                projection: s.globe ? 'globe' : 'mercator',
                graticule: false,
                atmosphere: s.globe,
                ...(s.light === 'even'
                  ? {}
                  : { daylight: s.light === 'now' ? Date.now() / 1000 : NOON }),
              },
            }
          : { plane: { grid: 'off' } },
        layout: geography ? 'none' : 'stress',
        theme: {
          base: 'dark',
          background: LOOK.background,
          area: { color: LOOK.fill },
          earth: { ground: LOOK.ground, atmosphere: '#5aa9ff99', night: 0.28 },
          edge: { bow: 0.12 },
          flow: { color: '#d6e6ffa6', width: 3, length: 20, spacing: 72 },
        },
        marks,
      };
    };

    /** Frames the grid's buses. */
    const frame = () => {
      if (settings.layout !== 'geography') return shown.fit();
      const [west, south, east, north] = extent(grid.positions);
      shown.fit({ bounds: { min: [west, south, 0], max: [east, north, 0] } });
    };
    /** Swaps in map `id` once its datasets are read, unless another map was chosen meanwhile. */
    const showMap = async (id: typeof settings.map) => {
      const next = await MAPS[id](signal);
      if (id !== settings.map || signal.aborted) {
        for (const d of next.data) d.destroy();
        return;
      }
      const old = map;
      map = next;
      credit(map.credit);
      shown.scene = scene(settings);
      for (const d of old.data) d.destroy();
    };
    const shown = await view(scene, { label: 'A power grid: hover or click a bus or line' });
    frame();
    showMap(settings.map).catch(fail);

    return {
      async change(s, key) {
        if (key === 'grid') {
          const next = await load(s.grid, signal, detail);
          const old = grid;
          grid = next;
          return () => {
            frame();
            old.data.destroy();
          };
        }
        if (key === 'map') showMap(s.map).catch(fail);
        if (key === 'layout') return frame;
      },
    };
  },
});
