# Globe

```{image} ../images/globe.png
:alt: Great-circle routes between forty of the world's great cities on a globe, with comets flowing along them
:class: picture
```

Great-circle routes between forty cities, with comets flowing along them. Coastlines and borders come from GeoJSON, and the globe has an atmosphere.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts globe` to draw it again.

```{literalinclude} ../gallery/globe.ts
:language: typescript
```
