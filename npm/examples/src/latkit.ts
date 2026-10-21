/** The example application explicitly loads its shared rendering runtime. */
import { loadLatkit } from 'latkit';
export * from 'latkit';
export type Data = import('latkit').Data;
export type Gpu = import('latkit').Gpu;
export type Shot = import('latkit').Shot;
export const { Data, Gpu, Shot, colormapCss } = await loadLatkit();
