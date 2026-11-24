# latkit

:::{container} lede
latkit is a GPU-accelerated visualization library for large networks, such as power grids. It
renders interactive views in the browser with WebGL2, and images and video from the command line.
:::

:::{container} plot

```{image} images/opening.png
:alt: The ACTIVSg70k grid on a globe as one 765 kV line opens. Buses rise with their frequency, branches that pick up the line's power glow amber, and branches that lose flow glow cyan
:class: banner
```

:::

:::{container} caption
The 70,000-bus ACTIVSg70k grid as one 765 kV line opens. A DC power flow computes where the line's
power goes. Branches that pick it up glow amber, and branches that lose flow glow cyan. Each bus
rises with its frequency. Drawn by the `latkit` command line from `docs/gallery/opening.ts`.
:::

## Install

```sh
npm install latkit          # in the browser
cargo install latkit-cli    # pictures and video from the command line
cargo add latkit            # in Rust
```

## Quickstart

`quickstart(canvas)` draws a dataset on a canvas. Call `destroy()` on the returned `view` and `grid` when the page is done with them.

```{literalinclude} ../npm/test/consumer/quickstart.ts
:language: typescript
```

A **dataset** holds named tables. A **scene** describes which rows to draw, where to place
them, and how they look. A **view** renders the scene on a canvas. To use a scene with the
CLI, serialize it with `JSON.stringify`.

## Examples

:::{container} examples
{doc}`examples/frequency`
: 1,456 machines swinging after a fault, traced from a recording on a plot.

{doc}`examples/globe`
: Routes along great circles on a globe, with comets flowing along them.

{doc}`examples/helios`
: 480 buses in five concentric rings, with comets flowing along every branch.

{doc}`examples/terrain`
: A wire mesh of mountain ridges in three dimensions.

{doc}`examples/clifford`
: 260,000 translucent points of a strange attractor.
:::

Browse the full {doc}`examples/index` or start with the {doc}`guide`.

```{toctree}
:hidden:

examples/index
guide
cli
performance
```

```{toctree}
:hidden:
:caption: Reference

reference/api
reference/types
reference/cli
Rust API <https://docs.rs/latkit>
```
