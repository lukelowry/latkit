# Torus silk

```{image} ../images/torus.png
:alt: Sixty-four filaments in cyan, amber, and coral, twisting around a three-dimensional torus knot
:class: picture
```

Sixty-four filaments around a (2, 3) torus knot, drawn as edges between points with elevation and seen from above at an angle.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts torus` draws it again.

```{literalinclude} ../gallery/torus.ts
:language: typescript
```
