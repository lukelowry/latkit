# Create a block diagram

This tutorial creates a WebGPU block diagram, loads a netlist, binds live values to its wires, and turns the user's edits into a new netlist.

## Create a canvas

The application owns the canvas. Give it a stable display size before attaching the controller:

```html
<canvas id="diagram" style="display: block; width: 100%; height: 480px"></canvas>
```

## Build a netlist

A `Netlist` from `@latkit/model` is a block diagram's structure as columns: blocks, the ports each block owns, and the nets that join ports. `portStart` has one offset per block plus a terminal one, so block `b` owns ports `portStart[b]` up to `portStart[b + 1]`. `portFlow` marks each port `0` in, `1` out, or `2` both. `netStart` offsets into `netPorts` the same way, one net after another. A net has at most one `out` port, its driver.

This netlist is one generator unit: TGOV1 drives GENROU's `pmech`, IEEET1 drives its `efd`, and GENROU's `speed` feeds both back.

```ts
import { colormap } from '@latkit/colormaps';
import { createDiagram } from '@latkit/diagram';
import type { Netlist } from '@latkit/model';

const canvas = document.getElementById('diagram');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #diagram canvas.');
}

const unit: Netlist = {
  blockCount: 3,
  blockKey: ['Genrou/1_1_genrou', 'Tgov1/1_1_tgov1', 'Ieeet1/1_1_ieeet1'],
  blockTitle: ['GENROU', 'TGOV1', 'IEEET1'],
  portStart: Uint32Array.of(0, 3, 5, 7),
  portFlow: Uint8Array.of(0, 0, 1, /* tgov1 */ 0, 1, /* ieeet1 */ 0, 1),
  portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed', 'efd'],
  netStart: Uint32Array.of(0, 2, 4, 7),
  netPorts: Uint32Array.of(4, 0, /* efd */ 6, 1, /* speed */ 2, 3, 5),
  netLabel: ['1_1_pmech', '1_1_efd', '1_1_speed'],
};

const diagram = createDiagram({ interaction: 'edit', colormap: colormap('coolwarm') });
diagram.load(unit);
await diagram.attach(canvas);
```

`createDiagram()` takes neither a device nor a canvas; `attach()` leases a device from the shared pool and paints what the controller holds. See [Lifecycle and failures](lifecycle.md).

`load` validates the netlist with `validateNetlist` and throws an `Error` naming the first invalid field before changing anything. It lays the blocks out along their signal flow: TGOV1 and IEEET1 sit left of GENROU, and the `speed` wire returns underneath. Every size derives from the `gridPitch` option, `8` diagram units by default, and each block grows until its title and port labels never collide. Loading the netlist already loaded, or one with the same content, is a no-op, and `load(netlist, { fit: false })` keeps a placed camera.

Optional columns add the rest: `portSide` puts a port on a block's left, right, top, or bottom; `portKind` sets which ports may share a net; `netStyle` `1` draws a net as a tag at each port, for a bus too wide to wire; `blockGroup` and `groupCount` frame a plant and arrange it as one; `blockLabel`, `netLabel`, and `groupLabel` add text.

## Bind live values

Channels carry one value per block, port, or net. `netColor` normalizes through a domain onto the colormap, and `netFlow` marches dashes along a wire from its driver, faster for larger values and backward for negative ones:

```ts
const deviation = Float32Array.of(0.2, -0.4, 0.05); // pmech, efd, speed
diagram.setChannel('netColor', deviation, [-1, 1]);
diagram.setChannel('netFlow', Float32Array.of(1, 1, 1));

diagram.setChannel('blockStatus', Float32Array.of(0, 0, 2)); // IEEET1 in error red
diagram.setChannel('netFlow', null);
```

Each call replaces what was bound, so a playback loop writes a new array per frame. `blockColor` works like `netColor` for blocks; `blockVisible` and `netVisible` hide an item at `0`; `blockStatus` and `portStatus` ring an item in a status color. Every channel but `blockPosition` clears when a new netlist loads.

`blockPosition` places blocks: `x, y` top-left corners in diagram units, which are CSS pixels at zoom 1. A NaN pair hands a block back to its automatic position. Placements follow their blocks' keys through a load, so an edited netlist keeps every surviving block where it was placed:

```ts
diagram.setChannel('blockPosition', Float32Array.of(NaN, NaN, 0, 0, 0, 160));
```

## Handle interaction

Every event carries one payload. With `interaction: 'edit'`, a user can draw wires, move blocks, and delete a selection, and each arrives as a proposal:

```ts
diagram.on('hover', (part) => console.log(part?.kind, part?.index));
diagram.on('select', (parts) => console.log('selected', parts));
diagram.on('connect', ({ from, to, replaces }) => console.log(from, to, replaces));
diagram.on('move', ({ blocks, positions }) => console.log(blocks, positions));
diagram.on('delete', (parts) => console.log('delete', parts));
```

A `Part` is `{ kind, index }` with `kind` one of `'block'`, `'port'`, `'net'`, or `'group'`. `connect` names ports by index: `from` is the wire's fixed end, `to` is the port or net it ended on (`null` over empty canvas), and `replaces` is the port whose wire the user picked up, or `null` for a new wire. `move` lists the blocks and the top-left corners they came to rest at, already shown there: each block's corner before the move plus the move's offset, which is snapped to the grid when `snap` is on. `'navigate'` moves only the camera, `'inspect'` keeps hover, taps, and keyboard selection while the page keeps its scrolling, and `'none'` installs no listeners.

## Apply proposals

The diagram never edits its netlist. A host decides what to accept, builds the next netlist, and loads it. Pass `fit: false` so the camera stays where the user left it. A load keeps the placement of every block whose key survives, but a block the host inserts or restores arrives without one, so the host keeps its placements by `blockKey` and writes them after each load; a block whose pair did not change does not move:

```ts
const placed = new Map<string, readonly [number, number]>();

function show(netlist: Netlist): void {
  diagram.load(netlist, { fit: false });
  const positions = new Float32Array(2 * netlist.blockCount).fill(Number.NaN);
  netlist.blockKey?.forEach((key, b) => positions.set(placed.get(key) ?? [NaN, NaN], 2 * b));
  diagram.setChannel('blockPosition', positions);
}

diagram.on('move', ({ blocks, positions }) => {
  blocks.forEach((b, i) => placed.set(doc.keyOf(b), [positions[2 * i]!, positions[2 * i + 1]!]));
});

diagram.on('connect', (wire) => {
  if (wire.to !== null && doc.connect(wire)) show(doc.netlist());
});
```

`doc` stands for the host's own document: `connect` adds the wire to its model when it accepts it, and `netlist()` builds the `Netlist` to show. Surviving blocks keep their place and selection across the load, new blocks land beside what they connect to, and removed blocks fade out. Give each block a key that means the same block in every netlist the host shows; a host that switches to an unrelated diagram gives it keys of its own, so nothing carries over and the new diagram is arranged whole. A palette drop inserts a block at `diagram.toDiagram(event.clientX, event.clientY)`, the snapped diagram point under the pointer. Undo is the host's: it restores a move by writing the old corner or NaN, and a structural edit by loading the previous netlist.

## Arrange without a device

`@latkit/diagram/layout` exports `arrange`, the same pure, deterministic layout the diagram shows, so a worker can compute positions before any canvas exists:

```ts
import { arrange } from '@latkit/diagram/layout';

const positions = arrange(unit, { gridPitch: 8 }); // two floats per block: its top-left corner
```

On the controller, `diagram.arrange()` recomputes the automatic layout and returns the same kind of array; `diagram.arrange(parts)` re-arranges only the units those parts belong to, each where it stands. It never changes placements: write NaN into `blockPosition` for a block that should take the fresh layout.

## Frame parts

`fit()` frames everything and defines the fit view the `fit` event reports on. `fit(parts)` and `reveal(part, { neighbors: true })` frame a few parts without redefining it, so `fit` stays false afterwards and a resize keeps the pose:

```ts
const genrou = { kind: 'block', index: 0 } as const;
diagram.fit(diagram.neighborhood(genrou), true);
diagram.fit(true); // back to the fit view
```

## Clean up

When your app removes the view, destroy the controller before removing its canvas. `destroy()` forgets the netlist, channels, selection, and glyph atlas and gives back their memory:

```ts
diagram.destroy();
canvas.remove();
```

## Run the full example

The repository example hosts the diagram over an in-memory document with undo and redo, from one generator unit up to about 36,000 blocks:

```sh
pnpm --filter @latkit/diagram-example dev
```

Open `http://127.0.0.1:5194`.

The `@latkit/diagram` README lists every channel, option, and event, and the [API reference](api/index.md) documents each method.
