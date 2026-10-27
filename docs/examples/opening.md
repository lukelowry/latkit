# Line opening

```{image} ../images/opening.png
:alt: The ACTIVSg70k grid on the globe as one 765 kV line opens: buses raised by their frequency, branches that pick up its power glow amber, those it leaves glow cyan
:class: picture banner
```

The ACTIVSg70k case on the globe as its Little Rock to Newark 765 kV line, in red, opens. A DC
power flow of all 70,000 buses computes the bus angles before the opening and how far each shifts
after it. Each of the 88,207 branches is colored by the flow it picks up (amber) or sheds (cyan).
Changes under 10 MW stay grey, and branches below 230 kV with such small changes form a dim web
beneath the backbone. Each bus's height is its frequency 2.5 s after the opening, recorded from a
simulation of the same event, and poles drop to the ground from a sample of buses at 345 kV and up.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts opening` draws it again.

```{literalinclude} ../gallery/opening.ts
:language: typescript
```

The power flow solves the grid's susceptance matrix with conjugate gradients in a few seconds:

```{literalinclude} ../gallery/flow.ts
:language: typescript
```

The recording is too large for the repository, so `record.ts` saves only the instant drawn:

```{literalinclude} ../gallery/record.ts
:language: typescript
```
