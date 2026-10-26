# Terrain

```{image} ../images/terrain.png
:alt: Ridged mountains of 112,000 lit triangles, from deep teal valleys to pale summits, seen from above at an angle
:class: picture
```

Ridged mountains in three dimensions, as faces over a grid of vertices. Each face blends its corners' colors and is lit by normals the GPU computes.

The `latkit` command line draws this picture from the module below, which writes its data with
`Patch` and its scene as a typed `Scene`. `node docs/gallery/render.ts terrain` draws it again.

```{literalinclude} ../gallery/terrain.ts
:language: typescript
```
