# Example gallery

## Power system studies

:::{container} cards
[![Numbered busbars and transformer windings in the Hawaii40 case](../images/hawaii.png) Draw the Hawaiʻi one-line](hawaii.md)

[![A frequency map, a rotor speed trace and a bus voltage trace from WECC240](../../crates/latkit-cli/examples/wecc240-fault/preview.png) Compare a map and two fault traces](wecc.md)

[![Seventy thousand buses of a synthetic grid on the United States, its lines colored and widened by voltage](../images/grid.png) Map a large power grid](grid.md)

[![Amber disks mark buses with generation in the synthetic Texas grid](../images/texas.png) Map generation by bus](texas.md)

[![Machine rotor speed deviations over ten seconds, colored by proximity to the fault](../images/frequency.png) Plot rotor speed after a fault](frequency.md)

[![The ACTIVSg70k grid as a dim web, half a second after its Little Rock to Newark line opens in red. Rings and corridors of branches around it glow amber and white where their flow changed most](../images/rerouting.png) Trace power after a line opens](rerouting.md)

[![Changes in branch active power following a bus fault in ACTIVSg25k](../images/fault.png) Track power flows during a fault](fault.md)
:::

## Monitors

:::{container} cards
[![Voltage at bus 4005 during a 150 ms fault](../images/voltage-dip.png) Bus voltage during a fault](voltage-dip.md)

[![A stepped setpoint and its slower response](../images/step-response.png) Setpoint and response](step-response.md)
:::

## Maps, geometry and motion

:::{container} cards
[![Great-circle routes between forty of the world's great cities on a globe, with comets flowing along them](../images/globe.png) Draw great-circle routes](globe.md)

[![A synthetic network of 480 buses in five concentric rings, comets flowing along its 896 branches](../images/helios.png) Connect a network in rings](helios.md)

[![Sixty-four filaments in cyan, amber, and coral, twisting around a three-dimensional torus knot](../images/torus.png) Draw a torus knot](torus.md)

[![Ridged mountains of 112,000 lit triangles, from deep teal valleys to pale summits, seen from above at an angle](../images/terrain.png) Build a terrain mesh](terrain.md)

[![A Clifford strange attractor of 260,000 translucent points, colored by the direction of each step](../images/clifford.png) Plot a strange attractor](clifford.md)

[![Thirty-two thousand seeds a golden angle apart, in arms of sapphire, rose, and amber](../images/bloom.png) Color a spiral of points](bloom.md)

[![Over a thousand streamlines swirling around seven vortices, slow ones deep blue and fast ones pale](../images/currents.png) Trace streamlines](currents.md)

[![One hundred and ten closed contours swelling outward, from deep blue at the center to warm sand at the rim](../images/tides.png) Draw nested contours](tides.md)
:::

## Reproduce a gallery image

For the TypeScript examples, install the [build prerequisites](https://github.com/lukelowry/latkit/blob/develop/CONTRIBUTING.md), then run these commands once from the repository root. Each example gives its own render command.

```sh
pnpm install --frozen-lockfile
cargo xtask wasm
cargo build --locked -p latkit-cli --profile cli
```

## Try the browser examples

From a checkout, run `cargo xtask examples --open` and choose an example.

| Example               | What to try                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Hawaiʻi one-line      | Zoom into a circuit, inspect the drafting paths, or toggle device symbols and bus numbers. |
| One-line              | Toggle breakers and flow animation on a generated schematic.                               |
| Power grids           | Explore synthetic cases on a map or globe.                                                 |
| Bus voltage monitor   | Zoom in on the voltage dip at John Day.                                                    |
| Setpoint and response | Compare a step command with the output on the same time axis.                              |
| Soft body             | Inspect the Stanford bunny mesh as it deforms.                                             |
| Orbits                | Move the pointer through the galaxy to magnify nearby bodies.                              |

[Browser example source](https://github.com/lukelowry/latkit/tree/develop/npm/examples).

```{toctree}
:hidden:

hawaii
wecc
voltage-dip
step-response
grid
texas
frequency
rerouting
fault
globe
helios
torus
terrain
clifford
bloom
currents
tides
```
