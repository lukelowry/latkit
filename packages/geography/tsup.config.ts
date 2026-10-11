import { defineConfig } from 'tsup';
import { inlineWorker } from './worker.config';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { banner: '/// <reference types="@webgpu/types" />' },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  loader: { '.wgsl': 'text' },
  esbuildPlugins: [inlineWorker],
});
