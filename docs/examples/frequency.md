# ACTIVSg10k

```{image} ../images/frequency.png
:alt: The speed of 1,456 machines over ten seconds after a fault. Machines near the fault are bright and swing hardest, and far ones are dark
:class: picture
```

Each trace follows one of 1,456 machines for ten seconds after the simulated fault. Color shows distance from the fault.

```sh
node docs/gallery/render.ts frequency
```

```{literalinclude} ../gallery/frequency.ts
:language: typescript
```
