# Colors and colormaps

`@latkit/gpu` owns the color contract, catalog, authoring helpers, CSS legends, and GPU bindings. All imports use the package root. The former `@latkit/colormaps` package has been removed; monitor and diagram remain pending migration.

## Use a palette

```ts
import { colormaps, reverseColormap, colormapCss } from '@latkit/gpu';

network.setVertex('node', {
  color: { field: 'temperature', domain: [250, 350], colormap: colormaps.thermal },
});
legend.style.backgroundImage = colormapCss(colormaps.thermal, { direction: 'to right' });
const descending = reverseColormap(colormaps.thermal);
```

A `Colormap` is immutable presentation data: `kind`, optional `label`, and `colors`. Reuse its identity while the palette is unchanged. Factory values, reversals, and catalog values are frozen; caller-authored structural values must also remain immutable. There is no registry mutation, palette callback in the rendering loop, or per-renderer texture baker.

`RGBA` is four finite numbers in `[0, 1]`: sRGB-encoded red, green, blue, and **straight alpha**. Model values remain native model columns; colors are presentation concerns. Gamut mapping occurs only when parsing or authoring out-of-sRGB colors. This change does not introduce linear-light compositing into renderers.

## Catalog

| Family      | Palettes                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sequential  | amber, amp, batlow, cividis, crest, deep, devon, flare, grays, haline, inferno, lajolla, magma, mako, oslo, plasma, rocket, thermal, turku, viridis |
| Diverging   | balance, berlin, brbg, broc, coolwarm, cork, icefire, managua, piyg, puor, rdbu, spectral, vanimo, vik, vlag                                        |
| Cyclic      | phase, romao, twilight                                                                                                                              |
| Categorical | dark2, okabeito, paired, set2, tab10, tab20, tableau10                                                                                              |
| Multihue    | turbo                                                                                                                                               |

The 46 maps preserve published sample values from Matplotlib, ColorBrewer, Scientific Colour Maps, cmocean, Seaborn, D3, and Okabe-Ito, plus Latkit's amber and grayscale ramps. Palette families describe sampling behavior, not a universal accessibility guarantee. Choose a sequential map for magnitude, a diverging map for a meaningful center, a cyclic map for phase, and categories for nominal classes.

```ts
import { colormaps, type ColormapName } from '@latkit/gpu';

for (const name of Object.keys(colormaps) as ColormapName[]) {
  const { label, kind } = colormaps[name];
  // Build a picker without decoding any sample tables.
}
```

Sample tables decode only when `.colors` is first read. The catalog can be removed by a bundler when unused; individual properties of the catalog are not separate tree-shaking boundaries.

## Author a palette

```ts
import { createColormap, parseColor } from '@latkit/gpu';

const temperature = createColormap({
  label: 'Temperature',
  kind: 'diverging',
  interpolation: 'oklab', // default; also 'srgb' or 'srgb-linear'
  size: 256,
  stops: [
    { at: 0, color: parseColor('#2166ac')! },
    { at: 0.5, color: parseColor('#f7f7f7')! },
    { at: 1, color: parseColor('#b2182b')! },
  ],
});
const classes = createColormap({
  kind: 'categorical',
  colors: [
    [0.2, 0.4, 0.7, 1],
    [0.8, 0.3, 0.2, 1],
  ],
});
```

Explicit colors are copied once. Stop interpolation premultiplies alpha; stops must strictly increase from zero to one. Cyclic stops close at the same color; generated tables omit the duplicate endpoint. A `sample(t)` authoring callback is also accepted and evaluated only during construction. Continuous maps have 2?16,384 samples; categories have 1?16,384. GPU preparation additionally obeys the device's texture dimension limit (cyclic tables need one extra seam texel).

## CPU, CSS, and WebGPU

```ts
import { sampleColormap, colormapCss, colorCss, parseColor, resolveColor } from '@latkit/gpu';

const rgba = sampleColormap(colormaps.viridis, 0.4);
const foreground = colorCss(rgba);
const legend = colormapCss(colormaps.viridis); // vertical, bottom to top
const literal = parseColor('oklch(65% 0.15 40)'); // RGBA | null; no DOM
const contextual = resolveColor('var(--accent, currentColor)', element); // explicit DOM boundary
```

The authored `.colors` retain their original precision. Rendering uses one shared premultiplied sRGB RGBA8 table. `sampleColormap`, CSS stops, and WebGPU use this quantized table: continuous input clamps to `[0, 1]`, cyclic input wraps, and categories select equal-width hard bins. Nonfinite CPU coordinates throw. WGSL invalid coordinates and out-of-range integer categories produce transparent black. Cyclic reversal preserves the phase origin; reversing twice returns the original value.

Texture sampling uses half-texel-correct coordinates and an explicit cyclic seam. Alpha is premultiplied before filtering and returned straight. This avoids translucent color fringes; RGBA8 quantization still limits very small alpha values. GPU filtering and output conversion have normal hardware rounding differences.

```ts
import { colormapShader } from '@latkit/gpu';

const module = gpu.device.createShaderModule({
  code: colormapShader({ group: 1 }) + rendererShader,
});
const layout = gpu.device.createPipelineLayout({
  bindGroupLayouts: [viewLayout, gpu.colormapLayout],
});
// prepare(frame):
const colors = frame.colormap(colormaps.viridis);
// encode(frame):
pass.setBindGroup(1, colors);
```

WGSL exposes `colormapColor(t: f32)` for normalized values and `paletteColor(index: u32)` for exact category indices. Both return straight, sRGB-encoded RGBA. The caller applies domain normalization and any required output premultiplication. Omitted `frame.colormap()` selects grayscale.

Bindings and resources belong to the `Gpu`, share its image/buffer caches and budgets, and stay pinned until submission completes. The same palette in different views reuses the same resident texture and bind group. Evicted resources are rebuilt on demand. Renderers must acquire the binding during each frame's preparation, without retaining it beyond the frame. Palette compilation and upload happen on first use or eviction, not per vertex or every frame.

## Sources and verification

`packages/gpu/src/colors/presets/provenance.json` records pinned source URLs, input checksums, sample counts, and sample checksums. `packages/gpu/THIRD_PARTY_NOTICES.md` retains licenses and attribution. Regenerate with Python 3, then format:

```sh
python packages/gpu/scripts/generate-colormaps.py
pnpm exec prettier --write packages/gpu/src/colors/presets
```

`pnpm --filter @latkit/gpu test` checks authoring, parsing, catalog integrity, and GPU lifetime with a fake device. `pnpm --filter @latkit/gpu test:browser -- --headed` performs real compute/readback comparisons across every catalog palette, reversal, transparency, and CSS resolution. The network example's `/colors.html` shows CPU, CSS, and GPU previews together, including reversal, family filtering, and a light-background toggle.
