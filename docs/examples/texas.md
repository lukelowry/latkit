# ACTIVSg2000

```{image} ../images/texas.png
:alt: Two thousand buses of a synthetic Texas grid: generators as amber discs sized by output, comets along its highest-voltage lines
:class: picture
```

Generator size follows the square root of output. Labels identify the ten largest generators. On lines rated 345 kV and above, comets keep their spacing in map units as you zoom.

```sh
node docs/gallery/render.ts texas
```

```{literalinclude} ../gallery/texas.ts
:language: typescript
```
