/**
 * What the map beneath the grid draws: Natural Earth's coasts and borders as lines, shipped with the
 * page; Natural Earth's states and provinces as areas the grid's figures color, from Natural Earth's
 * repository; or OpenStreetMap's planet as OpenFreeMap's vector tiles. GeoJSON downloads as bytes
 * and is read in a worker; tiles are fetched as the camera asks for them.
 */
import { field, geojson, type ColormapName, type Data, type Mark, type View } from '../latkit.js';
import { download } from './cases.js';

/** The page's colors, as CSS. */
export const LOOK = {
  background: '#05070a',
  ground: '#0e131b',
  fill: '#1a212b',
  line: '#6b80948c',
  coast: '#8ca3b8d9',
  landcover: '#1c2924',
  park: '#1a3021',
  water: '#0d1a2b',
  waterway: '#2e5485e6',
  road: '#5c616bb3',
  place: '#c3ccd8',
} as const;

/** How the map draws: whether its areas are labeled, and what its states color by. */
export interface Styling {
  readonly labels: boolean;
  readonly states?: { readonly by: string; readonly peak: number; readonly colormap: ColormapName };
}

/** A map, loaded: its marks, drawn under the grid, and its states when it has them. */
export interface Loaded {
  readonly summary: string;
  marks(styling: Styling): Mark[];
  /** The dataset of states the grid's figures color, its rows in table `polygons`. */
  readonly states?: Data;
  /** Takes back from the view what loading gave it. */
  unload(view: View): void;
}

export interface MapChoice {
  readonly id: string;
  readonly label: string;
  readonly attribution: string;
  load(view: View, signal: AbortSignal): Promise<Loaded>;
}

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const NATURAL_EARTH = 'Natural Earth · public domain';
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

/** Natural Earth's coasts, land borders, and province borders at 1:50M: datasets of lines. */
const borders: MapChoice = {
  id: 'borders',
  label: 'Coasts and borders',
  attribution: NATURAL_EARTH,
  async load(view, signal) {
    const started = performance.now();
    const files = ['coastline', 'countries', 'provinces'] as const;
    const sets = await Promise.all(
      files.map(async (name) => {
        const { bytes } = await download(
          `${import.meta.env.BASE_URL}maps/${name}.geojson.gz`,
          signal,
        );
        return geojson(name, bytes);
      }),
    );
    for (const data of sets) view.setData(data);
    return {
      summary: `coasts and borders in ${seconds(started)}`,
      marks: () => [
        {
          lines: {
            of: ['provinces', 'lines'],
            color: LOOK.line,
            width: 0.6,
            dash: true,
            pick: false,
          },
        },
        { lines: { of: ['countries', 'lines'], color: LOOK.line, width: 1, pick: false } },
        { lines: { of: ['coastline', 'lines'], color: LOOK.coast, width: 1, pick: false } },
      ],
      unload: (view) => files.forEach((name) => view.removeData(name)),
    };
  },
};

/** Natural Earth's states and provinces at `scale`: areas the grid's figures color. */
function states(scale: '50m' | '10m', label: string): MapChoice {
  return {
    id: `states-${scale}`,
    label,
    attribution: NATURAL_EARTH,
    async load(view, signal) {
      const started = performance.now();
      const { bytes, received } = await download(
        `${NE}ne_${scale}_admin_1_states_provinces.geojson`,
        signal,
      );
      const fetched = performance.now();
      const data = await geojson('states', bytes);
      view.setData(data);
      return {
        states: data,
        summary: `${(received / 1e6).toFixed(1)} MB in ${seconds(started)}, read in ${seconds(fetched)}`,
        marks: ({ labels, states }) => [
          {
            areas: {
              of: ['states', 'polygons'],
              color: states
                ? field(states.by).colormap(states.colormap).domain(0, Math.max(states.peak, 1e-6))
                : LOOK.fill,
              ...(labels ? { label: { text: 'name', size: 10, color: '#8e99aa' } } : {}),
            },
          },
          { lines: { of: ['states', 'polygons'], color: LOOK.line, width: 0.7, pick: false } },
        ],
        unload: (view) => view.removeData('states'),
      };
    },
  };
}

/** OpenStreetMap's planet as OpenFreeMap's vector tiles. */
const planet: MapChoice = {
  id: 'planet',
  label: 'Planet, vector tiles',
  attribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
  load(view) {
    view.setTiles('base', 'https://tiles.openfreemap.org/planet');
    return Promise.resolve({
      summary: 'tiles fetch as the camera asks for them',
      marks: ({ labels }) => [
        { areas: { of: ['base', 'landcover'], color: LOOK.landcover, pick: false } },
        { areas: { of: ['base', 'park'], color: LOOK.park } },
        { areas: { of: ['base', 'water'], color: LOOK.water, pick: false } },
        // Rivers carry comets downstream, as their ways run.
        {
          lines: {
            of: ['base', 'waterway'],
            color: LOOK.waterway,
            width: 0.8,
            flow: 10,
            pick: false,
          },
        },
        { lines: { of: ['base', 'transportation'], color: LOOK.road, width: 0.7 } },
        {
          lines: { of: ['base', 'boundary'], color: LOOK.line, width: 1, dash: true, pick: false },
        },
        // Places by rank, 1 the most important; a tile holds only the points inside it, so none repeat.
        ...(labels
          ? [
              {
                vertices: {
                  of: ['base', 'place'],
                  color: LOOK.place,
                  radius: 1.5,
                  label: {
                    text: 'name',
                    size: 11,
                    color: LOOK.place,
                    priority: field('rank').mul(-1),
                  },
                },
              } satisfies Mark,
            ]
          : []),
      ],
      unload: (view) => view.removeTiles('base'),
    });
  },
};

export const MAPS: readonly MapChoice[] = [
  borders,
  states('50m', 'States and provinces, 1:50M'),
  states('10m', 'States and provinces, 1:10M (40 MB)'),
  planet,
];
