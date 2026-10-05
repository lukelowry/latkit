import { readFile } from 'node:fs/promises';

/** Load a `.wgsl` file as its source text in tests, as tsup's text loader does in builds. */
export const wgsl = {
  name: 'wgsl',
  async load(id: string): Promise<string | undefined> {
    if (id.endsWith('.wgsl')) return 'export default ' + JSON.stringify(await readFile(id, 'utf8'));
  },
};
