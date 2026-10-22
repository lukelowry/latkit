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
The 70,000-bus ACTIVSg70k grid as one 765 kV line opens: a DC power flow finds where its power goes,
amber on the branches that pick it up and cyan on those it leaves, and each bus stands as high as its
frequency. Drawn by the `latkit` command line in the {doc}`examples/opening` example.
:::

## Install

```sh
npm install latkit          # in the browser
cargo install latkit-cli    # pictures and video from the command line
cargo add latkit            # in Rust
```

## Quickstart

`quickstart(canvas)` draws a dataset on a canvas; destroy the `gpu` and `data` it returns when the
page is done with them. The package's consumer test type-checks and renders this file.

```{literalinclude} ../npm/test/consumer/quickstart.ts
:language: typescript
```

A **dataset** is named tables of columns, changed by **patches**. A **scene** says what to draw:
marks naming tables, in a space, with a theme and controls. A **view** draws a scene from the
datasets it is given, on a canvas or into pictures. Scenes, expressions, and patches are plain data
that need no WebAssembly; `loadLatkit()` loads it for data and drawing.

## Examples

:::{container} examples
{doc}`examples/frequency`
: 1,456 machines swinging after a fault, traced from a recording on a plot.

{doc}`examples/globe`
: Routes along great circles on a globe, comets flowing on them.

{doc}`examples/diagram`
: Blocks in nested groups, laid out and wired port to port.

{doc}`examples/terrain`
: 112,000 lit faces in three dimensions.

{doc}`examples/clifford`
: 260,000 translucent points of a strange attractor.
:::

Every picture is drawn by latkit; the {doc}`examples/index` hold them all with the code that draws
them. The {doc}`guide` covers data, scenes, views, and pictures, the {doc}`cli` draws them from
JSON, {doc}`performance` measures what each costs, and the reference lists every option.

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
