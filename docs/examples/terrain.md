# Terrain

```{image} ../images/terrain.png
:alt: Ridged mountains of 112,000 lit triangles, from deep teal valleys to pale summits, seen from above at an angle
:class: picture
```

Ridged mountains as faces between a grid of vertices: each face blends its corners' colors, lit by the normals the GPU works out, in three dimensions.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts terrain` draws it again.

```{literalinclude} ../gallery/terrain.ts
:language: typescript
```
