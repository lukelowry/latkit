/**
 * What the map beneath the grid draws: Natural Earth's coasts and borders as lines, shipped with the
 * page; Natural Earth's states and provinces as GeoJSON, prepared in the geography's worker, which a
 * grid's figures color; or OpenStreetMap's planet as OpenFreeMap's vector tiles.
 */
import type { RGBA } from '@latkit/gpu';
import type { Data } from '@latkit/model';
import { geojson, tiles, type GeographyConfig } from '@latkit/geography';
import { download, type Progress } from './download.js';
import { loadBorders } from './cases.js';

/** A map, loaded: what the geography draws, and the areas a grid's figures can color. */
export interface MapLoaded {
  readonly config: Pick<GeographyConfig, 'source' | 'areas' | 'lines'>;
  readonly summary: string;
  readonly states?: { readonly data: Data; readonly type: string };
}
/** What the page styles every map with. */
export interface Look {
  readonly fill: RGBA;
  readonly line: RGBA;
  readonly coast: RGBA;
}
export interface MapChoice {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly attribution: string;
  load(signal: AbortSignal, progress: Progress, look: Look): Promise<MapLoaded>;
}

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const NATURAL_EARTH = 'Natural Earth · public domain';
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

function states(scale: '50m' | '10m', label: string): MapChoice {
  return {
    id: `states-${scale}`,
    label,
    group: 'Natural Earth',
    attribution: NATURAL_EARTH,
    async load(signal, progress, look) {
      const started = performance.now(),
        { buffer, received } = await download(
          `${NE}ne_${scale}_admin_1_states_provinces.geojson`,
          signal,
          progress,
        ),
        fetched = performance.now();
      progress('parsing in a worker…');
      const data = await geojson(new TextDecoder().decode(buffer), {
        type: 'State',
        id: 'adm1_code',
      });
      return {
        states: { data, type: 'State' },
        summary: `${(received / 1e6).toFixed(1)} MB in ${seconds(started)} · parsed in ${seconds(fetched)}`,
        config: {
          source: data,
          areas: { State: { color: look.fill, labels: 'name' } },
          lines: { State: { points: 'rings', color: look.line, widthPx: 0.8 } },
        },
      };
    },
  };
}

export const MAPS: readonly MapChoice[] = [
  {
    id: 'borders',
    label: 'Coasts and borders, lines',
    group: 'Natural Earth',
    attribution: NATURAL_EARTH,
    async load(signal, progress, look) {
      const started = performance.now(),
        data = await loadBorders(signal, progress);
      return {
        summary: `loaded in ${seconds(started)}`,
        config: {
          source: data,
          lines: {
            Coast: { color: look.coast, widthPx: 1 },
            Country: { color: look.line, widthPx: 1 },
            Province: { color: look.line, widthPx: 0.6, dash: true },
          },
        },
      };
    },
  },
  states('50m', 'States and provinces, 1:50M'),
  states('10m', 'States and provinces, 1:10M (40 MB)'),
  {
    id: 'openfreemap',
    label: 'Planet, vector tiles',
    group: 'OpenStreetMap',
    attribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
    async load(_signal, progress, look) {
      progress('opening TileJSON…');
      const planet = tiles('https://tiles.openfreemap.org/planet', { persist: true }),
        info = await planet.info;
      return {
        summary: `${info.layers.length} layers, zooms ${info.minZoom}–${info.maxZoom}`,
        config: {
          source: planet,
          areas: {
            landcover: { color: [0.11, 0.16, 0.14, 1] },
            park: { color: [0.1, 0.19, 0.13, 1] },
            water: { color: [0.05, 0.1, 0.17, 1] },
          },
          lines: {
            waterway: { color: [0.18, 0.33, 0.52, 0.9], widthPx: 0.8 },
            transportation: { color: [0.36, 0.38, 0.42, 0.7], widthPx: 0.7 },
            boundary: { color: look.line, widthPx: 1, dash: true },
          },
        },
      };
    },
  },
];
