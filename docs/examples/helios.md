# Connect a network in rings

```{image} ../images/helios.png
:alt: A synthetic network of 480 buses in five concentric rings, comets flowing along its 896 branches
:class: picture
```

The Helios network has 480 vertices in five rings. Color distinguishes the vertices, labels identify the hubs, and comets follow the branches.

```sh
node docs/gallery/render.ts helios
```

```{literalinclude} ../gallery/helios.ts
:language: typescript
```
