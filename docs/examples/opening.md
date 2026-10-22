# Line opening

```{image} ../images/opening.png
:alt: The ACTIVSg70k grid as one 765 kV line opens: branches that pick up its power glow amber, those it leaves glow blue, across a quiet web of 88,000 branches
:class: picture banner
```

The ACTIVSg70k case as its Little Rock to Newark 765 kV line opens. A DC power flow of all 70,000
buses finds the angles before the opening and how far each one shifts after it. Each of the 88,207
branches is then colored by how much flow it picks up, in amber, or sheds, in blue. The dashed line
is the one that opened.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts opening` draws it again.

```{literalinclude} ../gallery/opening.ts
:language: typescript
```

The power flow solves the grid's susceptance matrix by conjugate gradients, in a few seconds:

```{literalinclude} ../gallery/flow.ts
:language: typescript
```
