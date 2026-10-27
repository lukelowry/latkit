# Currents

```{image} ../images/currents.png
:alt: Over a thousand streamlines swirling around seven vortices, slow ones deep blue and fast ones pale
:class: picture
```

Streamlines traced through a field of seven vortices, as on a wind map. Each streamline is a path geometry, colored by its speed.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts currents` to draw it again.

```{literalinclude} ../gallery/currents.ts
:language: typescript
```
