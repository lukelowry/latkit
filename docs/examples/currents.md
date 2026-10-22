# Currents

```{image} ../images/currents.png
:alt: Over a thousand streamlines swirling around seven vortices, slow ones deep blue and fast ones pale
:class: picture
```

Streamlines traced through a field of seven vortices, as a wind map draws them: each a path of geometry, colored by its speed.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts currents` draws it again.

```{literalinclude} ../gallery/currents.ts
:language: typescript
```
