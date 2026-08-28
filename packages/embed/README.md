# @latkit/embed

`@latkit/embed` provides `latkit-network`, the declarative, self-owning form of
[`@latkit/network`](https://www.npmjs.com/package/@latkit/network). It retains the complete Network
view vocabulary while owning the canvas, shared WebGPU device, lazy activation, recovery, controls,
and accessible fallback behavior.

## Register the element

The package root is side-effect free. Import the registration entry when automatic registration is
appropriate:

```html
<latkit-network src="network.json" border-source="natural-earth">
  <img src="network.png" alt="Static network diagram" />
</latkit-network>

<script type="module">
  import '@latkit/embed/register';
</script>
```

Applications that prefer explicit setup can use the Node-safe root entry:

```ts
import { register, type NetworkElement } from '@latkit/embed';

register();

const element = document.querySelector<NetworkElement>('latkit-network')!;
await element.ready;
element.fit(true);
```

`register()` is idempotent and creates the implementation class in the current browser realm. The
root import does not register an element or evaluate a class that extends `HTMLElement`.

## Standalone browser build

The minified `dist/embed.js` artifact bundles Latkit's runtime dependencies and registers the element
when evaluated. It can be loaded without a package manager or bundler:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@latkit/embed/dist/embed.js"></script>
```

Package-aware tools can address the same side-effect entry as `@latkit/embed/embed.js`.

When self-hosting, keep the published `assets/` directory beside `embed.js` so packaged border URLs
continue to resolve relative to the module.

## Data sources

Every source uses one static, unversioned `NetworkData` shape. Effective source precedence is:

1. a non-null `data` property;
2. the `src` attribute;
3. one direct `<script type="application/json">` child.

```html
<latkit-network vertex-color="voltage">
  <script type="application/json">
    {
      "topology": {
        "vertexCount": 2,
        "vertexCoords": [-96, 30, -95, 31],
        "edges": [0, 1]
      },
      "labels": { "vertex": ["West", "East"], "edge": ["Tie line"] },
      "fields": [
        {
          "id": "voltage",
          "label": "Voltage",
          "unit": "pu",
          "scope": "vertex",
          "values": [0.98, 1.02]
        }
      ]
    }
  </script>
  <p>Interactive rendering requires a browser with WebGPU support.</p>
</latkit-network>
```

`parseNetwork(input)` validates JSON-compatible input and returns newly owned typed arrays. Numeric
arrays can be ordinary JSON arrays or little-endian base64 objects. Assign decoded data directly
through `element.data` when the host already owns `NetworkData`.

## View attributes

Network option names are converted from camelCase to kebab-case only at the HTML boundary. Boolean
options accept shorthand, `"true"`, or `"false"`; removing an option attribute restores Network's
canonical default.

```html
<latkit-network
  src="network.json"
  controls="caption projection navigation colormap channels legends"
  projection="tilt"
  colormap="coolwarm"
  vertex-color="voltage"
  vertex-color-domain="0.95 1.05"
  vertex-height="generation"
  vertex-height-domain="0 1000"
  vertex-height-range="0 1"
  vertex-size="capacity"
  edge-color="flow"
  edge-color-domain="-500 500"
  edge-dash="violated"
  poles
  graticule
  daylight
  borders
  border-source="natural-earth"
></latkit-network>
```

All seven Network channels are independently bindable:

- `vertex-color`, `vertex-height`, `vertex-size`, and `vertex-visible` accept vertex field ids;
- `edge-color`, `edge-dash`, and `edge-visible` accept edge field ids;
- normalized channels have matching `*-domain` overrides;
- `vertex-height-range` controls the independent height output range;
- visibility channels show values greater than zero and have no domain attribute;
- an empty channel attribute explicitly unbinds that channel.

The matching programmatic methods preserve Network's raw-channel semantics: `setChannel` ignores domain and output-range arguments for `edgeDash`, `vertexVisible`, and `edgeVisible`, while `setChannelRange` is a no-op for those channels.

Every serializable Network option is available under its exact kebab-case name. `msaa` is the only
construction option, so changing it replaces the live activation against cached data. Other options,
bindings, projection, colormap, borders, and controls update without recreating the renderer.

The live geometry options are `vertex-scale`, `edge-scale`, `height-scale`, `vertex-lod-px`, and
`dash-period-px`. The first three multiply the topology-derived vertex radius, edge half-width, and
height displacement. `vertex-lod-px` culls vertices below a CSS-pixel radius, while
`dash-period-px` sets the screen-space period used by `edge-dash`; `0` disables dash gaps. Their
defaults are `1`, `1`, `1`, `2`, and `12`. All accept non-negative numbers.

`border-source="natural-earth"` selects the packaged geometry. The independent `borders` Network
option controls whether border rendering and packaged loading are enabled. `border-source="none"`
disables the packaged source.

## Built-in controls

Absent, empty, or `controls="auto"` enables every meaningful control. `controls="none"` hides only
the built-in chrome; pointer and keyboard renderer interaction remain active. An explicit token list
enables only the requested features.

Available feature tokens are `caption`, `projection`, `fit`, `zoom`, `colormap`, each canonical
channel name, and the color-bar legend names `vertex-color-legend` and `edge-color-legend`. The group
tokens `navigation`, `channels`, and `legends` expand to their corresponding features. At most one
color bar is ever shown: when both color legends apply, the vertex color bar wins and the edge color
bar appears only while vertex color is unbound.

Persistent chrome stays minimal: a status caption, a compact toolbar, and the color bar. The colormap
and channel pickers live in a collapsible Display panel behind an `aria-expanded` toolbar toggle. In
automatic mode the panel starts collapsed; an explicit control list that requests encodings starts
open. The user's own toggle choice wins afterwards, and Escape inside the panel closes it and returns
focus to the toggle.

The element exposes stable shadow parts for the stage, canvas, fallback, chrome, caption, toolbar,
projection, navigation, inspector, inspector-toggle, colormap, channels, legends, live region,
individual channel controls, and the color-bar legends.

Chrome layout responds to the element's own inline size through container queries, so it also adapts
inside sidebars and split panes where viewport media queries would not. The center of the renderer
stays clear: caption and toolbar occupy the top rail, the color bar pins to the bottom start corner,
and the Display panel opens beside the stage on roomy containers or as a bottom sheet on narrow ones.
Panels size to their content and scroll internally, so no host size can push controls out of reach.

The default chrome follows the document's `color-scheme`. Hosts can theme the complete surface with
custom properties while retaining built-in hover, focus, disabled, reduced-motion,
reduced-transparency, increased-contrast, and forced-color states:

```css
latkit-network {
  --latkit-chrome-surface: rgb(10 17 26 / 84%);
  --latkit-chrome-surface-strong: rgb(10 17 26 / 95%);
  --latkit-chrome-control: rgb(28 42 57 / 90%);
  --latkit-chrome-control-hover: #263a52;
  --latkit-chrome-text: #f2f6fa;
  --latkit-chrome-muted: #9fadc0;
  --latkit-chrome-border: #405166;
  --latkit-chrome-accent: #7cb8ff;
  --latkit-chrome-focus: #fff;
  --latkit-chrome-radius: 2px;
  --latkit-chrome-shadow: 0 1px 3px rgb(0 0 0 / 28%);
  --latkit-chrome-font: inherit;
  --latkit-chrome-font-mono: inherit;
}
```

## JavaScript API

Configuration methods retain state across reconnect and device recovery and use the same names and
arguments as Network:

```ts
import { colormap } from '@latkit/colormaps';
import { register, type NetworkElement } from '@latkit/embed';

register();

const element = document.querySelector<NetworkElement>('latkit-network')!;

element.setOptions({
  vertices: true,
  edges: true,
  graticule: true,
  baseColor: [0.36, 0.4, 0.46, 1],
});
element.setChannel('vertexColor', new Float32Array([0.98, 1.02]), [0.95, 1.05]);
element.setChannelRange('vertexColor', [0.97, 1.03]);
element.setColormap(colormap('plasma'));

await element.ready;
element.setProjection('globe');
element.fit(true);
element.select('vertex', 1);
```

The complete element method surface is `setOptions`, `setBorders`, `setColormap`, `setBaseColor`,
`setChannel`, `clearChannel`, `setChannelRange`, `setProjection`, `fit`, `reveal`, `select`,
`clearSelection`, `panBy`, `rotateBy`, `zoomBy`, `fadeIn`, `pause`, and `resume`. `projections`
reports the current topology's mode availability. The underlying Network, canvas ownership, and GPU
device remain private.

Renderer notifications become bubbling, composed DOM events named `load`, `error`, `hover`, `select`,
`zoom`, `deviceLost`, and `pipelineError`. `ready` always describes the current activation and is
replaced for source changes, reconnect, `msaa` changes, and device recovery.

The canvas is focusable and named. Arrow keys pan, `+`/`=` and `-`/`_` zoom, Home fits, and Escape
clears selection. Selection changes are announced through a polite live region; hover is not.

## Published border assets

Natural Earth border binaries are also available through stable package subpaths:

```text
@latkit/embed/assets/ne-50m-line-borders.vertices.bin
@latkit/embed/assets/ne-50m-line-borders.indices.bin
```
