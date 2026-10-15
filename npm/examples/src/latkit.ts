/** The example application explicitly loads its shared rendering runtime. */
import { loadLatkit } from 'latkit';
export * from 'latkit';
export type Data = import('latkit').Data;
export type Patch = import('latkit').Patch;
export type Gpu = import('latkit').Gpu;
export const { Data, Patch, Gpu, geojson, colormapCss } = await loadLatkit();
