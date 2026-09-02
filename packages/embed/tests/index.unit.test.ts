import { readFile } from 'node:fs/promises';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseNetwork, register } from '../src/index.js';
import type { Item, Network } from '@latkit/network';
import type {
  NetworkData,
  NetworkElement,
  NetworkElementEventMap,
  NetworkJSON,
} from '../src/index.js';

type SharedNetworkMember = Extract<keyof NetworkElement, keyof Network>;

describe('embed package entrypoint', () => {
  it('exports the side-effect-free data boundary', async () => {
    const entrypoint = await import('../src/index.js');

    expect(Object.keys(entrypoint)).toEqual(['parseNetwork', 'register']);
    expect(parseNetwork).toBeTypeOf('function');
    expect(register).toBeTypeOf('function');
  });

  it('publishes the root, registration, standalone, and stable asset subpaths', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      files: readonly string[];
      sideEffects: readonly string[];
      types: string;
    };

    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './register': {
        types: './dist/register.d.ts',
        import: './dist/register.js',
      },
      './embed.js': {
        types: './dist/register.d.ts',
        import: './dist/embed.js',
      },
      './assets/*': './dist/assets/*',
    });
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.files).toEqual(['dist', 'README.md']);
    expect(manifest.sideEffects).toEqual(['./dist/register.js', './dist/embed.js']);
  });

  it('exposes exact decoded and serialized root types', () => {
    expectTypeOf<ReturnType<typeof parseNetwork>>().toEqualTypeOf<NetworkData>();
    expectTypeOf<NetworkJSON['topology']['edges']>().toMatchTypeOf<
      readonly number[] | { readonly base64: string }
    >();
    expectTypeOf<NetworkElement['ready']>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<NetworkElement['data']>().toEqualTypeOf<NetworkData | null>();
  });

  it('mirrors every intentionally exposed Network member exactly', () => {
    expectTypeOf<SharedNetworkMember>().toEqualTypeOf<
      | 'projections'
      | 'geographic'
      | 'orbiting'
      | 'setOptions'
      | 'setBorders'
      | 'setChannel'
      | 'setChannelDomain'
      | 'getChannelDomain'
      | 'setProjection'
      | 'fit'
      | 'reveal'
      | 'neighborhood'
      | 'select'
      | 'panBy'
      | 'rotateBy'
      | 'getPose'
      | 'setPose'
      | 'zoomBy'
      | 'orbit'
      | 'pause'
      | 'resume'
    >();

    expectTypeOf<NetworkElement['projections']>().toEqualTypeOf<Network['projections']>();
    expectTypeOf<NetworkElement['geographic']>().toEqualTypeOf<Network['geographic']>();
    expectTypeOf<NetworkElement['orbiting']>().toEqualTypeOf<Network['orbiting']>();
    expectTypeOf<NetworkElement['setOptions']>().toEqualTypeOf<Network['setOptions']>();
    expectTypeOf<NetworkElement['setBorders']>().toEqualTypeOf<Network['setBorders']>();
    expectTypeOf<NetworkElement['setChannel']>().toEqualTypeOf<Network['setChannel']>();
    expectTypeOf<NetworkElement['setChannelDomain']>().toEqualTypeOf<Network['setChannelDomain']>();
    expectTypeOf<NetworkElement['getChannelDomain']>().toEqualTypeOf<Network['getChannelDomain']>();
    expectTypeOf<NetworkElement['setProjection']>().toEqualTypeOf<Network['setProjection']>();
    expectTypeOf<NetworkElement['fit']>().toEqualTypeOf<Network['fit']>();
    expectTypeOf<NetworkElement['reveal']>().toEqualTypeOf<Network['reveal']>();
    expectTypeOf<NetworkElement['neighborhood']>().toEqualTypeOf<Network['neighborhood']>();
    expectTypeOf<NetworkElement['select']>().toEqualTypeOf<Network['select']>();
    expectTypeOf<NetworkElement['panBy']>().toEqualTypeOf<Network['panBy']>();
    expectTypeOf<NetworkElement['rotateBy']>().toEqualTypeOf<Network['rotateBy']>();
    expectTypeOf<NetworkElement['getPose']>().toEqualTypeOf<Network['getPose']>();
    expectTypeOf<NetworkElement['setPose']>().toEqualTypeOf<Network['setPose']>();
    expectTypeOf<NetworkElement['zoomBy']>().toEqualTypeOf<Network['zoomBy']>();
    expectTypeOf<NetworkElement['orbit']>().toEqualTypeOf<Network['orbit']>();
    expectTypeOf<NetworkElement['pause']>().toEqualTypeOf<Network['pause']>();
    expectTypeOf<NetworkElement['resume']>().toEqualTypeOf<Network['resume']>();
  });

  it('publishes the exact typed DOM event map', () => {
    expectTypeOf<keyof NetworkElementEventMap>().toEqualTypeOf<
      'load' | 'error' | 'hover' | 'select' | 'zoom' | 'orbit' | 'deviceLost' | 'pipelineError'
    >();
    expectTypeOf<NetworkElementEventMap['load']>().toEqualTypeOf<Event>();
    expectTypeOf<NetworkElementEventMap['error']>().toEqualTypeOf<
      CustomEvent<{ readonly error: unknown }>
    >();
    expectTypeOf<NetworkElementEventMap['hover']>().toEqualTypeOf<CustomEvent<Item | null>>();
    expectTypeOf<NetworkElementEventMap['select']>().toEqualTypeOf<CustomEvent<Item | null>>();
    expectTypeOf<NetworkElementEventMap['zoom']>().toEqualTypeOf<CustomEvent<boolean>>();
    expectTypeOf<NetworkElementEventMap['orbit']>().toEqualTypeOf<CustomEvent<boolean>>();
    expectTypeOf<NetworkElementEventMap['deviceLost']>().toEqualTypeOf<
      CustomEvent<{
        readonly reason: string;
        readonly message: string;
        readonly recovering: boolean;
      }>
    >();
    expectTypeOf<NetworkElementEventMap['pipelineError']>().toEqualTypeOf<
      CustomEvent<{ readonly family: 'plane' | 'globe'; readonly cause: unknown }>
    >();
  });
});
