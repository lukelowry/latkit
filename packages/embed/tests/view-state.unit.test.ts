import { OPTIONS, type Channel, type Network } from '@latkit/network';
import { describe, expect, it } from 'vitest';

import {
  effectiveChannelDomain,
  resolveOptionState,
  validateDirectChannelLengths,
} from '../src/view/state.js';
import { networkDataWithFields } from './fixtures.js';
import {
  ALL_PROJECTIONS,
  attributeValues,
  direct,
  elementConfiguration,
  inputRevision,
  resolvedView,
} from './view-fixtures.js';

describe('resolved option state', () => {
  it('uses Network defaults, Embed viridis, and no border source', () => {
    const state = resolveOptionState(attributeValues(), elementConfiguration());
    const expectedRuntime = Object.fromEntries(
      Object.entries(OPTIONS)
        .filter(([key, definition]) => key !== 'colormap' && definition.live)
        .map(([key, definition]) => [key, definition.default]),
    );

    expect(state.msaa).toBeUndefined();
    expect(state.options).toEqual(expectedRuntime);
    expect(state.options.heightRange).toEqual([0, 1]);
    expect(state.colormap).toMatchObject({ kind: 'named', name: 'viridis' });
    expect(state.borders).toEqual({ kind: 'none' });
    expect(state.warnings).toEqual([]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.options)).toBe(true);
  });

  it('resolves construction/live attributes and custom precedence independently', () => {
    const customColormap = (value: number) => [value, 0, 1 - value] as const;
    const customBorders = {
      vertices: new Uint8Array(24),
      indices: new Uint32Array([0]),
    };
    const state = resolveOptionState(
      attributeValues({
        msaa: '4',
        vertices: 'false',
        'vertex-scale': '1.25',
        'edge-scale': '0.75',
        'height-scale': '1.5',
        'height-range': '0 2',
        'vertex-lod-px': '3',
        'dash-period-px': '16',
        'night-floor': '0.25',
        'base-color': '0.1 0.2 0.3 1',
        colormap: 'magma',
        'border-source': 'natural-earth',
      }),
      elementConfiguration({ customColormap, customBorders }),
    );

    expect(state.msaa).toBe(4);
    expect(state.options.vertices).toBe(false);
    expect(state.options.vertexScale).toBe(1.25);
    expect(state.options.edgeScale).toBe(0.75);
    expect(state.options.heightScale).toBe(1.5);
    expect(state.options.heightRange).toEqual([0, 2]);
    expect(state.options.vertexLodPx).toBe(3);
    expect(state.options.dashPeriodPx).toBe(16);
    expect(state.options.nightFloor).toBe(0.25);
    expect(state.options.baseColor).toEqual([0.1, 0.2, 0.3, 1]);
    expect(state.colormap).toEqual({ kind: 'custom', fn: customColormap, revision: 0 });
    expect(state.borders).toEqual({ kind: 'custom', data: customBorders, revision: 0 });
  });

  it.each([
    [undefined, null, 'none'],
    [undefined, 'none', 'none'],
    [undefined, 'natural-earth', 'natural-earth'],
    [null, 'natural-earth', 'none'],
  ] as const)('resolves custom border %s over attribute %s', (customBorders, source, kind) => {
    const state = resolveOptionState(
      attributeValues({ 'border-source': source }),
      elementConfiguration({ customBorders }),
    );
    expect(state.borders.kind).toBe(kind);
  });

  it('warns for invalid options, colormap, and border source without failing', () => {
    const state = resolveOptionState(
      attributeValues({
        'night-floor': 'Infinity',
        colormap: 'future-map',
        'border-source': 'countries',
      }),
      elementConfiguration(),
    );

    expect(state.options.nightFloor).toBe(OPTIONS.nightFloor.default);
    expect(state.colormap).toMatchObject({ kind: 'named', name: 'viridis' });
    expect(state.borders).toEqual({ kind: 'none' });
    expect(state.warnings.map(({ key }) => key)).toEqual([
      'night-floor\0Infinity',
      'colormap\0future-map',
      'border-source\0countries',
    ]);
  });
});

describe('resolved channels', () => {
  it('binds every canonical channel with normalized field extents as domains', () => {
    const view = resolvedView(networkDataWithFields(), {
      colormap: 'plasma',
      projection: 'tilt',
      'vertex-color': 'capacity',
      'vertex-height': 'load',
      'vertex-size': 'capacity',
      'vertex-visible': 'capacity',
      'edge-color': 'flow',
      'edge-dash': 'flow',
      'edge-visible': 'flow',
    });

    expect(view.projection).toBe('tilt');
    expect(view.colormap).toMatchObject({ kind: 'named', name: 'plasma' });
    expect(channelSummary(view.channels)).toEqual({
      vertexColor: ['capacity', [40, 80], null],
      vertexHeight: ['load', [10, 30], null],
      vertexSize: ['capacity', [40, 80], null],
      vertexVisible: ['capacity', null, null],
      edgeColor: ['flow', [4, 8], null],
      edgeDash: ['flow', null, null],
      edgeVisible: ['flow', null, null],
    });
    expect(view.warnings).toEqual([]);
  });

  it('keeps binding domains distinct from declarative overrides', () => {
    const view = resolvedView(networkDataWithFields(), {
      'vertex-height': 'load',
      'vertex-height-domain': '12 25',
      'edge-color': 'flow',
      'edge-color-domain': '5 7',
    });

    expect(view.channels.vertexHeight).toMatchObject({
      baseDomain: [10, 30],
      domainOverride: [12, 25],
    });
    expect(view.channels.edgeColor).toMatchObject({
      baseDomain: [4, 8],
      domainOverride: [5, 7],
    });
    expect(effectiveChannelDomain(view.channels.vertexHeight!)).toEqual([12, 25]);
  });

  it('gives direct arrays precedence and passes their domains through to Network', () => {
    const data = networkDataWithFields();
    const heightValues = new Float32Array([7, 2, 5]);
    const sizeValues = new Float32Array([3, 4, 5]);
    const input = inputRevision(data, {
      vertexColor: direct(new Float32Array([1, 2, 3]), { baseDomain: [1, 3] }),
      vertexHeight: direct(heightValues),
      vertexSize: direct(sizeValues, { baseDomain: null }),
    });
    const view = resolvedView(
      data,
      { 'vertex-color': 'load', 'vertex-height-domain': '3 6' },
      { input },
    );

    expect(view.channels.vertexColor).toMatchObject({
      kind: 'direct',
      values: input.directChannels.vertexColor!.values,
      baseDomain: [1, 3],
    });
    expect(view.channels.vertexHeight).toMatchObject({
      kind: 'direct',
      values: heightValues,
      domainOverride: [3, 6],
    });
    expect(view.channels.vertexHeight?.baseDomain).toBeUndefined();
    expect(view.channels.vertexSize).toMatchObject({
      kind: 'direct',
      values: sizeValues,
      baseDomain: null,
    });
    expect(effectiveChannelDomain(view.channels.vertexSize!)).toEqual([0, 1]);
  });

  it.each([
    ['vertex-color', 'flow', 'edge-scoped'],
    ['edge-color', 'missing', 'Unknown field'],
    ['vertex-color', ' load ', 'Unknown field'],
  ] as const)('rejects invalid exact field binding %s=%s', (attribute, field, message) => {
    const view = resolvedView(networkDataWithFields(), {
      'vertex-color': '',
      [attribute]: field,
    });
    const channel = attribute === 'edge-color' ? 'edgeColor' : 'vertexColor';
    expect(view.channels[channel]).toBeNull();
    expect(view.warnings.some((warning) => warning.message.includes(message))).toBe(true);
  });

  it('treats empty attributes as explicit unbinding', () => {
    const view = resolvedView(networkDataWithFields(), {
      'vertex-color': '',
      'vertex-height': '',
      'vertex-size': '',
      'edge-color': '',
      'edge-dash': '',
    });
    expect(Object.values(view.channels).every((binding) => binding === null)).toBe(true);
  });

  it('validates deferred direct-array cardinality against topology', () => {
    const data = networkDataWithFields();
    const input = inputRevision(data, {
      vertexColor: direct(new Float32Array([1, 2])),
      edgeColor: direct(new Float32Array([1, 2, 3])),
    });
    expect(() => validateDirectChannelLengths(data, input)).toThrow(
      'network channel vertexColor length 2 != 3',
    );
  });
});

describe('projection and controls resolution', () => {
  it('uses requested support, then projection continuity, then flat', () => {
    const data = networkDataWithFields();
    const tiltOnlyFallback: Network['projections'] = { flat: true, tilt: true, globe: false };
    const unavailableTilt: Network['projections'] = { flat: true, tilt: false, globe: false };

    const supported = resolvedView(data, { projection: 'globe' });
    const continuity = resolvedView(
      data,
      { projection: 'globe' },
      {
        projections: tiltOnlyFallback,
        configuration: { lastProjection: 'tilt' },
      },
    );
    const flat = resolvedView(
      data,
      { projection: 'globe' },
      {
        projections: unavailableTilt,
        configuration: { lastProjection: 'tilt' },
      },
    );
    const unknown = resolvedView(
      data,
      { projection: 'map' },
      {
        configuration: { lastProjection: 'tilt' },
      },
    );

    expect([supported.requestedProjection, supported.projection]).toEqual(['globe', 'globe']);
    expect([continuity.requestedProjection, continuity.projection]).toEqual(['globe', 'tilt']);
    expect([flat.requestedProjection, flat.projection]).toEqual(['globe', 'flat']);
    expect([unknown.requestedProjection, unknown.projection]).toEqual(['flat', 'flat']);
    expect(continuity.warnings).toEqual([]);
    expect(unknown.warnings.some(({ key }) => key === 'projection\0map')).toBe(true);
  });

  it('derives every meaningful automatic control from current state', () => {
    const view = resolvedView(networkDataWithFields());
    expect([...view.controls]).toEqual([
      'caption',
      'fit',
      'zoom',
      'projection',
      'vertex-color',
      'vertex-color-legend',
      'vertex-height',
      'vertex-size',
      'edge-color',
      'edge-dash',
      'vertex-visible',
      'edge-visible',
      'colormap',
    ]);
  });

  it('keeps explicit controls even when currently inapplicable and honors none', () => {
    const explicit = resolvedView(
      networkDataWithFields(),
      {
        controls: 'projection edge-color edge-color-legend',
        'edge-color': '',
      },
      { projections: { flat: true, tilt: false, globe: false } },
    );
    const none = resolvedView(networkDataWithFields(), { controls: 'none' });

    expect([...explicit.controls]).toEqual(['projection', 'edge-color', 'edge-color-legend']);
    expect([...none.controls]).toEqual([]);
  });

  it('makes direct bindings meaningful in auto mode without matching fields', () => {
    const data = networkDataWithFields();
    const withoutFields = { ...data, fields: [] };
    const input = inputRevision(withoutFields, {
      edgeColor: direct(new Float32Array([1, 2, 3])),
    });
    const view = resolvedView(withoutFields, {}, { input, projections: ALL_PROJECTIONS });

    expect(view.controls.has('edge-color')).toBe(true);
    expect(view.controls.has('edge-color-legend')).toBe(true);
    expect(view.controls.has('colormap')).toBe(true);
    expect(view.controls.has('vertex-color')).toBe(false);
  });
});

function channelSummary(channels: ReturnType<typeof resolvedView>['channels']) {
  return Object.fromEntries(
    Object.entries(channels).map(([channel, binding]) => [
      channel,
      binding?.kind === 'field'
        ? [binding.entry.field.id, binding.baseDomain, binding.domainOverride]
        : null,
    ]),
  ) as Record<Channel, unknown>;
}
