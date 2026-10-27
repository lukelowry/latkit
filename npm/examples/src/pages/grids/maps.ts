/**
 * The maps drawn beneath a grid: Natural Earth's coasts and borders, shipped with the page; Natural
 * Earth's states and provinces, downloaded from its repository; and OpenStreetMap's planet as
 * OpenFreeMap's vector tiles, fetched as the camera needs them. GeoJSON, plain or gzip-compressed,
 * is read in a worker.
 */
import { Data, Tiles, field, when, zoom, type Mark } from 'latkit';
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

/** A loaded map: the marks drawn beneath the grid, who to credit, and the datasets to free. */
export interface Basemap {
  readonly marks: readonly Mark[];
  readonly credit: string;
  readonly data: readonly Data[];
}

/** No map: the earth's ground alone. */
export const NO_MAP: Basemap = { credit: '', data: [], marks: [] };

const NATURAL_EARTH = 'Natural Earth · public domain';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

export const MAPS: Record<
  'borders' | 'states' | 'planet' | 'none',
  (signal: AbortSignal) => Basemap | Promise<Basemap>
> = {
  /** Coastlines, country borders, and province borders at 1:50M, as lines. */
  async borders(signal) {
    const read = (name: string) =>
      Data.read(`${import.meta.env.BASE_URL}maps/${name}.geojson.gz`, { name, signal });
    const [coast, countries, provinces] = await Promise.all(
      ['coastline', 'countries', 'provinces'].map(read),
    );
    return {
      credit: NATURAL_EARTH,
      data: [coast!, countries!, provinces!],
      marks: [
        { lines: provinces!.table('lines'), color: LOOK.line, width: 0.6, dash: true },
        { lines: countries!.table('lines'), color: LOOK.line, width: 1 },
        { lines: coast!.table('lines'), color: LOOK.coast, width: 1 },
      ],
    };
  },

  /** States and provinces at 1:50M, as areas named by their labels. */
  async states(signal) {
    const bytes = await download(`${NE}ne_50m_admin_1_states_provinces.geojson`, signal);
    const states = await Data.read(bytes, { name: 'states', signal });
    return {
      credit: NATURAL_EARTH,
      data: [states],
      marks: [
        {
          areas: states.table('polygons'),
          color: LOOK.fill,
          label: { text: '$name', size: 10, color: '#8e99aa' },
        },
        { lines: states.table('polygons'), color: LOOK.line, width: 0.7 },
      ],
    };
  },

  /** OpenStreetMap's planet, with rivers that carry comets downstream. */
  planet() {
    const base = new Tiles('base', 'https://tiles.openfreemap.org/planet');
    return {
      credit: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
      data: [],
      marks: [
        { areas: base.table('landcover'), color: LOOK.landcover },
        { areas: base.table('park'), color: LOOK.park },
        { areas: base.table('water'), color: LOOK.water },
        { lines: base.table('waterway'), color: LOOK.waterway, width: 0.8, flow: 10 },
        { lines: base.table('transportation'), color: LOOK.road, width: 0.7 },
        { lines: base.table('boundary'), color: LOOK.line, width: 1, dash: true },
        // A place is named once the zoom passes its rank, where 1 is the most important.
        {
          vertices: base.table('place'),
          color: LOOK.place,
          radius: 1.5,
          label: {
            text: when(field('rank').lt(zoom())).then(field('name')).otherwise(null),
            size: 11,
            color: LOOK.place,
          },
        },
      ],
    };
  },

  none: () => NO_MAP,
};
