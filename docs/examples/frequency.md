# ACTIVSg10k

```{image} ../images/frequency.png
:alt: The speed of 1,456 machines over ten seconds after a fault, near ones bright and swinging hardest, far ones dark
:class: picture
```

A simulated fault on the ACTIVSg10k case: every machine's speed over ten seconds, traced directly from the recording's sampled field and colored by distance from the fault.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts frequency` draws it again.

```{literalinclude} ../gallery/frequency.ts
:language: typescript
```
