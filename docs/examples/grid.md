# ACTIVSg70k

```{image} ../images/grid.png
:alt: Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage
:class: picture
```

The example suite's ACTIVSg70k case, 70,000 buses and 88,207 branches, over the states on a Mercator map tilted toward the Great Lakes. Each line takes its color and width from its voltage level, and the backbone draws on top by priority.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts grid` draws it again.

```{literalinclude} ../gallery/grid.ts
:language: typescript
```
