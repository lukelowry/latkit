# ACTIVSg10k

```{image} ../images/frequency.png
:alt: The speed of 1,456 machines over ten seconds after a fault. Machines near the fault are bright and swing hardest, and far ones are dark
:class: picture
```

A simulated fault on the ACTIVSg10k case: every machine's speed over ten seconds, traced directly from the recording's sampled field and colored by distance from the fault.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts frequency` to draw it again.

```{literalinclude} ../gallery/frequency.ts
:language: typescript
```
