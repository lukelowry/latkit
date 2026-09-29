import type { GlyphAtlas } from './atlas.js';

/** One device's independently synchronized glyph texture. */
export interface GlyphTexture {
  readonly view: GPUTextureView;
  /** Upload changed rows. Returns true if the view changed. */
  sync(atlas: GlyphAtlas): boolean;
  destroy(): void;
}

/** A bounded r8 texture; revisions belong to this consumer, never to the atlas globally. */
export function createGlyphTexture(device: GPUDevice, label = 'glyph-atlas'): GlyphTexture {
  let texture: GPUTexture | null = null,
    view: GPUTextureView | null = null;
  let source: GlyphAtlas | null = null,
    revision = -1,
    version = -1;
  return {
    get view() {
      if (!view) throw new Error('Glyph texture has not been synchronized');
      return view;
    },
    sync(atlas) {
      if (source === atlas && revision === atlas.revision) return false;
      const replaced = source !== atlas || version !== atlas.version || !texture;
      if (replaced) {
        if (Math.max(atlas.width, atlas.height) > device.limits.maxTextureDimension2D)
          throw new RangeError('Glyph atlas exceeds device texture limits');
        const next = device.createTexture({
          label,
          size: [atlas.width, atlas.height],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        texture?.destroy();
        texture = next;
        view = next.createView();
      }
      const [from, to] = replaced ? [0, atlas.height] : atlas.changedRows(revision);
      if (to > from)
        device.queue.writeTexture(
          { texture: texture!, origin: [0, from] },
          atlas.pixels,
          { offset: from * atlas.width, bytesPerRow: atlas.width, rowsPerImage: to - from },
          [atlas.width, to - from],
        );
      source = atlas;
      revision = atlas.revision;
      version = atlas.version;
      return replaced;
    },
    destroy() {
      texture?.destroy();
      texture = null;
      view = null;
      source = null;
      revision = version = -1;
    },
  };
}
