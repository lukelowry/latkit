# Clifford

```{image} ../images/clifford.png
:alt: A Clifford strange attractor of 260,000 translucent points, colored by the way each step turns
:class: picture
```

A strange attractor of 260,000 translucent points, colored through a cyclic colormap by where each step heads, so density and flow both show.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts clifford` draws it again.

```{literalinclude} ../gallery/clifford.ts
:language: typescript
```
