# Create a network view

The network renderer borrows native model `Queryable` sources and a shared `Gpu`. Applications own acquisitions, canvases, and the GPU lifetime.

Give the canvas a stable display size:

```html
<canvas id="network" tabindex="0" style="display:block;width:100%;height:480px"></canvas>
```

Given an acquired document with the declared types and fields:

```ts
import { createGpu, createCanvasView, colormaps } from '@latkit/gpu';
import { createNetwork, attachNetworkInput } from '@latkit/network';

const gpu = await createGpu();
const network = createNetwork({
  gpu,
  data: {
    source: document,
    coordinates: 'geographic',
    vertices: {
      node: {
        position: 'coordinates',
        color: { field: 'temperature', domain: [250, 350], colormap: colormaps.thermal },
      },
    },
    edges: {
      connection: { connectivity: { kind: 'endpoints', layout: 'pair' }, curve: 'geodesic' },
    },
  },
  options: { hover: 'auto', hoverBudgetMs: 2, poles: false },
});
const canvas = window.document.querySelector<HTMLCanvasElement>('#network')!;
const view = createCanvasView({ gpu, canvas, renderer: network, onError: console.error });
const detach = attachNetworkInput({ network, canvas });
view.request();
```

`position` accepts a native vector field or separate scalar coordinate bindings. `color` uses the same field and domain contract as other numeric scales. Palette values come from `@latkit/gpu`; see [colors and colormaps](colormaps.md) for authoring and CSS legends.

```ts
import { reverseColormap, colormapCss } from '@latkit/gpu';

const colors = reverseColormap(colormaps.thermal);
network.setVertex('node', {
  color: { field: 'temperature', domain: [250, 350], colormap: colors },
});
legend.style.backgroundImage = colormapCss(colors, { direction: 'to right' });
network.setCamera({ projection: 'globe' });
network.on('select', (item) => console.log(item?.index.type, item?.row));
```

Palette resources use GPU's shared cache. Changing the palette does not change native model columns or connectivity. Sources, index identities, and native row numbers remain authoritative for picking.

When closing the view:

```ts
detach();
view.destroy();
network.destroy();
gpu.destroy(); // after all other views borrowing this GPU are also closed
```

The application separately releases its document and recording acquisitions. See the [network package README](../packages/network/README.md) for paths, geodesics, labels, domains, and interaction. The complete standalone example lives in `examples/network`; run `pnpm --filter @latkit/network-example dev` and open `http://127.0.0.1:5188/`. Its `/colors.html` gallery compares CPU, CSS, and WebGPU sampling.
