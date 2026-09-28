import { describe, expect, it, vi } from 'vitest';

import { parseColor, validateRgba } from '../src/index.js';

const close = (actual: readonly number[] | null, expected: readonly number[], digits = 3) => {
  expect(actual).not.toBeNull();
  actual!.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits));
};

describe('parseColor', () => {
  it('reads every hex length', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#f008')).toEqual([1, 0, 0, 0x88 / 255]);
    expect(parseColor('#00FF00')).toEqual([0, 1, 0, 1]);
    expect(parseColor(' #0000ff80 ')).toEqual([0, 0, 1, 0x80 / 255]);
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor('#ggg')).toBeNull();
  });

  it('reads rgb() and rgba() in the legacy and the modern syntax', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColor('rgba(0, 255, 0, 0.5)')).toEqual([0, 1, 0, 0.5]);
    expect(parseColor('rgb(0 0 255 / 25%)')).toEqual([0, 0, 1, 0.25]);
    expect(parseColor('RGB(100% 50% 0%)')).toEqual([1, 0.5, 0, 1]);
    expect(parseColor('rgba(none 0 0)')).toEqual([0, 0, 0, 1]);
    expect(parseColor('rgb(300 -5 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColor('rgb(1, 2)')).toBeNull();
    expect(parseColor('rgb(1 2 3 / 4 / 5)')).toBeNull();
    expect(parseColor('rgb(a b c)')).toBeNull();
  });

  it('converts oklab() and oklch() into sRGB', () => {
    close(parseColor('oklab(1 0 0)'), [1, 1, 1, 1]);
    close(parseColor('oklab(0% 0 0 / 0.5)'), [0, 0, 0, 0.5]);
    close(parseColor('oklab(0.62796 0.22486 0.12585)'), [1, 0, 0, 1]);
    close(parseColor('oklch(0.62796 0.25768 29.2339)'), [1, 0, 0, 1]);
    close(parseColor('oklch(62.796% 64.42% 0.51023rad)'), [1, 0, 0, 1]);
    close(parseColor('oklch(0.45201 0.31321 264.052deg)'), [0, 0, 1, 1]);
    close(parseColor('oklch(0.62796 0.25768 0.0812053turn)'), [1, 0, 0, 1]);
    expect(parseColor('oklch(0.5 0.1)')).toBeNull();
  });

  it('reads color(srgb) and color(srgb-linear), the forms color-mix() computes to', () => {
    expect(parseColor('color(srgb 1 0.5 0 / 0.5)')).toEqual([1, 0.5, 0, 0.5]);
    close(parseColor('color(srgb-linear 0.2140 0 1)'), [0.5, 0, 1, 1]);
    expect(parseColor('color(display-p3 1 0 0)')).toBeNull();
  });

  it('reads transparent and refuses everything else', () => {
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('hsl(0 100% 50%)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });

  it('resolves through a context element as it computes the color, and removes its probe', () => {
    const { context, append, probes } = stubContext({
      resolved: '#e8e8e8',
      color: 'color(srgb 0.909804 0.909804 0.909804)',
    });
    close(parseColor('var(--edge)', context), [232 / 255, 232 / 255, 232 / 255, 1]);
    expect(append).toHaveBeenCalledOnce();
    expect(probes[0]!.style.setProperty).toHaveBeenCalledWith(
      'color',
      'color-mix(in srgb, var(--latkit-color) 100%, transparent)',
    );
    expect(probes[0]!.remove).toHaveBeenCalledOnce();
  });

  it('reads any color space the context computes, as the browser mixes it into sRGB', () => {
    const { context } = stubContext({
      resolved: 'lab(50% 40 60)',
      color: 'color(srgb 0.75 0.33 0.1 / 0.5)',
    });
    expect(parseColor('lab(50% 40 60 / 0.5)', context)).toEqual([0.75, 0.33, 0.1, 0.5]);
  });

  it('probes inside the context shadow root, leaving its light DOM untouched', () => {
    const shadow = vi.fn();
    const { context, append } = stubContext(
      { resolved: 'red', color: 'color(srgb 1 0 0)' },
      { append: shadow },
    );
    expect(parseColor('red', context)).toEqual([1, 0, 0, 1]);
    expect(shadow).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it('reads a literal color without computing a style', () => {
    const { context, append } = stubContext({ resolved: '', color: '' });
    expect(parseColor('#ff0000', context)).toEqual([1, 0, 0, 1]);
    expect(append).not.toHaveBeenCalled();
  });

  it('is null through a context when a var() is undefined or resolves to no color', () => {
    expect(parseColor('var(--missing)', stubContext({ resolved: '', color: 'x' }).context)).toBe(
      null,
    );
    expect(
      parseColor('var(--gap)', stubContext({ resolved: '12px', color: 'rgb(0, 0, 0)' }).context),
    ).toBeNull();
  });
});

/** A context element whose window computes `color` for a probe whose custom property reads `resolved`. */
function stubContext(
  computed: { resolved: string; color: string },
  shadowRoot: { append: (...nodes: unknown[]) => void } | null = null,
) {
  const probes: {
    style: { setProperty: ReturnType<typeof vi.fn> };
    remove: ReturnType<typeof vi.fn>;
  }[] = [];
  const append = vi.fn();
  const view = {
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => (name === '--latkit-color' ? computed.resolved : ''),
      color: computed.color,
    }),
    CSS: { supports: (_property: string, value: string) => !value.endsWith('px') },
  };
  const context = {
    append,
    shadowRoot,
    ownerDocument: {
      defaultView: view,
      createElement: () => {
        const probe = { style: { setProperty: vi.fn(), display: '' }, remove: vi.fn() };
        probes.push(probe);
        return probe;
      },
    },
  } as unknown as Element;
  return { context, append, probes };
}

describe('validateRgba', () => {
  it('accepts four finite components in [0, 1]', () => {
    expect(() => validateRgba([0, 0.5, 1, 1])).not.toThrow();
  });

  it('rejects the wrong shape with a TypeError naming the value', () => {
    expect(() => validateRgba([0, 0, 0], 'option x')).toThrow(
      new TypeError('option x must be an RGBA tuple'),
    );
    expect(() => validateRgba(['0', 0, 0, 1])).toThrow(TypeError);
    expect(() => validateRgba(null)).toThrow(TypeError);
  });

  it('rejects components outside [0, 1] or non-finite with a RangeError', () => {
    expect(() => validateRgba([0, 0, 1.5, 1], 'option x')).toThrow(
      new RangeError('option x RGBA components must be finite and in [0, 1]'),
    );
    expect(() => validateRgba([Number.NaN, 0, 0, 1])).toThrow(RangeError);
    expect(() => validateRgba([-0.1, 0, 0, 1])).toThrow(RangeError);
  });
});
