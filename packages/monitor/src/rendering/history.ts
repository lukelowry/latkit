import { type Gpu, kit } from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import type { Binding, Look } from '../bindings.js';

/** Where an image's pixels lie: its size, the window and values it spans, and its samples. */
export interface Transform {
  readonly width: number;
  readonly height: number;
  readonly window: Domain;
  readonly values: Domain;
  readonly msaa: 1 | 4;
}
/** How far a trace is drawn into a layer. */
export interface Progress {
  /** The last absolute frame drawn for every row; the next lines start from it. */
  readonly through?: number;
  /** A chunk drawn for its first `rows` rows, which finishes before anything later. */
  readonly chunk?: { readonly start: number; readonly frames: number; readonly rows: number };
}
/**
 * What a layer holds, which is only what composition cannot recover: the colors of traces whose
 * color is fixed; the coverage of traces colored by what they plot, whose value is where a line
 * lies; or the color values of traces colored by another field.
 */
export type LayerKind = 'color' | 'coverage' | 'value';
export const LAYER_FORMATS: Readonly<Record<LayerKind, GPUTextureFormat>> = {
  color: 'rgba8unorm',
  coverage: 'r8unorm',
  value: 'rgba16float',
};
const TEXEL_BYTES: Readonly<Record<LayerKind, number>> = { color: 4, coverage: 1, value: 8 };
/** Traces drawn into one layer, and the look composition gives a value layer. */
export interface Group {
  /** What the layer's pixels depend on; a layer of another key starts over. */
  readonly key: string;
  readonly kind: LayerKind;
  readonly traces: readonly Binding[];
  readonly look: Look;
}
/** Pixels a group of traces drew, and how far each trace is drawn. */
export interface Layer {
  readonly key: string;
  readonly kind: LayerKind;
  /** The domain a value layer's color values store against, unclamped: its look remaps from it. */
  readonly stored: Domain;
  readonly texture: kit.TextureResource;
  readonly msaa?: kit.TextureResource;
  readonly progress: Map<string, Progress>;
  /** Cleared by its next pass. */
  fresh: boolean;
  /** The look it composes with: its group's, as of the latest frame that kept it. */
  look: Look;
}
/** History for one transform: its layers, in the order they compose. */
export interface Image extends Transform {
  layers: readonly Layer[];
}
export function sameTransform(a: Transform | undefined, b: Transform): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.msaa === b.msaa &&
    a.window[0] === b.window[0] &&
    a.window[1] === b.window[1] &&
    a.values[0] === b.values[0] &&
    a.values[1] === b.values[1]
  );
}
export function image({ width, height, window, values, msaa }: Transform): Image {
  return { width, height, window, values, msaa, layers: [] };
}
/** Looks an image keeps apart, each a composition pass every frame. */
const APART = 4;
/**
 * The layers an image draws, in trace order. Traces whose color is fixed share one layer of their
 * colors. Traces a look maps share a layer for each look, which composition colors, so a new domain
 * or colormap draws nothing: the first few looks, while their layers fit `bytes`. Later looks bake
 * into the color layer, as every look once did, so an image keeps few layers however many looks
 * its traces have.
 */
export function plan(
  traces: readonly Binding[],
  drawn: unknown,
  baked: unknown,
  target: Pick<Transform, 'width' | 'height' | 'msaa'>,
  bytes: number,
): Group[] {
  const apart = new Set<string>();
  let room = bytes - layerBytes(target, 'color');
  for (const trace of traces) {
    const kind = trace.look.layer,
      cost = layerBytes(target, kind);
    if (kind === 'color' || apart.has(trace.lookKey) || apart.size === APART || cost > room)
      continue;
    apart.add(trace.lookKey);
    room -= cost;
  }
  const groups = new Map<string, { kind: LayerKind; traces: Binding[]; look: Look }>();
  for (const trace of traces) {
    const kind = apart.has(trace.lookKey) ? trace.look.layer : 'color',
      by = kind === 'color' ? kind : trace.lookKey;
    let group = groups.get(by);
    if (!group) groups.set(by, (group = { kind, traces: [], look: trace.look }));
    group.traces.push(trace);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    key: JSON.stringify([
      group.kind,
      group.traces.map((trace) => [
        trace.name,
        trace.version,
        ...(group.kind === 'color' ? [trace.look.base, baking(trace) ? trace.lookKey : null] : []),
      ]),
      drawn,
      group.kind === 'color' ? baked : null,
    ]),
  }));
}
/** Whether a trace's look maps its values, so the color layer bakes that look in. */
export const baking = (trace: Binding) => trace.look.layer !== 'color';
/** The domain a look colors over in an image; the values axis is the image's own. */
export function domainOf(look: Look, target: Transform): Domain | null {
  return look.domain === 'values' ? target.values : look.domain;
}
/**
 * Fit an image's layers to its groups, returning each group's layer: a layer whose key stands keeps
 * its pixels, and the rest start over in textures the image no longer needs, or in new ones
 * `reserve` admits. Without `restart`, as for a shown image whose replacement draws behind it,
 * nothing starts over: layers whose key stands keep up, and the rest show as they are.
 */
export function reconcile(
  gpu: Gpu,
  target: Image,
  groups: readonly Group[],
  reserve: (bytes: number) => void,
  restart = true,
): readonly (Layer | undefined)[] {
  const standing = new Map(target.layers.map((layer) => [layer.key, layer]));
  const layers: (Layer | undefined)[] = groups.map((group) => {
    const layer = standing.get(group.key);
    if (!layer || (layer.kind === 'value' && drifted(layer.stored, domainOf(group.look, target))))
      return undefined;
    standing.delete(group.key);
    layer.look = group.look;
    return layer;
  });
  if (!restart) return layers;
  // Layers no group keeps lend their textures to groups starting over; the rest go.
  const spare = [...standing.values()];
  for (const [i, group] of groups.entries()) {
    const j = layers[i] ? -1 : spare.findIndex((layer) => layer.kind === group.kind);
    if (j >= 0) layers[i] = reuse(spare.splice(j, 1)[0], group, target);
  }
  for (const layer of spare) destroyLayer(layer);
  target.layers = layers.filter((layer) => layer !== undefined);
  reserve(
    groups.reduce(
      (bytes, group, i) => (layers[i] ? bytes : bytes + layerBytes(target, group.kind)),
      0,
    ),
  );
  const made: Layer[] = [];
  try {
    target.layers = groups.map((group, i) => {
      const kept = layers[i];
      if (kept) return kept;
      const layer = createLayer(gpu, target, group);
      made.push(layer);
      return layer;
    });
  } catch (error) {
    for (const layer of made) destroyLayer(layer);
    throw error;
  }
  return target.layers;
}
/**
 * Whether values stored against `stored` no longer resolve a colormap step of `domain`. Float16
 * keeps 11 bits, so a value `reach` from the stored start is off by `reach / 2048`, against a step
 * of a 256th of the domain; and stored values stay below Float16's largest, 65504.
 */
function drifted(stored: Domain, domain: Domain | null): boolean {
  if (!domain || !(domain[1] > domain[0])) return false;
  const span = stored[1] - stored[0],
    reach = Math.max(span, Math.abs(domain[0] - stored[0]), Math.abs(domain[1] - stored[0]));
  return reach > (domain[1] - domain[0]) * 8 || reach > span * 60000;
}
/** What a value layer stores against: its look's domain, or the image's values without one. */
function storage(look: Look, target: Transform): Domain {
  const domain = domainOf(look, target);
  return domain && domain[1] > domain[0] ? domain : target.values;
}
/** A spare layer's textures, starting over for another group. */
function reuse(layer: Layer, group: Group, target: Transform): Layer {
  return {
    ...layer,
    key: group.key,
    stored: storage(group.look, target),
    progress: new Map(),
    fresh: true,
    look: group.look,
  };
}
function createLayer(gpu: Gpu, target: Transform, group: Group): Layer {
  const size = [target.width, target.height],
    format = LAYER_FORMATS[group.kind];
  const texture = gpu.texture({
    size,
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  try {
    return {
      key: group.key,
      kind: group.kind,
      stored: storage(group.look, target),
      texture,
      msaa:
        target.msaa === 4
          ? gpu.texture({ size, format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT })
          : undefined,
      progress: new Map(),
      fresh: true,
      look: group.look,
    };
  } catch (error) {
    texture.destroy();
    throw error;
  }
}
export function destroyLayer(value?: Layer): void {
  value?.texture.destroy();
  value?.msaa?.destroy();
}
export function destroyImage(value?: Image): void {
  if (!value) return;
  for (const layer of value.layers) destroyLayer(layer);
  value.layers = [];
}
/** One layer's GPU memory, with four samples a pixel more under MSAA. */
export function layerBytes(
  target: Pick<Transform, 'width' | 'height' | 'msaa'>,
  kind: LayerKind,
): number {
  return target.width * target.height * TEXEL_BYTES[kind] * (target.msaa === 4 ? 5 : 1);
}
export function imageBytes(value: Image): number {
  return value.layers.reduce((bytes, layer) => bytes + layerBytes(value, layer.kind), 0);
}
/** Hold a layer's textures until this frame's GPU work completes. */
export function enroll(frame: kit.Preparation, value: Layer): void {
  frame.texture(value.texture);
  if (value.msaa) frame.texture(value.msaa);
}
