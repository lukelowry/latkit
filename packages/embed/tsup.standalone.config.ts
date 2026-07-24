import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    embed: 'src/register.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  noExternal: [/@latkit\//],
  target: 'es2022',
  platform: 'browser',
  splitting: false,
});
