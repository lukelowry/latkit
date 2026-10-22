# ACTIVSg2000

```{image} ../images/texas.png
:alt: Two thousand buses of a synthetic Texas grid: generators as amber discs sized by output, comets along its highest-voltage lines
:class: picture
```

A synthetic Texas grid: generators sized by the square root of their output and labeled by priority, the most a frame can fit, with comets flowing along its backbone in map units, so they keep their place as the view zooms.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts texas` draws it again.

```{literalinclude} ../gallery/texas.ts
:language: typescript
```
