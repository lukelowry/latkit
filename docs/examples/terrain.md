# Terrain

```{image} ../images/terrain.png
:alt: Ridged mountains of 112,000 lit triangles, from deep teal valleys to pale summits, seen from above at an angle
:class: picture
```

Ridged mountains in three dimensions, as a wire mesh over a grid of vertices. Edges blend their endpoints' colors.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts terrain` to draw it again.

```{literalinclude} ../gallery/terrain.ts
:language: typescript
```
