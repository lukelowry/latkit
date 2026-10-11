# Network example

Pages that draw networks with `@latkit/network` over a `@latkit/geography` map.

```sh
pnpm install
pnpm --filter @latkit/network-example dev
```

Open http://127.0.0.1:5188. The dev command builds the packages first.

- `/`: a grid over the earth. Choose a synthetic grid, from WECC 240-bus to ACTIVSg70k, or a
  lattice of up to a million buses, and the map beneath it: coasts and borders, Natural Earth's
  states, or OpenStreetMap's vector tiles. Color the states by the grid's figures, play a
  simulated fault, and hover or click anything to inspect it.
- `/blackout.html`: the BlackoutUSA map panel. Texas substations draw as gauges of their output,
  and branches color by loading and carry comets along their flow.

`public/grids` holds the grids and borders; `src/earth/cases.ts` describes their format. The
borders are Natural Earth, public domain.
