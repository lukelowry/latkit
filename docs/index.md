# latkit

:::{container} lede
latkit is a GPU-accelerated visualization library for large networks, such as power grids. It
renders interactive views in the browser with WebGPU, and images and video from the command line.
:::

:::{container} plot

```{image} images/opening.png
:alt: The ACTIVSg70k grid on the globe as one 765 kV line opens: buses raised by their frequency, branches that pick up its power glow amber, those it leaves glow cyan
:class: banner
```

:::

:::{container} caption
The 70,000-bus ACTIVSg70k grid as one 765 kV line opens. A DC power flow computes where the line's
power goes: branches that pick it up glow amber, and those that lose flow glow cyan. Each bus is
raised by its frequency. Drawn by the `latkit` command line in the {doc}`examples/opening` example.
:::

## Install

```sh
npm install latkit          # in the browser
cargo install latkit-cli    # pictures and video from the command line
cargo add latkit            # in Rust
```

## Quickstart

`quickstart(canvas)` draws a dataset on a canvas. When the page is done with them, destroy the
`view` and `grid` it returns. The package's consumer test type-checks and renders this file.

```{literalinclude} ../npm/test/consumer/quickstart.ts
:language: typescript
```

A **dataset** is a set of named tables of columns, which changes in place. A **scene** describes
what to draw: marks of a dataset's tables, in a space, with a theme and controls. A **view** draws a
scene on a canvas and into pictures. Scenes and expressions are plain data, and `JSON.stringify`
writes the JSON the command line reads. `load()` loads the WebAssembly that datasets and drawing
need; `View.create()`, `Data.read()`, and `Patch.read()` call it for you.

## Examples

:::{container} examples
{doc}`examples/frequency`
: 1,456 machines swinging after a fault, traced from a recording on a plot.

{doc}`examples/globe`
: Routes along great circles on a globe, with comets flowing along them.

{doc}`examples/diagram`
: Blocks in nested groups, laid out and wired port to port.

{doc}`examples/terrain`
: 112,000 lit faces in three dimensions.

{doc}`examples/clifford`
: 260,000 translucent points of a strange attractor.
:::

latkit draws every picture on this site; the {doc}`examples/index` show each one with its code. The
{doc}`guide` covers data, scenes, views, and pictures; the {doc}`cli` page covers drawing from JSON;
{doc}`performance` reports benchmark results; and the reference lists every option.

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
