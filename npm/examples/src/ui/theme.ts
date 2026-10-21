import type { Scene } from 'latkit';

/** Default canvas colors; examples only override what they demonstrate. */
export const theme = {
  base: 'dark',
  background: '#101214',
  grid: '#ffffff1c',
} as const satisfies Scene['theme'];
