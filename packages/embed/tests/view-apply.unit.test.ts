import type { Network, Options } from '@latkit/network';
import { describe, expect, it, vi } from 'vitest';

import { applyView } from '../src/view/apply.js';
import { networkDataWithFields } from './fixtures.js';
import { direct, inputRevision, resolvedView } from './view-fixtures.js';

describe('initial view application', () => {
  it('applies runtime options, colormap, all channels, range resets, and projection', () => {
    const data = networkDataWithFields();
    const view = resolvedView(data, {
      vertices: 'false',
      projection: 'tilt',
      colormap: 'plasma',
      'vertex-color': 'load',
      'vertex-height': 'load',
      'vertex-size': 'capacity',
      'edge-color': 'flow',
      'edge-dash': 'flow',
      'vertex-height-range': '-1 2',
    });
    const h = networkHarness();

    applyView(h.value, null, view);

    expect(h.setOptions).toHaveBeenCalledOnce();
    expect(h.setOptions).toHaveBeenCalledWith(view.options);
    expect(h.setColormap).toHaveBeenCalledWith(view.colormap.fn);
    expect(h.setChannel.mock.calls).toEqual([
      ['vertexColor', data.fields![0]!.values, [10, 30]],
      ['vertexHeight', data.fields![0]!.values, [10, 30], [-1, 2]],
      ['vertexSize', data.fields![1]!.values, [40, 80]],
      ['edgeColor', data.fields![2]!.values, [4, 8]],
      ['edgeDash', data.fields![2]!.values],
    ]);
    expect(h.setChannelRange.mock.calls).toEqual([
      ['vertexColor', null],
      ['vertexHeight', null],
      ['vertexSize', null],
      ['edgeColor', null],
    ]);
    expect(h.setProjection).toHaveBeenCalledWith('tilt');
  });

  it('does not reapply runtime options already supplied at construction', () => {
    const view = resolvedView(networkDataWithFields());
    const h = networkHarness();

    applyView(h.value, null, view, view.options);

    expect(h.setOptions).not.toHaveBeenCalled();
    expect(h.setColormap).toHaveBeenCalledOnce();
    expect(h.setChannel).toHaveBeenCalledOnce();
    expect(h.setProjection).toHaveBeenCalledOnce();
  });
});

describe('differential option and colormap application', () => {
  it('collects effective runtime changes into one patch', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, {
      'base-color': '0.1 0.2 0.3 1',
      'hover-color': '0.7 0.2 0.1 1',
    });
    const next = resolvedView(data, {
      vertices: 'false',
      'night-floor': '0.2',
      'base-color': '0.1 0.2 0.3 1',
      'hover-color': '0.7 0.2 0.1 1',
    });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setOptions).toHaveBeenCalledWith({ vertices: false, nightFloor: 0.2 });
    expect(h.setOptions).toHaveBeenCalledOnce();
    expect(h.setColormap).not.toHaveBeenCalled();
    expect(h.setChannel).not.toHaveBeenCalled();
  });

  it('compares RGBA tuples by members rather than allocation identity', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, { 'base-color': '0.2 0.3 0.4 1' });
    const next = resolvedView(data, { 'base-color': '0.2 0.3 0.4 1' });
    const h = networkHarness();

    expect(previous.options.baseColor).not.toBe(next.options.baseColor);
    applyView(h.value, previous, next);
    expect(h.setOptions).not.toHaveBeenCalled();
  });

  it('compares named maps by name and custom maps by function identity', () => {
    const data = networkDataWithFields();
    const first = (value: number) => [value, value, value] as const;
    const second = (value: number) => [1 - value, value, 0] as const;
    const h = networkHarness();
    const previousNamed = resolvedView(data, { colormap: 'magma' });
    const nextNamed = resolvedView(data, { colormap: 'plasma' });

    applyView(h.value, previousNamed, nextNamed);
    expect(h.setColormap).toHaveBeenLastCalledWith(nextNamed.colormap.fn);

    h.setColormap.mockClear();
    applyView(
      h.value,
      resolvedView(data, {}, { configuration: { customColormap: first } }),
      resolvedView(data, {}, { configuration: { customColormap: first } }),
    );
    expect(h.setColormap).not.toHaveBeenCalled();

    applyView(
      h.value,
      resolvedView(data, {}, { configuration: { customColormap: first } }),
      resolvedView(data, {}, { configuration: { customColormap: second } }),
    );
    expect(h.setColormap).toHaveBeenCalledWith(second);
  });
});

describe('differential channel application', () => {
  it('reuploads a replacement source and clears any stale Network override', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, {
      'vertex-color': 'load',
      'vertex-color-domain': '11 29',
    });
    const next = resolvedView(data, { 'vertex-color': 'capacity' });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).toHaveBeenCalledWith('vertexColor', data.fields![1]!.values, [40, 80]);
    expect(h.setChannelRange).toHaveBeenCalledWith('vertexColor', null);
  });

  it.each([
    ['2 8', [2, 8]],
    [null, null],
  ] as const)('updates only a domain override to %s without uploading values', (raw, range) => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, {
      'vertex-color': 'load',
      'vertex-color-domain': '11 29',
    });
    const next = resolvedView(data, {
      'vertex-color': 'load',
      'vertex-color-domain': raw,
    });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).not.toHaveBeenCalled();
    expect(h.setChannelRange).toHaveBeenCalledWith('vertexColor', range);
  });

  it('reuploads height values when only the output range changes', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, {
      'vertex-height': 'load',
      'vertex-height-range': '0 1',
    });
    const next = resolvedView(data, {
      'vertex-height': 'load',
      'vertex-height-range': '-2 4',
    });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).toHaveBeenCalledWith(
      'vertexHeight',
      data.fields![0]!.values,
      [10, 30],
      [-2, 4],
    );
    expect(h.setChannelRange).toHaveBeenCalledWith('vertexHeight', null);
  });

  it('reuploads the same direct values when their retained base domain changes', () => {
    const data = networkDataWithFields();
    const values = new Float32Array([1, 2, 3]);
    const input = inputRevision(data, { vertexSize: direct(values, { baseDomain: [1, 3] }) });
    const previous = resolvedView(data, {}, { input });
    input.directChannels.vertexSize = direct(values, { baseDomain: [0, 4] });
    const next = resolvedView(data, {}, { input });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).toHaveBeenCalledWith('vertexSize', values, [0, 4]);
    expect(h.setChannelRange).toHaveBeenCalledWith('vertexSize', null);
  });

  it('clears unbound channels exactly once', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, { 'vertex-color': 'load' });
    const next = resolvedView(data, { 'vertex-color': '' });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.clearChannel).toHaveBeenCalledOnce();
    expect(h.clearChannel).toHaveBeenCalledWith('vertexColor');
    expect(h.setChannel).not.toHaveBeenCalled();
    expect(h.setChannelRange).not.toHaveBeenCalled();
  });

  it('never applies range operations to edgeDash', () => {
    const data = networkDataWithFields();
    const values = new Float32Array([0, 1, 0]);
    const input = inputRevision(data, { edgeDash: direct(values) });
    const previous = resolvedView(data, { 'edge-dash': '' });
    const next = resolvedView(data, {}, { input });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).toHaveBeenCalledWith('edgeDash', values);
    expect(h.setChannelRange).not.toHaveBeenCalled();
  });

  it('does nothing for equal effective channel state', () => {
    const data = networkDataWithFields();
    const previous = resolvedView(data, { 'vertex-color': 'load' });
    const next = resolvedView(data, { 'vertex-color': 'load' });
    const h = networkHarness();

    applyView(h.value, previous, next);

    expect(h.setChannel).not.toHaveBeenCalled();
    expect(h.clearChannel).not.toHaveBeenCalled();
    expect(h.setChannelRange).not.toHaveBeenCalled();
  });
});

describe('differential projection application', () => {
  it('sets a changed effective projection once', () => {
    const data = networkDataWithFields();
    const h = networkHarness();
    applyView(h.value, resolvedView(data), resolvedView(data, { projection: 'tilt' }));
    expect(h.setProjection).toHaveBeenCalledOnce();
    expect(h.setProjection).toHaveBeenCalledWith('tilt');
  });

  it('fails when Network rejects a supposedly available projection', () => {
    const data = networkDataWithFields();
    const h = networkHarness(false);
    expect(() =>
      applyView(h.value, resolvedView(data), resolvedView(data, { projection: 'tilt' })),
    ).toThrow('resolved projection tilt is unavailable');
  });
});

interface NetworkHarness {
  readonly value: Network;
  readonly setOptions: ReturnType<typeof vi.fn<(options: Options) => void>>;
  readonly setColormap: ReturnType<typeof vi.fn>;
  readonly setChannel: ReturnType<typeof vi.fn>;
  readonly clearChannel: ReturnType<typeof vi.fn>;
  readonly setChannelRange: ReturnType<typeof vi.fn>;
  readonly setProjection: ReturnType<typeof vi.fn>;
}

function networkHarness(projectionResult = true): NetworkHarness {
  const setOptions = vi.fn<(options: Options) => void>();
  const setColormap = vi.fn();
  const setChannel = vi.fn();
  const clearChannel = vi.fn();
  const setChannelRange = vi.fn();
  const setProjection = vi.fn(() => projectionResult);
  return {
    value: {
      setOptions,
      setColormap,
      setChannel,
      clearChannel,
      setChannelRange,
      setProjection,
    } as unknown as Network,
    setOptions,
    setColormap,
    setChannel,
    clearChannel,
    setChannelRange,
    setProjection,
  };
}
