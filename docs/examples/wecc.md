# Compare a map and two fault traces

```{image} ../../crates/latkit-cli/examples/wecc240-fault/preview.png
:alt: WECC240 fault response at 1.12 s. The map shows bus frequency deviation alongside plots of rotor speed deviation and John Day bus voltage.
:class: picture
```

The fault at John Day, bus 4005, starts at 1.00 s and clears at 1.15 s. The white cursor marks the same instant on both plots. At 1.12 s the fault is still applied.

- **Map.** Color and height show bus frequency deviation estimated from the rate of change of voltage angle. Color saturates at ±0.1 Hz.
- **Upper plot.** Rotor speed deviation for machine 4039_G, which has the largest absolute speed excursion among the 103 synchronous machines in the recording.
- **Lower plot.** Voltage magnitude at the faulted bus, in per unit.

The GridKit recording ships with the example. [Render a still or a video](../cli.md) or [inspect the case, recording and rendering script](https://github.com/lukelowry/latkit/tree/develop/crates/latkit-cli/examples/wecc240-fault).
