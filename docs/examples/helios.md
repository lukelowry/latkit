# Helios

```{image} ../images/helios.png
:alt: A synthetic network of 480 buses in five concentric rings, comets flowing along its 896 branches
:class: picture
```

A network in five rings, with vertices colored through a colormap, labeled hubs, and comets flowing along every branch.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts helios` to draw it again.

```{literalinclude} ../gallery/helios.ts
:language: typescript
```
