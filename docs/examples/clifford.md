# Plot a strange attractor

```{image} ../images/clifford.png
:alt: A Clifford strange attractor of 260,000 translucent points, colored by the direction of each step
:class: picture
```

Opacity reveals where the Clifford attractor's 260,000 points cluster. A cyclic colormap shows the direction of each step.

```sh
node docs/gallery/render.ts clifford
```

```{literalinclude} ../gallery/clifford.ts
:language: typescript
```
