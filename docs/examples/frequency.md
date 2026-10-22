# ACTIVSg10k

```{image} ../images/frequency.png
:alt: The speed of 1,456 machines over ten seconds after a fault, near ones bright and swinging hardest, far ones dark
:class: picture
```

A simulated fault on the ACTIVSg10k case: every machine's speed traced over ten seconds, read straight from the recording's sampled field, and colored by distance from the fault.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts frequency` draws it again.

```{literalinclude} ../gallery/frequency.ts
:language: typescript
```
