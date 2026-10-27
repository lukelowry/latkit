/**
 * The maps drawn beneath the grid:
 * - Natural Earth's coasts and borders as lines, shipped with the page;
 * - Natural Earth's states and provinces as areas colored by the grid's statistics, downloaded from
 *   Natural Earth's repository;
 * - OpenStreetMap's planet as OpenFreeMap's vector tiles.
 *
 * GeoJSON, plain or gzip-compressed, is read in a worker. Tiles are fetched as the camera needs them.
 */
import { Data, Tiles, field, when, zoom, type ColormapName, type Mark, type Source } from 'latkit';
import { download, megabytes } from './cases.js';

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

/** Map style options: whether areas are labeled, and which field colors the states. */
export interface Styling {
  readonly labels: boolean;
  readonly states?: { readonly by: string; readonly peak: number; readonly colormap: ColormapName };
}

/** A loaded map: a summary for the status line, its marks (drawn under the grid), its sources, and
 * its states dataset if it has one. */
export interface Loaded {
  readonly summary: string;
  marks(styling: Styling): Mark[];
  /** The datasets its marks draw. */
  readonly sources: readonly Source[];
  /** The states dataset, colored by the grid's statistics. Its rows are in table `polygons`. */
  readonly states?: Data;
}

export interface MapChoice {
  readonly id: string;
  readonly label: string;
  readonly attribution: string;
  /** Loads the map, reporting status text to `progress`. */
  load(signal: AbortSignal, progress: (status: string) => void): Promise<Loaded>;
}

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const NATURAL_EARTH = 'Natural Earth · public domain';
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

/** Natural Earth's coastlines, country borders, and province borders at 1:50M, drawn as lines. */
const borders: MapChoice = {
  id: 'borders',
  label: 'Coasts and borders',
  attribution: NATURAL_EARTH,
  async load(signal) {
    const started = performance.now();
    const files = ['coastline', 'countries', 'provinces'] as const;
    const sets = await Promise.all(
      files.map((name) =>
        Data.read(`${import.meta.env.BASE_URL}maps/${name}.geojson.gz`, { name, signal }),
      ),
    );
    return {
      sources: sets,
      summary: `coasts and borders in ${seconds(started)}`,
      marks: () => [
        {
          lines: { of: ['provinces', 'lines'], color: LOOK.line, width: 0.6, dash: true },
        },
        { lines: { of: ['countries', 'lines'], color: LOOK.line, width: 1 } },
        { lines: { of: ['coastline', 'lines'], color: LOOK.coast, width: 1 } },
      ],
    };
  },
};

/** Natural Earth's states and provinces at `scale`, as areas colored by the grid's statistics. */
function states(scale: '50m' | '10m', label: string): MapChoice {
  return {
    id: `states-${scale}`,
    label,
    attribution: NATURAL_EARTH,
    async load(signal, progress) {
      const started = performance.now();
      const bytes = await download(
        `${NE}ne_${scale}_admin_1_states_provinces.geojson`,
        signal,
        (got, total) => progress(`downloading ${megabytes(got, total)}`),
      );
      const fetched = performance.now();
      const data = await Data.read(bytes, { name: 'states', signal });
      return {
        sources: [data],
        states: data,
        summary: `${(bytes.length / 1e6).toFixed(1)} MB in ${seconds(started)}, read in ${seconds(fetched)}`,
        marks: ({ labels, states }) => [
          {
            // Each state carries the grid's statistics, which hovering it shows in the inspector.
            areas: {
              of: ['states', 'polygons'],
              color: states
                ? field(states.by).colormap(states.colormap).domain(0, Math.max(states.peak, 1e-6))
                : LOOK.fill,
              ...(labels ? { label: { text: '$name', size: 10, color: '#8e99aa' } } : {}),
              pick: true,
            },
          },
          { lines: { of: ['states', 'polygons'], color: LOOK.line, width: 0.7 } },
        ],
      };
    },
  };
}

/** OpenStreetMap's planet as OpenFreeMap's vector tiles. */
const planet: MapChoice = {
  id: 'planet',
  label: 'Planet, vector tiles',
  attribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
  load() {
    return Promise.resolve({
      sources: [new Tiles('base', 'https://tiles.openfreemap.org/planet')],
      summary: 'tiles fetched as the camera needs them',
      marks: ({ labels }) => [
        { areas: { of: ['base', 'landcover'], color: LOOK.landcover } },
        { areas: { of: ['base', 'park'], color: LOOK.park } },
        { areas: { of: ['base', 'water'], color: LOOK.water } },
        // Comets run along rivers in the direction of their OpenStreetMap ways: downstream.
        { lines: { of: ['base', 'waterway'], color: LOOK.waterway, width: 0.8, flow: 10 } },
        { lines: { of: ['base', 'transportation'], color: LOOK.road, width: 0.7 } },
        { lines: { of: ['base', 'boundary'], color: LOOK.line, width: 1, dash: true } },
        // Place labels by rank, where 1 is the most important: a place is named once the zoom
        // passes its rank, and has no label before. A tile holds only the points inside it, so no
        // label repeats.
        ...(labels
          ? [
              {
                vertices: {
                  of: ['base', 'place'],
                  color: LOOK.place,
                  radius: 1.5,
                  label: {
                    text: when(field('rank').lt(zoom())).then(field('name')).otherwise(null),
                    size: 11,
                    color: LOOK.place,
                  },
                },
              } satisfies Mark,
            ]
          : []),
      ],
    });
  },
};

export const MAPS: readonly MapChoice[] = [
  borders,
  states('50m', 'States and provinces, 1:50M'),
  states('10m', 'States and provinces, 1:10M (40 MB)'),
  planet,
];
