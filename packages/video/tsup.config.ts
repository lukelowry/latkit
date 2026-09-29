import { build, defineConfig, type Options } from 'tsup';
const shared: Options = {
  format: ['esm'],
  sourcemap: true,
  target: 'es2022',
  platform: 'browser',
  splitting: false,
};
export default defineConfig({
  ...shared,
  entry: ['src/index.ts'],
  dts: true,
  clean: true,
  async onSuccess() {
    // Build after the entrypoint's clean, with dependencies bundled only into the worker.
    await build({
      ...shared,
      config: false,
      entry: ['src/worker.ts'],
      clean: false,
      noExternal: [/^@latkit\//, 'mediabunny'],
      loader: { '.wgsl': 'text' },
    });
  },
});
