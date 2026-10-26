import type { Scene } from 'latkit';

/** Default canvas colors. Examples override only the colors they demonstrate. */
export const theme = {
  base: 'dark',
  background: '#101214',
  grid: '#ffffff1c',
} as const satisfies Scene['theme'];
