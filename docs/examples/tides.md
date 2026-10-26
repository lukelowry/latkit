# Tides

```{image} ../images/tides.png
:alt: One hundred and ten closed contours swelling outward, from deep blue at the center to warm sand at the rim
:class: picture
```

Closed contours swelling outward, each rippled by harmonics whose phases shift with its level, colored from the center out.

The `latkit` command line draws this picture from the module below, which writes its data with
`Patch` and its scene as a typed `Scene`. `node docs/gallery/render.ts tides` draws it again.

```{literalinclude} ../gallery/tides.ts
:language: typescript
```
