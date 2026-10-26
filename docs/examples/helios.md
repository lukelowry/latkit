# Helios

```{image} ../images/helios.png
:alt: A synthetic network of 480 buses in five concentric rings, comets flowing along its 896 branches
:class: picture
```

A network in five rings, with vertices colored through a colormap, labeled hubs, and comets flowing along every branch.

The `latkit` command line draws this picture from the module below, which writes its data with
`Patch` and its scene as a typed `Scene`. `node docs/gallery/render.ts helios` draws it again.

```{literalinclude} ../gallery/helios.ts
:language: typescript
```
