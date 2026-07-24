import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXAMPLE_ROOT = fileURLToPath(new URL('../../../examples/embed/', import.meta.url));
const VITE_BIN = fileURLToPath(
  new URL('../../../examples/embed/node_modules/vite/bin/vite.js', import.meta.url),
);

const BORDER_ASSETS = [
  'ne-50m-line-borders.indices.bin',
  'ne-50m-line-borders.vertices.bin',
] as const;

describe('embed package delivery', () => {
  it('keeps the built package root side-effect-free and safe without a DOM', () => {
    runNodeModule(`
      if (globalThis.HTMLElement !== undefined || globalThis.customElements !== undefined) {
        throw new Error('Node unexpectedly provides custom-element globals');
      }
      const entrypoint = await import('@latkit/embed');
      const keys = Object.keys(entrypoint).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['parseNetwork', 'register'])) {
        throw new Error('unexpected root exports: ' + keys.join(', '));
      }
      if (globalThis.HTMLElement !== undefined || globalThis.customElements !== undefined) {
        throw new Error('root import installed DOM globals');
      }
    `);
  });

  it('self-registers only through the registration entry', () => {
    runNodeModule(registrationSmokeScript('@latkit/embed/register', true));
  });

  it('ships a self-contained, self-registering standalone module', async () => {
    const standalone = await readFile(new URL('../dist/embed.js', import.meta.url), 'utf8');

    expect(standalone).not.toMatch(/\bfrom\s*["']/);
    expect(standalone).not.toMatch(/\bimport\s*["']/);
    expect(standalone).not.toMatch(/\bimport\s*\(/);
    expect(standalone).toContain('latkit-network');
    for (const asset of BORDER_ASSETS) expect(standalone).toMatch(assetUrlPattern(asset));

    runNodeModule(registrationSmokeScript('@latkit/embed/embed.js', false));
  });

  it('publishes only the expected build products and public declarations', async () => {
    expect(await listFiles(join(PACKAGE_ROOT, 'dist'))).toEqual([
      'assets/ne-50m-line-borders.indices.bin',
      'assets/ne-50m-line-borders.vertices.bin',
      'embed.js',
      'embed.js.map',
      'index.d.ts',
      'index.js',
      'index.js.map',
      'register.d.ts',
      'register.js',
      'register.js.map',
    ]);

    const declarations = await readFile(new URL('../dist/index.d.ts', import.meta.url), 'utf8');
    const registerDeclarations = await readFile(
      new URL('../dist/register.d.ts', import.meta.url),
      'utf8',
    );

    for (const publicType of [
      'NetworkElement',
      'NetworkElementEventMap',
      'NetworkItemEventDetail',
      'NetworkZoomEventDetail',
      'NetworkDeviceLostEventDetail',
    ]) {
      expect(declarations).toMatch(new RegExp(`\\b${publicType}\\b`));
      expect(registerDeclarations).toMatch(new RegExp(`\\b${publicType}\\b`));
    }
    expect(registerDeclarations).toContain("from './index.js'");
    expect(declarations).not.toMatch(
      /\b(?:ElementDependencies|createNetworkElementClass|Activation|DevicePool)\b/,
    );
    expect(declarations).not.toMatch(/\b(?:class|interface)\s+LatkitNetwork/);
  });

  it('copies exact border payloads and keeps both bundle locations relative', async () => {
    const esm = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
    const payloads = await Promise.all(
      BORDER_ASSETS.map(async (asset) => {
        const [distributed, source] = await Promise.all([
          readFile(new URL(`../dist/assets/${asset}`, import.meta.url)),
          readFile(new URL(`../assets/${asset}`, import.meta.url)),
        ]);
        return { asset, distributed, source };
      }),
    );

    for (const { asset, distributed, source } of payloads) {
      expect(esm).toMatch(assetUrlPattern(asset));
      expect(distributed.equals(source), asset).toBe(true);
    }
  }, 60_000);

  it('produces an isolated example build with bundled code and both border assets', async () => {
    const output = await mkdtemp(join(tmpdir(), 'latkit-embed-example-'));
    try {
      execFileSync(execPath, [VITE_BIN, 'build', '--outDir', output, '--emptyOutDir'], {
        cwd: EXAMPLE_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      });

      const files = await listFiles(output);
      const scripts = files.filter((file) => file.endsWith('.js'));
      const styles = files.filter((file) => file.endsWith('.css'));
      const binaries = files.filter((file) => file.endsWith('.bin'));

      expect(files).toContain('index.html');
      expect(scripts).toHaveLength(1);
      expect(styles).toHaveLength(1);
      expect(binaries).toHaveLength(2);

      const html = await readFile(join(output, 'index.html'), 'utf8');
      const javascript = await readFile(join(output, scripts[0]!), 'utf8');
      expect(html).toContain('<latkit-network');
      expect(html).toContain('controls="caption projection navigation colormap channels legends"');
      expect(javascript).not.toMatch(/\bfrom\s*["']@latkit\//);
      expect(javascript).not.toMatch(/\bimport\s*["']@latkit\//);

      const sourcePayloads = await Promise.all(
        BORDER_ASSETS.map((asset) => readFile(join(PACKAGE_ROOT, 'assets', asset))),
      );
      const productionPayloads = await Promise.all(
        binaries.map((file) => readFile(join(output, file))),
      );
      for (const source of sourcePayloads) {
        expect(productionPayloads.some((payload) => payload.equals(source))).toBe(true);
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 150_000);
});

function runNodeModule(source: string): void {
  execFileSync(execPath, ['--input-type=module', '--eval', source], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

function registrationSmokeScript(specifier: string, verifyRootRegister: boolean): string {
  return `
    const definitions = new Map();
    let defineCalls = 0;
    globalThis.HTMLElement = class HTMLElement {};
    globalThis.customElements = {
      get(name) { return definitions.get(name); },
      define(name, constructor) {
        defineCalls++;
        if (definitions.has(name)) throw new Error('duplicate definition: ' + name);
        definitions.set(name, constructor);
      },
    };

    const entrypoint = await import(${JSON.stringify(specifier)});
    if (Object.keys(entrypoint).length !== 0) {
      throw new Error('side-effect entry has runtime exports');
    }
    const constructor = definitions.get('latkit-network');
    if (defineCalls !== 1 || typeof constructor !== 'function') {
      throw new Error('latkit-network was not registered exactly once');
    }
    if (!(constructor.prototype instanceof globalThis.HTMLElement)) {
      throw new Error('definition does not extend this realm HTMLElement');
    }
    ${
      verifyRootRegister
        ? `
          const root = await import('@latkit/embed');
          root.register();
          root.register();
          if (defineCalls !== 1) throw new Error('register() is not idempotent');
        `
        : ''
    }
  `;
}

function assetUrlPattern(asset: string): RegExp {
  const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`new URL\\(["']\\./assets/${escaped}["'],\\s*import\\.meta\\.url\\)`);
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...(await listFiles(join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}
