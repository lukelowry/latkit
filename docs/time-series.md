# Time series and streaming

## Record over time

Start with the [three-bus dataset](data.md#write-a-dataset). Each frame gives three bus voltage magnitudes in per unit, in bus row order. `view.at` selects the time in seconds.

```ts
grid.axis('time', 's');
grid.append('Bus', [0, 1], { voltage: [1.02, 1.0, 0.98, 1.01, 0.99, 0.96] });
view.at = 0.5;
```

Use the sampled field `voltage` for the bus color or a plot trace. Marks interpolate between samples. Use `field('voltage').step()` to hold each value until the next sample. Use `grid.forget(t)` to discard older history as a stream grows.

To play the axis, give views a `Playhead`. Views that follow one show the same coordinate in the
same frame, and scrubbing any of them moves it:

```ts
import { Playhead } from 'latkit';

const playhead = new Playhead({ span: [0, 1] });
map.playhead = monitor.playhead = playhead;
playhead.play(); // one axis unit per second
```

When a plot has more samples than pixels, each pixel column shows the minimum and maximum
for its interval. The recording stores these extrema in buckets of `8^k` frames at level `k`.

## Fetch long histories in spans

Write a history too large to load at once as time tiles. A view then fetches only what it draws:

```sh
latkit tile history.latk -o history/
```

```ts
view.sources = [new Tiles('grid', 'history/frames.json')]; // in place of the dataset named grid
```

A plot fetches tiles for its visible interval and resolution. Other marks fetch the frames
around `view.at`. While a tile loads, the view draws the coarser tile that covers it.

For live recordings, apply append patches to a `TileWriter`, call `flush()`, then call
`tiles.refresh()`. Views reload the last span at each level. Flush once after declaring the
fields if clients need the manifest before the first frame arrives. In Rust, use
`Snapshot::to_tiles` to write a complete dataset. Supply `{ fetch }` to the `Tiles`
constructor to read tiles from a custom server.

## Stream

`patch.toBytes()` encodes a patch as one frame. Frames written back to back form a stream, which a
server in any language can write ([format](formats.md#bytes)). `Patch.stream` yields each patch as soon as
its last byte arrives:

```ts
for await (const patch of Patch.stream((await fetch('/feed')).body!)) grid.apply(patch);
```

`new Patch('grid')` names its dataset, and applying it to another dataset fails.
