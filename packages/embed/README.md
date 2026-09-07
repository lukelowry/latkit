# @latkit/embed

`latkit-network` and `latkit-monitor`: the declarative form of
[`@latkit/network`](https://www.npmjs.com/package/@latkit/network) and
[`@latkit/monitor`](https://www.npmjs.com/package/@latkit/monitor). Each element is a canvas that
fills its box, a data source, an attribute for every option, and the controller itself at
`element.network` or `element.monitor`. There is no built-in chrome: the page owns every control.

## Register the elements

The package root is side-effect free. Import the registration entry when automatic registration
is appropriate:

```html
<latkit-network src="network.json" colormap="viridis" vertex-color="voltage" borders>
  <img src="network.png" alt="Static network diagram" />
</latkit-network>

<script type="module">
  import '@latkit/embed/register';
</script>
```

Applications that prefer explicit setup call `register()` from the Node-safe root:

```ts
import { register } from '@latkit/embed';

register();
```

`register()` is idempotent and defines both tags in the current browser realm. The minified
`dist/embed.js` bundles every Latkit dependency and registers on evaluation:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@latkit/embed/dist/embed.js"></script>
```

When self-hosting, keep the published `assets/` directory beside `embed.js` so the packaged
border geometry resolves relative to the module.

## The shell

Every element renders a shadow `<canvas part="canvas">` positioned to fill the host and a
`<slot>` for fallback content. The host is `display: block`; give it a size. Light-DOM children
stay visible until a canvas is bound and hide while one is.

Three attributes report state and are written by the element: `state` is `idle`, `loading`,
`ready`, or `error` for the data source, `attached` is present while a WebGPU canvas is bound,
and `painted` once that canvas has shown a frame. Style on any of them:

```css
latkit-network {
  block-size: 480px;
}
latkit-network[state='error'] {
  outline: 1px solid firebrick;
}
latkit-network:not([painted]) + .poster {
  opacity: 1;
}
```

Elements activate lazily: the data source is resolved and the canvas bound when the element first
comes within 200px of the viewport, painting pauses while it is away, and the controller detaches
on disconnect and reattaches on reconnect with every state retained. An `aria-label` on the host
is mirrored onto the canvas.

## Data sources

Both elements resolve one source, in this order: a non-null `data` property, the `src` attribute
(fetched as JSON relative to the document), then one direct `<script type="application/json">`
child. Changing `src` or `data` loads the new source into the same controller.

`ready` settles with the latest source: it resolves once the data is loaded into the controller
and rejects when the source failed. A `load` event follows success; an `error` event carries
`{ error }` for a failed source or a canvas that could not be bound.

Numeric JSON slots are number arrays (`null` for NaN) or `{ "base64": "..." }` little-endian
bytes. `parseNetwork` and `parseSeries` decode the same shapes for hosts that fetch themselves.

### `latkit-network`

```json
{
  "topology": {
    "vertexCount": 2,
    "vertexCoords": [-96, 30, -95, 31],
    "coordinateSpace": "geographic",
    "edges": [0, 1]
  },
  "fields": [
    { "id": "voltage", "scope": "vertex", "values": [0.98, 1.02] },
    { "id": "ring", "scope": "vertex", "components": 2, "values": [0, 1, 1, 0] }
  ]
}
```

`polylineStart` defaults to straight edges. `fields` are static values over vertices or edges,
one per item or, with `components: 2`, an interleaved pair; channel attributes bind them by id
and shape. The `data` property takes the decoded `NetworkData` shape (`Float32Array` and
`Uint32Array` values, `components` always present).

### `latkit-monitor`

```json
{ "time": [0, 1, 2], "values": [1, 2, 3, 4, 5, 6], "signalCount": 1, "elementCount": 2 }
```

The shape is `@latkit/model`'s `Series`, encoded: `time` decodes to f64, `values` and the
optional `ranges` to f32, and `validFrames` commits a frontier. The `data` property takes a
`Series` directly.

## Attributes

Every live option of the underlying controller is an attribute under its kebab-case name, parsed
by the option's own kind from `OPTIONS`: booleans take shorthand, `"true"`, or `"false"`; numbers
are decimals; RGBA and domain values are space-separated numbers; enumerations take their token.
Removing an attribute restores the option's default. An invalid value warns and uses the default.

`colormap` names a `@latkit/colormaps` preset on both elements.

`latkit-network` adds:

- `msaa`, read once when the controller is created (before the element connects);
- one attribute per channel, `vertex-color`, `vertex-height`, `vertex-size`, `vertex-visible`,
  `vertex-shade`, `vertex-position`, `edge-color`, `edge-dash`, `edge-visible`, and `edge-shade`,
  naming a field id of the matching scope and shape; an empty value unbinds (`vertex-position`
  takes a pair field, and an empty value restores the topology's own layout);
- `vertex-color-domain`, `vertex-height-domain`, `vertex-size-domain`, and `edge-color-domain`
  as `"min max"` for the normalized channels;
- `projection`, applied with fallback after every load;
- `borders`, which also loads the packaged Natural Earth geometry when the topology is
  geographic.

`latkit-monitor` adds `signal`, the displayed signal index.

```html
<latkit-network
  src="network.json"
  projection="tilt"
  colormap="coolwarm"
  vertex-color="voltage"
  vertex-color-domain="0.95 1.05"
  vertex-height="generation"
  height-range="0 1"
  edge-color="flow"
  edge-dash="violated"
  keyboard
  wheel="modifier"
  interaction="inspect"
  fit-padding-px="96 32 160 32"
  fit-pitch="50"
  borders
></latkit-network>

<latkit-monitor src="series.json" signal="1" value-range="0 1" line-width-px="2"></latkit-monitor>
```

## The controller

Everything imperative is the controller, unchanged:

```ts
import type { NetworkElement } from '@latkit/embed';
import { spotlight } from '@latkit/network/shades';

const element = document.querySelector<NetworkElement>('latkit-network')!;
await element.ready;

element.network.setProjection('globe', true);
element.network.select({ kind: 'vertex', index: 1 });
element.network.reveal({ kind: 'vertex', index: 1 }, { neighbors: true, animate: true });
element.network.on('contextmenu', ({ clientX, clientY, items }) =>
  openMenu(clientX, clientY, items),
);
await element.network.setShade(spotlight({ radiusPx: 220 }));
```

Controller events also arrive as bubbling, composed DOM events of the same name with the payload
as `detail`. A device loss the controller cannot recover from puts the element in the `error`
state.

Attributes and the controller compose: an attribute writes only the option or channel it names,
when it changes and after every load, so imperative calls on untouched options stand.

## Published border assets

The Natural Earth border binaries are `@latkit/network`'s. The standalone bundle resolves them
beside itself, so the same files also ship under stable embed subpaths:

```text
@latkit/embed/assets/ne-50m-line-borders.vertices.bin
@latkit/embed/assets/ne-50m-line-borders.indices.bin
```
