# ACTIVSg2000

```{image} ../images/texas.png
:alt: Two thousand buses of a synthetic Texas grid: generators as amber discs sized by output, comets along its highest-voltage lines
:class: picture
```

A synthetic Texas grid. Generators are sized by the square root of their output, and the ten largest are labeled. Comets flow along the lines of 345 kV and up, spaced in map units so they keep their place as the view zooms.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts texas` draws it again.

```{literalinclude} ../gallery/texas.ts
:language: typescript
```
