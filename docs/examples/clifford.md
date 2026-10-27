# Clifford

```{image} ../images/clifford.png
:alt: A Clifford strange attractor of 260,000 translucent points, colored by the way each step turns
:class: picture
```

A strange attractor of 260,000 translucent points, colored by the direction of each step through a cyclic colormap, so both density and flow show.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts clifford` draws it again.

```{literalinclude} ../gallery/clifford.ts
:language: typescript
```
