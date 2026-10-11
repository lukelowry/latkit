import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';

const SUFFIX = '?worker';

/** A worker module's script, bundled and minified, as one string. */
export async function workerSource(path: string): Promise<string> {
  const out = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target: 'es2022',
  });
  return out.outputFiles[0].text;
}

/** Resolve `./worker.ts?worker` imports to the worker's bundled source, for tsup builds. */
export const inlineWorker = {
  name: 'inline-worker',
  setup(b: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string; resolveDir: string }) => { path: string; namespace: string },
    ): void;
    onLoad(
      options: { filter: RegExp; namespace: string },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' }>,
    ): void;
  }) {
    b.onResolve({ filter: /\?worker$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -SUFFIX.length)),
      namespace: 'inline-worker',
    }));
    b.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => ({
      contents: 'export default ' + JSON.stringify(await workerSource(args.path)) + ';',
      loader: 'js',
    }));
  },
};

/** The same, for vitest: a `?worker` import loads the worker's bundled source. */
export const vitestWorker = {
  name: 'inline-worker',
  resolveId(id: string, importer?: string): string | undefined {
    if (!id.endsWith(SUFFIX) || !importer) return undefined;
    return resolve(dirname(importer), id.slice(0, -SUFFIX.length)) + SUFFIX;
  },
  async load(id: string): Promise<string | undefined> {
    if (!id.endsWith(SUFFIX)) return undefined;
    return 'export default ' + JSON.stringify(await workerSource(id.slice(0, -SUFFIX.length)));
  },
};
