import {
  CHANNEL_DEFINITIONS,
  DEFAULT_OPTIONS,
  OPTION_DEFINITIONS,
  PROJECTION_MODES,
  type Options,
} from '@latkit/network';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ATTRIBUTES,
  CONTROL_NAMES,
  NORMALIZED_CHANNEL_NAMES,
  OPTION_ATTRIBUTES,
  OPTION_BY_ATTRIBUTE,
  VIEW_ATTRIBUTES,
  assertFloat32Array,
  assertProjectionMode,
  channelAttribute,
  checkedRange,
  htmlName,
  parseControls,
  parseOptionAttribute,
  parseRange,
  serializeOption,
  serializeRange,
  type Control,
  type OptionAttribute,
  type ViewWarning,
} from '../src/view/attributes.js';

describe('view attribute registries', () => {
  it('derives every serializable option from Network metadata', () => {
    const expected = Object.entries(OPTION_DEFINITIONS)
      .filter(([name]) => name !== 'colormap')
      .map(([option, definition]) => ({ option, attribute: htmlName(option), definition }));

    expect(OPTION_ATTRIBUTES).toEqual(expected);
    expect(OPTION_ATTRIBUTES.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(OPTION_ATTRIBUTES)).toBe(true);
    for (const entry of OPTION_ATTRIBUTES) {
      expect(OPTION_BY_ATTRIBUTE.get(entry.attribute)).toBe(entry);
      expect(entry.definition).toBe(OPTION_DEFINITIONS[entry.option]);
    }
  });

  it('derives channel attributes, domains, height range, and controls in canonical order', () => {
    expect(CHANNEL_ATTRIBUTES).toEqual(
      CHANNEL_DEFINITIONS.map((definition) => ({
        ...definition,
        attribute: htmlName(definition.key),
        domainAttribute:
          definition.map === 'dash' || definition.map === 'visible'
            ? null
            : `${htmlName(definition.key)}-domain`,
        rangeAttribute: definition.map === 'height' ? `${htmlName(definition.key)}-range` : null,
      })),
    );
    expect(NORMALIZED_CHANNEL_NAMES).toEqual([
      'vertexColor',
      'vertexHeight',
      'vertexSize',
      'edgeColor',
    ]);
    expect(CONTROL_NAMES).toEqual([
      'caption',
      'projection',
      'fit',
      'zoom',
      'colormap',
      'vertex-color',
      'vertex-height',
      'vertex-size',
      'edge-color',
      'edge-dash',
      'vertex-visible',
      'edge-visible',
      'vertex-color-legend',
      'edge-color-legend',
    ]);
  });

  it('publishes one unique observed name for every resolved input', () => {
    expect(new Set(VIEW_ATTRIBUTES).size).toBe(VIEW_ATTRIBUTES.length);
    expect(VIEW_ATTRIBUTES).toContain('projection');
    expect(VIEW_ATTRIBUTES).toContain('colormap');
    expect(VIEW_ATTRIBUTES).toContain('border-source');
    expect(VIEW_ATTRIBUTES).toContain('controls');
    for (const option of OPTION_ATTRIBUTES) expect(VIEW_ATTRIBUTES).toContain(option.attribute);
    for (const channel of CHANNEL_ATTRIBUTES) {
      expect(VIEW_ATTRIBUTES).toContain(channel.attribute);
      if (channel.domainAttribute) expect(VIEW_ATTRIBUTES).toContain(channel.domainAttribute);
      if (channel.rangeAttribute) expect(VIEW_ATTRIBUTES).toContain(channel.rangeAttribute);
    }
  });
});

describe('option attributes', () => {
  const validCases: ReadonlyArray<readonly [keyof Options, string, unknown, string]> = [
    ['vertices', '', true, 'true'],
    ['edges', 'false', false, 'false'],
    ['vertexScale', '1.25', 1.25, '1.25'],
    ['edgeScale', '0.75', 0.75, '0.75'],
    ['heightScale', '1.5', 1.5, '1.5'],
    ['vertexLodPx', '3', 3, '3'],
    ['dashPeriodPx', '16', 16, '16'],
    ['nightFloor', '-1.25e-2', -0.0125, '-0.0125'],
    ['terminatorWidth', '2.5', 2.5, '2.5'],
    ['baseColor', '0 0.25 0.5 1', [0, 0.25, 0.5, 1], '0 0.25 0.5 1'],
    ['focusEndpointMode', 'hover-selected', 'hover-selected', 'hover-selected'],
    ['msaa', '4', 4, '4'],
  ];

  it.each(validCases)(
    'parses and serializes %s through its Network validator',
    (key, raw, value, serialized) => {
      const warnings: ViewWarning[] = [];
      const entry = option(key);
      const parsed = parseOptionAttribute(entry, raw, warnings);

      expect(parsed).toEqual(value);
      expect(serializeOption(entry, parsed)).toBe(serialized);
      expect(warnings).toEqual([]);
    },
  );

  it('uses exact kebab-case names for live geometry options', () => {
    expect(
      (['vertexScale', 'edgeScale', 'heightScale', 'vertexLodPx', 'dashPeriodPx'] as const).map(
        (key) => option(key).attribute,
      ),
    ).toEqual(['vertex-scale', 'edge-scale', 'height-scale', 'vertex-lod-px', 'dash-period-px']);
  });

  it.each([
    ['vertices', 'yes'],
    ['nightFloor', '0x10'],
    ['nightFloor', 'Infinity'],
    ['terminatorWidth', '-0.1'],
    ['baseColor', '0 0 0'],
    ['baseColor', '0 0 0 1.1'],
    ['focusEndpointMode', 'hover'],
    ['msaa', '2'],
  ] as const)('warns and uses the Network default for invalid %s=%s', (key, raw) => {
    const warnings: ViewWarning[] = [];
    const entry = option(key);

    expect(parseOptionAttribute(entry, raw, warnings)).toEqual(DEFAULT_OPTIONS[key]);
    expect(warnings).toEqual([
      {
        key: `${entry.attribute}\0${raw}`,
        message: `Invalid ${entry.attribute} ${JSON.stringify(raw)}; using the Network default.`,
      },
    ]);
  });

  it('uses defaults without warning when attributes are absent', () => {
    for (const entry of OPTION_ATTRIBUTES) {
      const warnings: ViewWarning[] = [];
      expect(parseOptionAttribute(entry, null, warnings)).toBe(DEFAULT_OPTIONS[entry.option]);
      expect(warnings).toEqual([]);
    }
  });

  it.each([
    ['vertices', 'true'],
    ['nightFloor', Number.NaN],
    ['terminatorWidth', -1],
    ['baseColor', [0, 0, 0, 2]],
    ['focusEndpointMode', 'selected-hover'],
    ['msaa', 8],
  ] as const)('rejects invalid imperative serialization for %s', (key, value) => {
    expect(() => serializeOption(option(key as keyof Options), value)).toThrow();
  });
});

describe('range and enum attributes', () => {
  it.each([
    ['-1 2.5', [-1, 2.5]],
    ['.5 1e2', [0.5, 100]],
  ] as const)('parses strict decimal range %s', (raw, expected) => {
    const warnings: ViewWarning[] = [];
    expect(parseRange('vertex-color-domain', raw, warnings)).toEqual(expected);
    expect(warnings).toEqual([]);
  });

  it.each(['', '1', '2 1', '0x1 2', '0 Infinity', '0 1 2'])('rejects invalid range %s', (raw) => {
    const warnings: ViewWarning[] = [];
    expect(parseRange('vertex-color-domain', raw, warnings)).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('validates and copies imperative ranges', () => {
    const input = [1, 2] as const;
    const checked = checkedRange(input, 'domain');
    expect(checked).toEqual(input);
    expect(checked).not.toBe(input);
    expect(serializeRange(input)).toBe('1 2');
    expect(() => checkedRange([2, 1], 'domain')).toThrow(RangeError);
    expect(() => checkedRange([1, Number.NaN], 'domain')).toThrow(RangeError);
  });

  it('validates projections, channels, and typed arrays through canonical boundaries', () => {
    for (const mode of PROJECTION_MODES) expect(() => assertProjectionMode(mode)).not.toThrow();
    expect(() => assertProjectionMode('map')).toThrow(TypeError);
    for (const channel of CHANNEL_DEFINITIONS) expect(channelAttribute(channel.key)).toBeDefined();
    expect(() => channelAttribute('color' as never)).toThrow(TypeError);
    expect(() => assertFloat32Array(new Float32Array(), 'values')).not.toThrow();
    expect(() => assertFloat32Array([1, 2], 'values')).toThrow(TypeError);
  });
});

describe('controls grammar', () => {
  it.each([null, '', '   ', 'auto', 'auto auto'])('resolves %s to automatic controls', (raw) => {
    const warnings: ViewWarning[] = [];
    expect(parseControls(raw, warnings)).toEqual({ mode: 'auto' });
    expect(warnings).toEqual([]);
  });

  it('expands groups, collapses duplicates, and retains canonical order', () => {
    const warnings: ViewWarning[] = [];
    const selection = parseControls(
      'navigation channels legends fit vertex-color vertex-color',
      warnings,
    );

    expect(selection.mode).toBe('explicit');
    expect(selection.mode === 'explicit' ? [...selection.controls] : []).toEqual([
      'fit',
      'zoom',
      'vertex-color',
      'vertex-height',
      'vertex-size',
      'edge-color',
      'edge-dash',
      'vertex-visible',
      'edge-visible',
      'vertex-color-legend',
      'edge-color-legend',
    ] satisfies Control[]);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['none caption mystery mystery', 'none'],
    ['auto projection mystery', 'auto'],
  ] as const)('warns once and lets %s win', (raw, mode) => {
    const warnings: ViewWarning[] = [];
    expect(parseControls(raw, warnings)).toEqual({ mode });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('mystery');
  });

  it('drops unknown-only tokens into an empty explicit selection', () => {
    const warnings: ViewWarning[] = [];
    const selection = parseControls('future-control', warnings);
    expect(selection.mode).toBe('explicit');
    expect(selection.mode === 'explicit' ? [...selection.controls] : []).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

function option(key: keyof Options): OptionAttribute {
  const entry = OPTION_ATTRIBUTES.find((candidate) => candidate.option === key);
  if (!entry) throw new Error(`Missing option attribute ${String(key)}`);
  return entry;
}
