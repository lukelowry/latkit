import { TextureData } from '../texture-data.js';
import type { RGBA } from './color.js';
import { validateColormap, type Colormap } from './colormap.js';
import { namedColormap, type ColormapName } from './catalog.js';

const pixels = new WeakMap<Colormap, TextureData>();
/** Shared private premultiplied sRGB table. It is never exposed for mutation. */
export function colormapPixels(map: Colormap): TextureData {
  const hit = pixels.get(map);
  if (hit) return hit;
  validateColormap(map);
  const count = map.colors.length,
    cyclic = map.kind === 'cyclic';
  const data = new TextureData({ width: count + (cyclic ? 1 : 0), height: 1 });
  for (let i = 0; i < data.width; i++) {
    const color = map.colors[i % count];
    const alpha = Math.round(color[3] * 255);
    for (let c = 0; c < 3; c++) data.bytes[i * 4 + c] = Math.round(color[c] * alpha);
    data.bytes[i * 4 + 3] = alpha;
  }
  data.touch();
  pixels.set(map, data);
  return data;
}
/** Straight RGBA from the same quantized, premultiplied samples used by WebGPU and CSS. */
export function pixelColor(data: TextureData, at: number): RGBA {
  const a = data.bytes[at * 4 + 3];
  return a
    ? [data.bytes[at * 4] / a, data.bytes[at * 4 + 1] / a, data.bytes[at * 4 + 2] / a, a / 255]
    : [0, 0, 0, 0];
}
/** Finite normalized input: clamp continuous maps, wrap cyclic maps, or select categorical bins. */
export function sampleColormap(value: Colormap | ColormapName, t: number): RGBA {
  if (!Number.isFinite(t)) throw new RangeError('Colormap coordinate must be finite');
  const map = namedColormap(value),
    data = colormapPixels(map);
  t = map.kind === 'cyclic' ? t - Math.floor(t) : Math.max(0, Math.min(1, t));
  if (map.kind === 'categorical')
    return pixelColor(data, Math.min(data.width - 1, Math.floor(t * data.width)));
  const x = t * (data.width - 1),
    left = Math.floor(x),
    right = Math.min(left + 1, data.width - 1),
    weight = x - left;
  const channel = (c: number) =>
    data.bytes[left * 4 + c] * (1 - weight) + data.bytes[right * 4 + c] * weight;
  const alpha = channel(3);
  return alpha
    ? [channel(0) / alpha, channel(1) / alpha, channel(2) / alpha, alpha / 255]
    : [0, 0, 0, 0];
}
