# Line opening

```{image} ../images/opening.png
:alt: The ACTIVSg70k grid on the globe as one 765 kV line opens: buses raised by their frequency, branches that pick up its power glow amber, those it leaves glow cyan
:class: picture banner
```

The ACTIVSg70k case on the globe as its Little Rock to Newark 765 kV line opens, in red. A DC
power flow of all 70,000 buses finds the angles before the opening and how far each one shifts
after it, and each of the 88,207 branches is colored by the flow it picks up, in amber, or sheds, in
cyan; changes under 10 MW stay grey, the distribution web under 115 kV dim beneath the backbone.
Each bus stands as high as its frequency 2.5 s after the opening, recorded from a simulation of the
same event, and poles drop from the high-voltage buses to the ground.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts opening` draws it again.

```{literalinclude} ../gallery/opening.ts
:language: typescript
```

The power flow solves the grid's susceptance matrix by conjugate gradients, in a few seconds:

```{literalinclude} ../gallery/flow.ts
:language: typescript
```

The recording is too large for the repository; `record.ts` keeps the one instant drawn:

```{literalinclude} ../gallery/record.ts
:language: typescript
```
