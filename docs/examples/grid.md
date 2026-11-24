# ACTIVSg70k

```{image} ../images/grid.png
:alt: Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage
:class: picture
```

ACTIVSg70k has 70,000 buses and 88,207 branches. Line color and width encode voltage. On this tilted Mercator map, `priority` keeps the high-voltage lines visible.

```sh
node docs/gallery/render.ts grid
```

```{literalinclude} ../gallery/grid.ts
:language: typescript
```
