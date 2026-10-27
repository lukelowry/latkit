# ACTIVSg70k

```{image} ../images/grid.png
:alt: Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage
:class: picture
```

The example suite's ACTIVSg70k case, with 70,000 buses and 88,207 branches, over the US states on a Mercator map tilted toward the Great Lakes. Each line's color and width follow its voltage level, and `priority` draws the high-voltage backbone on top.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts grid` draws it again.

```{literalinclude} ../gallery/grid.ts
:language: typescript
```
