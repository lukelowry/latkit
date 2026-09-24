# @latkit/diagram

WebGPU block-diagram renderer and editor surface for Latkit: one controller, `Diagram`, and two
registries that name what it speaks, `CHANNELS` and `OPTIONS`. It draws a `Netlist` (blocks, the
ports each block owns, and the nets that join ports) with automatic layout, right-angle wires,
live values on blocks and wires, and in-canvas text. It reports what the user tried to change as
proposals and never edits a netlist itself.

## Install

```sh
npm install @latkit/diagram @latkit/model @latkit/colormaps
```

## Basic use

One TwoArea generator unit: TGOV1 drives `pmech`, IEEET1 drives `efd`, and GENROU's `speed` feeds
both back.

```ts
import { colormap } from '@latkit/colormaps';
import { createDiagram } from '@latkit/diagram';
import type { Netlist } from '@latkit/model';

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
diagram.load(unit); // laid out: controllers feed GENROU, the speed loop returns underneath
diagram.on('connect', ({ from, to }) => console.log(`wire from port ${from} to`, to));

const canvas = document.querySelector<HTMLCanvasElement>('#diagram')!;
await diagram.attach(canvas);

// During playback: each signal's deviation from its initial value, normalized per signal.
diagram.setChannel('netColor', deviationAt(t), [-1, 1]);
diagram.setChannel('netFlow', new Float32Array(3).fill(1));
```

The controller holds everything it is given; `attach` leases a shared device and paints it, and
`detach` keeps it for the next canvas, exactly as `@latkit/network` and `@latkit/monitor` do. See
the [lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html).

## The netlist

`Netlist` and `validateNetlist` are `@latkit/model`'s, so an engine builds a netlist without a GPU
package. It is columnar, like `Topology`. Counts are derived: the port count is
`portStart[blockCount]` and the net count is `netStart.length - 1`. `0xffffffff` marks "none"
wherever an index may be absent.

| Field        | Length           | Meaning                                                           |
| ------------ | ---------------- | ----------------------------------------------------------------- |
| `blockCount` | `1` number       | Number of blocks                                                  |
| `blockKey`   | `blockCount`     | Optional identity across loads, unique per block                  |
| `portStart`  | `blockCount + 1` | Block `b` owns ports `portStart[b]` up to `portStart[b + 1]`      |
| `portFlow`   | port count       | `0` in, `1` out, `2` both (an undirected terminal)                |
| `portKind`   | port count       | Optional compatibility class; only one kind shares a net          |
| `portSide`   | port count       | Optional `0` left, `1` right, `2` top, `3` bottom                 |
| `netStart`   | net count + 1    | Net `n` joins `netPorts[netStart[n]]` up to `netStart[n + 1]`     |
| `netPorts`   | `netStart` total | The ports of every net, net after net                             |
| `netStyle`   | net count        | Optional `0` drawn as wires, `1` as a tag at each port            |
| `blockGroup` | `blockCount`     | Optional group of each block, or `0xffffffff`                     |
| `groupCount` | `1` number       | Optional number of groups                                         |
| `*Label`     | per item         | Optional `blockTitle`, `blockLabel`, `portLabel`, `netLabel`, ... |

A net has at most one `out` port, its driver, and joins ports of one `portKind`; a port is on at
most one net. Without `portKind` every port is kind `0`. Without `portSide`, `in` ports sit on the
left, `out` ports on the right, and `both` ports on top. A net with `netStyle` `1` is drawn as a
tag at each of its ports, for a net too wide to wire, such as a bus. `blockGroup` frames blocks,
arranges them as one, and a drag on the frame moves them together. `blockTitle` is drawn inside a
block, `blockLabel` under it, `portLabel` beside its port, `netLabel` on its wire or in each tag,
and `groupLabel` in the frame's header.

`validateNetlist` checks every promise above and throws an `Error` naming the first invalid field;
`load` runs it before changing anything.

Placement is not structure. Every block has an automatic position and an optional placement, the
`blockPosition` channel, and `blockKey` carries both across loads. Reloading an edited netlist
keeps every block whose key survives where it was, placed or not, with its selection; new blocks
land beside what they connect to, and a wholly new unit keeps the six-grid-step gap a packing
keeps between units; removed blocks fade out. A netlist without keys, or one where no key
survives, is arranged whole. Loading the netlist already loaded, or one with the same content, is
a no-op.

Every size derives from the `gridPitch` option, in diagram units. Block sizes are multiples of two
grid steps and grow until no text collides: the title sits centered between the left and right
port labels, the labels of top and bottom ports take a band inside that edge, and top and bottom
ports spread wider than their usual two grid steps when their labels or tags need the room. Side
ports sit two grid steps apart. Text assumes a monospace advance of 0.6 em, so a worker computes
the same layout as the page.

## Channels

`setChannel` binds, replaces, or clears (`null`) one per-block, per-port, or per-net stream. Values
are a `Float32Array` with one value per item of the channel's scope, or two per block for
`blockPosition`. Binding before a netlist is loaded throws, and so does a wrong length; `null` is
always accepted. `load` clears every channel except `blockPosition`, whose placements follow their
blocks' keys: a surviving block keeps its pair, a new block gets NaN, and when no key survives the
channel clears too.

| Channel         | Scope | Values                                                              |
| --------------- | ----- | ------------------------------------------------------------------- |
| `blockPosition` | block | `x, y` top-left corner; a NaN pair hands a block back to its layout |
| `blockColor`    | block | Normalized through its domain onto the colormap                     |
| `blockVisible`  | block | `0` hides the block, its ports, and its labels                      |
| `blockStatus`   | block | `0` none; `k > 0` rings the block in `statusColors[k - 1]`, clamped |
| `blockShade`    | block | One scalar per block for a shade, as `Fragment.value`               |
| `portStatus`    | port  | As `blockStatus`, per port                                          |
| `netColor`      | net   | Normalized through its domain onto the colormap                     |
| `netFlow`       | net   | Signed dash speed: `0` still, negative marches toward the driver    |
| `netVisible`    | net   | `0` hides the net                                                   |
| `netShade`      | net   | One scalar per net for a shade, as `Fragment.value` on its wires    |

`blockColor` and `netColor` take an input domain and normalize `[0, 1]` without one. Without them
blocks fill with `blockBaseColor` and wires with `netBaseColor`. `setChannelDomain` moves a domain
without re-uploading values, and `getChannelDomain` reads the one in effect; the other channels
are raw and ignore a domain.

```ts
diagram.setChannel('blockColor', loading, [0, 1.2]);
diagram.setChannelDomain('blockColor', [0, 2]);
diagram.setChannel('blockStatus', Float32Array.of(0, 2, 0)); // TGOV1 in error red
diagram.setChannel('blockColor', null);
```

`blockPosition` pairs are top-left corners in diagram units, which are CSS pixels at zoom 1 with
`y` growing downward. A write takes effect at once: placed blocks move, their nets re-route, and
their group frames follow. `blockVisible` and `netVisible` re-route what they touch, and hidden
parts are never picked. Every channel slot is allocated when a netlist loads, so rebinding never
reallocates GPU storage.

## Options

`createDiagram(options)` and `setOptions(patch)` take the same record. Every option is live except
`devices`, which is read once at construction; `setOptions` ignores it. A patch is validated
completely before any of it applies, and `validateOptions` checks one before a device exists.

| Option            | Kind                                          | Default                                                      |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `devices`         | device pool                                   | the realm-wide `devices` pool from `@latkit/gpu`             |
| `interaction`     | `'edit'`, `'navigate'`, `'inspect'`, `'none'` | `'navigate'`                                                 |
| `gridPitch`       | number > 0                                    | `8`                                                          |
| `grid`            | boolean                                       | `true`                                                       |
| `snap`            | boolean                                       | `true`                                                       |
| `routing`         | `'orthogonal'`, `'straight'`                  | `'orthogonal'`                                               |
| `labels`          | boolean                                       | `true`                                                       |
| `arrows`          | boolean                                       | `true`                                                       |
| `junctions`       | boolean                                       | `true`                                                       |
| `fontFamily`      | non-empty string                              | `'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'` |
| `colormap`        | colormap function                             | a neutral gray ramp                                          |
| `flowRate`        | number >= 0                                   | `1`                                                          |
| `motion`          | `'auto'`, `'reduce'`, `'full'`                | `'auto'`                                                     |
| `animationMs`     | number >= 0                                   | `300`                                                        |
| `keyboard`        | boolean                                       | `true`                                                       |
| `wheel`           | `'zoom'`, `'modifier'`                        | `'zoom'`                                                     |
| `pickRadiusPx`    | number >= 0                                   | `8`                                                          |
| `revealPaddingPx` | number >= 0                                   | `48`                                                         |
| `fitPaddingPx`    | number or `[top, right, bottom, left]`, null  | `null`                                                       |
| `blockBaseColor`  | RGBA                                          | `[0.19, 0.2, 0.24, 1]`                                       |
| `outlineColor`    | RGBA                                          | `[0.5, 0.53, 0.6, 1]`                                        |
| `netBaseColor`    | RGBA                                          | `[0.62, 0.66, 0.72, 1]`                                      |
| `textColor`       | RGBA                                          | `[0.9, 0.91, 0.93, 1]`                                       |
| `gridColor`       | RGBA                                          | `[0.55, 0.58, 0.65, 0.35]`                                   |
| `groupColor`      | RGBA                                          | `[0.55, 0.58, 0.65, 0.08]`                                   |
| `hoverColor`      | RGBA                                          | `[0.72, 0.28, 0.18, 1]`                                      |
| `selectedColor`   | RGBA                                          | `[0.72, 0.28, 0.18, 1]`                                      |
| `portColors`      | 1 to 8 RGBA                                   | `[[0.45, 0.7, 0.95, 1], [0.93, 0.72, 0.3, 1]]`               |
| `statusColors`    | 1 to 4 RGBA                                   | `[[0.96, 0.7, 0.2, 1], [0.92, 0.3, 0.28, 1]]`                |

- `gridPitch` is the grid pitch in diagram units (CSS pixels at zoom 1, so the grid scales with
  the view) that every block size, port spacing, and text size derives from; changing it re-sizes
  and re-arranges the diagram, and placements keep their values.
- `snap` snaps drags, drops, and `toDiagram` to the grid.
- `labels` draws text; either way text fades out below a legible size.
- `colormap` is the transfer function `blockColor` and `netColor` map onto.
- `flowRate` multiplies the speed of dashes marching along `netFlow` nets.
- `motion: 'auto'` follows `prefers-reduced-motion`. Under reduced motion, camera moves and
  arrangements land at once, dashes stand still as chevrons, and removed blocks vanish without a
  fade.
- `animationMs` is the duration of eased camera moves, arrangements, and fades.
- `wheel: 'zoom'` zooms with a notched wheel or a pinch and pans with a trackpad scroll;
  `'modifier'` zooms only with Ctrl or Meta held and leaves plain scrolling to the page.
- `pickRadiusPx` is the radius hover, taps, and `hitTest` pick within; touch uses at least 22.
- `revealPaddingPx` is the inset a part must clear before `reveal` leaves it in place.
- `fitPaddingPx` is the inset every fit keeps clear; `null` keeps the default margin, where the
  content fills 90% of the viewport.
- `portColors` colors ports by `portKind`, cycling: signal blue, then bus amber.
- `statusColors` are warning amber, then error red.

The canvas is cleared to transparent, so the page behind it is the backdrop; a theme sets the
colors above to match it.

## Interaction

`interaction` says what input does:

- `'edit'`: drag from a port to draw a wire, or from an `in` port that is already wired to pick up
  its wire; drag a block to move the selection, or a group frame to move its members; drag on a
  net or empty canvas for a marquee (Shift adds to the selection). The middle button, a drag with
  Space held, and touch on empty canvas pan. Arrow keys nudge the selected blocks by one grid step
  (four with Shift), and Delete or Backspace proposes deleting the selection.
- `'navigate'`: drags pan and Shift plus a mouse drag draws a marquee; nothing is drawn, moved, or
  deleted.
- `'inspect'`: the camera never moves, and wheel and touch scrolling stay the page's. Hover, taps,
  double taps, and the keyboard remain, and arrow keys step the selection to the connected block (one
  on a net of the selected block) lying most in that direction, or with nothing selected to the
  block nearest the view's center.
- `'none'`: no listeners at all.

A tap selects the part under the pointer; Shift, Ctrl, or Meta toggles it; tapping the same spot
again cycles through the parts stacked there; a tap on empty canvas clears. A double tap selects
the top part and opens it (a modifier on either click leaves the selection alone), or fits on
empty canvas outside `'inspect'`. While a drag nears an edge of the canvas, the view pans toward it,
except under reduced motion.

With `keyboard` on, the canvas becomes focusable and takes: arrows (nudge, step, or pan by 48 CSS
pixels), `+` and `-` (zoom), Home (fit), Tab and Shift+Tab (the next or previous block in reading
order, leaving the canvas at the ends), Enter (open), Escape (cancel a drag, else clear the
selection), and Delete or Backspace. Keys with Ctrl, Meta, or Alt belong to the host, so copy,
paste, and undo are the host's to bind.

A canvas that receives no pointer events itself reports the pointer with `setPointer`:

```ts
document.addEventListener('pointermove', (e) => diagram.setPointer(e.clientX, e.clientY));
document.addEventListener('pointerleave', () => diagram.setPointer(null));
```

## Selection and navigation

A `Part` is `{ kind, index }` with `kind` one of `'block'`, `'port'`, `'net'`, or `'group'`.
`select` replaces the selection without emitting; `reveal` brings a part into view without
changing zoom, and with `neighbors` frames it with what touches it (a part that touches nothing is
revealed as without it); `fit(parts)` frames some parts.
Neither redefines the fit view: `fit` reports false once the camera lands there, and a resize
keeps the pose.

```ts
const genrou = { kind: 'block', index: 0 } as const;

diagram.select([genrou]);
diagram.reveal(genrou, { animate: true });
diagram.fit(diagram.neighborhood(genrou), true);
diagram.select([]);
```

- `hitTest(clientX, clientY, radiusPx?)` returns the parts under a client point, at most one of
  each kind, in priority order port, block, net, group.
- `locate(part)` returns a part's anchor in client coordinates: a block's center, a port's
  position, a net's label anchor (its driver port while it draws no wires), a group header's
  center. A hidden block or port still locates; a group whose members are all hidden does not.
- `neighborhood(part)` lists a part first, then what touches it: a block's nets and the other
  blocks on them, a port's block, net, and fellow ports, a net's ports and their blocks, a group's
  blocks.
- `toDiagram(clientX, clientY)` returns the diagram point under a client point, snapped when
  `snap` is on: where a palette drop lands.
- `getPose()` and `setPose(pose, animate)` read and write `{ centerX, centerY, zoom }`, where zoom
  is CSS pixels per diagram unit, clamped from the smaller of a quarter of the fit zoom and 0.25
  up to 8. `getPose()` is null before a load.
- `panBy(dx, dy)` drags the content by CSS pixels and `zoomBy(factor)` zooms about the center.

While the camera is at its fit view, a resize keeps it fitted. An empty netlist is a diagram too:
the camera keeps its pose, or starts at the origin at actual size, so `toDiagram` places a first
block.

## Events

Every event carries one payload:

```ts
diagram.on('hover', (part) => status.show(part));
diagram.on('select', (parts) => inspector.show(parts));
diagram.on('contextmenu', ({ clientX, clientY, parts }) => menu.open(clientX, clientY, parts));
diagram.on('open', (part) => inspector.focus(part));
diagram.on('connect', (wire) => host.connect(wire));
diagram.on('move', ({ blocks, positions }) => host.place(blocks, positions));
diagram.on('delete', (parts) => host.remove(parts));
diagram.on('fit', (atFitView) => (button.disabled = atFitView));
diagram.on('attached', (attached) => (canvas.hidden = !attached));
diagram.on('painted', (painted) => (poster.hidden = painted));
diagram.on('deviceLost', ({ message, recovering }) => !recovering && showFallback(message));
diagram.on('pipelineError', ({ cause }) => console.error(cause));
```

User gestures produce `select`, `contextmenu`, `open`, `connect`, `move`, and `delete`;
programmatic calls never emit them. `hover` follows whatever lies under the pointer after any
change, a call's as much as a gesture's (a pan, a fit, a load, a placement, or a visibility write),
and `pause` clears it at once. `fit` reports every transition to or from the fit view, whatever
moved the camera. Handlers never run inside a frame: `painted`, `fit`, and the hover a frame
resolves arrive in a microtask after it submits. `contextmenu` carries the parts under the pointer,
or, from the Menu key or Shift+F10, the selection anchored at its first part; the selection does
not change.

## Editing proposals

The diagram never edits its netlist. With `interaction: 'edit'`, what the user does arrives as a
proposal, and nothing changes structurally until the host loads a netlist that has it:

- `connect` is a wire the user drew. `from` is the port at its fixed end, `to` is the port or net
  it ended on, and `replaces` is the port whose wire was picked up, or `null` for a new wire.
  Released over empty canvas, `to` is `null`, and `point`, `clientX`, and `clientY` say where to
  offer a new block.
- `move` lists the blocks the user dragged or nudged and the top-left corners they came to rest
  at: each block's corner before the move plus the move's offset, snapped to the grid when `snap`
  is on. They already show there: the diagram wrote them into `blockPosition`.
- `delete` lists the selection when the user pressed Delete or Backspace.

A host keeps its own document, applies what it accepts, and loads the result with `fit: false` so
the camera stays put. A load keeps the placement of every block whose key survives, so an
accepted wire or deletion needs nothing more. A block the host inserts or restores arrives
without one, and an undone move changes no structure, so the host keeps its placements by
`blockKey` and writes them after each load; blocks whose pair is unchanged do not move:

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
  if (wire.to === null) quickAdd.open(wire.clientX, wire.clientY, wire.from);
  else if (doc.connect(wire)) show(doc.netlist());
});
diagram.on('delete', (parts) => {
  if (doc.remove(parts)) show(doc.netlist());
});

// A palette drop: insert a block at the drop point, placed there.
canvas.addEventListener('drop', (event) => {
  const at = diagram.toDiagram(event.clientX, event.clientY);
  if (!at) return;
  placed.set(doc.insert(event.dataTransfer!.getData('text/plain')), at);
  show(doc.netlist());
});
```

`doc` and `quickAdd` stand for the host's own document and menu. Undo belongs to the host too: it
restores a move by writing the old corner, or NaN to hand the block back to its automatic
position, and restores a structural edit by loading the previous netlist.

## Shades

A shade is a fragment hook: WGSL declaring `fn shade(f: Fragment) -> vec4f`, compiled into the
block, port, wire, and group passes, plus an optional `tick` that writes a 64-float `host` block
before each frame. `setShade` resolves once those passes draw with it and rejects, keeping the
previous shade, when the WGSL does not compile. While detached it resolves at once and the shade
compiles on attach.

```ts
diagram.setChannel('blockShade', tripped); // 1 for a block that tripped, else 0
await diagram.setShade({
  wgsl: `
    fn shade(f: Fragment) -> vec4f {
      if (f.part != PART_BLOCK || f.value <= 0.0) { return f.color; }
      return mix(f.color, vec4f(0.92, 0.3, 0.28, 1.0), u.host[0].x * f.value);
    }`,
  tick(host, { timeMs }) {
    host[0] = 0.5 + 0.5 * Math.sin(timeMs / 300);
    return true; // keep frames coming
  },
});
await diagram.setShade(null);
```

`Fragment` carries the color the pass would paint (straight alpha), the part's kind (`PART_BLOCK`,
`PART_PORT`, `PART_NET`, `PART_GROUP`) and index, the fragment's `point` in diagram units, the
part's `FOCUS_*` flags, its `value` (`blockShade` for blocks and their ports, `netShade` for wires),
`along` (a wire's distance from its driver in diagram units), and `time` in seconds. `u.host` is
the block `tick` writes, `u.pointer_px` is the pointer in canvas-local CSS pixels (far off-canvas
while there is none), and `to_screen(f.point)` takes a fragment there. A `tick` receives the
frame's time, pointer, and viewport.

## Layout without a device

`@latkit/diagram/layout` exports `arrange`, the same pure, deterministic layout the diagram shows,
so a worker computes positions for a netlist before any canvas exists:

```ts
import { arrange } from '@latkit/diagram/layout';

const positions = arrange(unit, { gridPitch: 8 }); // top-left per block, on the grid
```

Blocks arrange in units: a group, or a component of ungrouped blocks joined by wired nets. Each
unit is laid out in layers along its signal flow, drivers left of readers, with feedback wires
returning underneath, and units pack in rows six grid steps apart. The gap is kept between
rectangles that hold everything drawn for a unit: its blocks, wires, their labels, and its
group's frame. Units of one shape share one layout. `arrange` throws an `Error` for an invalid netlist and a
`RangeError` for a `gridPitch` that is not a finite number greater than 0.

On the controller, `arrange(parts?, { animate })` recomputes the automatic layout of what `parts`
touch (their units, each anchored where it is), or of everything, and returns every block's
automatic top-left, `2 * blockCount` floats. A unit that grew into the six-step gap around
another moves down until it clears, or to a shelf below everything. It never changes placements:
write NaN into `blockPosition` to hand a placed block to the fresh layout, or write the returned
positions to keep the arrangement.

## Lifecycle and failures

`createDiagram()` is synchronous and takes neither a device nor a canvas; it throws a `TypeError`
or `RangeError` naming the first invalid option. Everything given to the controller before
`attach` is retained and painted onto the canvas, and `detach()` releases the device and the
canvas while keeping every state. A newer `attach` or a `detach` supersedes an attach still
waiting for its device, which rejects with an `AbortError`.

- `attach` rejects with `GpuUnavailableError` from `@latkit/gpu` when no device can be leased, and
  with a `TypeError` when the device reports fewer than five storage buffers in the vertex stage.
- On device loss the controller releases the device, leases a replacement, and paints again;
  `deviceLost` reports it, with `recovering` false when the controller stays detached: no
  replacement could be leased, or a handler of `attached: false` or `deviceLost` detached or
  attached anew first.
- `pipelineError` reports a shader-pipeline build that failed; nothing draws until a later
  `setShade` succeeds, and late subscribers receive the latest failure.
- `painted` turns true after the first successful frame since attach and false on detach.
  `paint()` schedules a frame and resolves once it is painted, after a pending shade and a
  deferred camera placement; it rejects with `InvalidStateError` while detached, with `AbortError`
  on detach, and with the cause of a pipeline failure.
- `pause()` stops rendering and clears hover at once, emitting `hover` with `null`; `resume()`
  continues. The controller also pauses while the page is hidden.
- `destroy()` detaches and forgets everything: the netlist and all derived from it, channels,
  selection, the shade, the camera, and the glyph atlas, giving back the memory they held. The
  controller cannot be used afterwards. It never removes the canvas.

## Performance

- A load validates and derives everything once. Layout runs once per unit shape and is translated
  to every unit of that shape, so thousands of identical plants cost a handful of layouts.
- Wires live in per-net slots: a move re-routes only the nets touching the moved blocks. A drag,
  nudge, or arrangement whose nets hold more than 8,192 ports in all hides those wires while it
  moves and routes them once when it lands; within that budget, only a net of more than 512 ports
  hides. Wires a burst of nudges hides route once, 160 ms after the last nudge.
- Hit testing is synchronous, over a spatial index on the CPU, so a drag starts without waiting
  for the GPU.
- A channel write is one copy into a slot allocated at load, and the next frame uploads only the
  ranges that changed.
- Text is drawn from a glyph atlas the controller rasterizes at runtime. The text runs are built
  the first time any text is legible, not at load. Glyphs are generated only for labels inside
  the view plus half a view on each side, and only once their size reaches 4.5 CSS pixels, capped
  at 262,144 glyphs. The atlas has room for 1,847 glyph cells (a wide glyph takes two); glyphs
  beyond that draw blank.
- Frames run on `createFrameLoop` from `@latkit/gpu`, the scheduler the network and monitor share,
  and it sleeps when nothing changes. Frames keep coming only while the camera eases, an
  arrangement or fade runs, nudged wires wait to route, a drag auto-pans, a wire drag's compatible
  ports pulse, a shade's `tick` returns true, or `netFlow` is bound with a nonzero value,
  `flowRate` is above 0, and motion is not reduced.

In this repository, `pnpm --filter @latkit/diagram bench` times the layout on about 36,000
blocks in 13,100 plants of four shapes, on one 2,000-block component, and on placing 100 new
plants beside 900.

## Registries

`CHANNELS` and `OPTIONS` are frozen and ordered. A picker iterates `Object.keys(CHANNELS)` and
shows `CHANNELS[key].label`, and reads `scope`, `map`, `normalized`, and `components`; a settings
form iterates `OPTIONS` and reads each entry's `kind`, `default`, and `live`.
