// @vitest-environment jsdom

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as embed from '../src/index.js';
import type { MonitorElement, NetworkElement } from '../src/index.js';
import { htmlName, optionAttributes, parseOptionAttribute } from '../src/attributes.js';

describe('embed package entrypoint', () => {
  it('exports registration, both parsers, and nothing else at runtime', () => {
    expect(Object.keys(embed).sort()).toEqual(['parseNetwork', 'parseSeries', 'register']);
    expectTypeOf<NetworkElement['network']>().not.toBeAny();
    expectTypeOf<MonitorElement['monitor']>().not.toBeAny();
    expectTypeOf<NetworkElement['ready']>().toEqualTypeOf<Promise<void>>();
  });

  it('registers both tags idempotently', () => {
    embed.register();
    const network = customElements.get('latkit-network');
    const monitor = customElements.get('latkit-monitor');

    embed.register();

    expect(network).toBeTypeOf('function');
    expect(monitor).toBeTypeOf('function');
    expect(customElements.get('latkit-network')).toBe(network);
    expect(customElements.get('latkit-monitor')).toBe(monitor);
  });

  it('derives attribute names and parsers from an option registry', () => {
    expect(htmlName('dashPeriodPx')).toBe('dash-period-px');
    const attributes = optionAttributes({
      colormap: { kind: 'colormap', default: () => [0, 0, 0], live: true },
      devices: { kind: 'pool', default: {}, live: false },
      edgeScale: { kind: 'nonnegative', default: 1, live: true },
      msaa: { kind: 'enum', values: [1, 4], default: undefined, live: false },
    });
    expect(attributes.map((entry) => entry.attribute)).toEqual(['edge-scale', 'msaa']);

    expect(parseOptionAttribute({ kind: 'boolean', default: false, live: true }, '')).toBe(true);
    expect(parseOptionAttribute({ kind: 'boolean', default: false, live: true }, 'false')).toBe(
      false,
    );
    expect(parseOptionAttribute({ kind: 'boolean', default: false, live: true }, 'yes')).toBe(
      undefined,
    );
    expect(parseOptionAttribute({ kind: 'finite', default: 0, live: true }, ' 1e2 ')).toBe(100);
    expect(parseOptionAttribute({ kind: 'finite', default: 0, live: true }, '0x10')).toBeNaN();
    expect(parseOptionAttribute({ kind: 'rgba', default: [], live: true }, '1 0 0 1')).toEqual([
      1, 0, 0, 1,
    ]);
    expect(parseOptionAttribute({ kind: 'rgba', default: [], live: true }, '1 0')).toBe(undefined);
    expect(parseOptionAttribute({ kind: 'domain', default: null, live: true }, '0 5')).toEqual([
      0, 5,
    ]);
    expect(
      parseOptionAttribute({ kind: 'enum', values: [1, 4], default: undefined, live: false }, '4'),
    ).toBe(4);
    expect(
      parseOptionAttribute({ kind: 'enum', values: ['a', 'b'], default: 'a', live: true }, 'b'),
    ).toBe('b');
  });
});
