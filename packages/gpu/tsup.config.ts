import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    banner: '/// <reference types="@webgpu/types" />',
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'browser',
  splitting: false,
});
