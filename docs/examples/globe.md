# Globe

```{image} ../images/globe.png
:alt: Routes between forty of the world's great cities, along great circles on a globe, comets flowing on them
:class: picture
```

Routes between forty cities along great circles, comets flowing on them, over coastlines and borders read from GeoJSON, on a globe with its atmosphere.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts globe` draws it again.

```{literalinclude} ../gallery/globe.ts
:language: typescript
```
