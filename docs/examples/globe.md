# Globe

```{image} ../images/globe.png
:alt: Routes between forty of the world's great cities, along great circles on a globe, comets flowing on them
:class: picture
```

Routes between forty cities along great circles, with comets flowing along them, over coastlines and borders read from GeoJSON, on a globe with an atmosphere.

The `latkit` command line draws this picture from the module below, which writes its data with
`Patch` and its scene as a typed `Scene`. `node docs/gallery/render.ts globe` draws it again.

```{literalinclude} ../gallery/globe.ts
:language: typescript
```
