---
hide-toc: true
---

# latkit

:::{container} lede
latkit draws large networks, including power grids. Explore them in a browser with WebGL2
or render images and video from the command line.
:::

<span id="install">[Installation](installation.md)</span> | <span id="quickstart">[Quickstart](quickstart.md)</span>

:::{container} plot

```{image} images/opening.png
:alt: ACTIVSg70k after the Little Rock–Newark line outage. Surrounding branches show increases and decreases in active power flow.
:class: banner
```

:::

:::{container} caption
After the Little Rock–Newark 765 kV line opens, a DC power flow gives the change in branch flow magnitude (MW). Amber marks increases and cyan marks decreases. Bus height shows frequency deviation from 60 Hz about 2.5 s into a dynamic simulation of the same outage.
:::

## Examples

:::{container} examples
{doc}`examples/hawaii`
: Follow circuits, transformers and generators on the 69 kV and 138 kV systems.

{doc}`examples/wecc`
: Compare bus voltage and machine speed during a fault at John Day.

{doc}`examples/voltage-dip`
: Read the voltage at John Day before, during and after fault clearing.

{doc}`examples/terrain`
: Draw a three-dimensional surface from a triangle mesh.
:::

[Browse the example gallery](examples/index.md)

## Author

```{include} ../README.md
:start-after: "## Author"
```

```{raw} html
<script>
  const destination = { "#install": "installation.html", "#quickstart": "quickstart.html" }[location.hash];
  if (destination) location.replace(destination);
</script>
```

```{toctree}
:hidden:
:titlesonly:
:maxdepth: 2
:caption: Start here

Home <self>
installation
quickstart
```

```{toctree}
:hidden:
:titlesonly:
:maxdepth: 1
:caption: Examples

examples/index
performance
```

```{toctree}
:hidden:
:titlesonly:
:maxdepth: 1
:caption: Guides

data
scenes
time-series
views
pictures-and-video
```

```{toctree}
:hidden:
:titlesonly:
:maxdepth: 1
:caption: Tools and deployment

cli
in-rust
deploying
```

```{toctree}
:hidden:
:titlesonly:
:maxdepth: 1
:caption: Reference

reference/api
reference/types
reference/cli
formats
Rust API <https://docs.rs/latkit>
```
