# Plot rotor speed after a fault

```{image} ../images/frequency.png
:alt: Rotor speed deviations for 1,456 machines. Two vertical grid lines mark the fault interval near the start of the recording.
:class: picture
```

Each trace is one machine’s rotor speed deviation from synchronous speed, expressed in mHz on a 60 Hz base. The two grid lines near 1 s mark fault application at 1.00 s and clearing at 1.15 s in the ACTIVSg10k simulation.

Warm colors identify machines geographically close to the faulted bus. The color scale uses differences in longitude and latitude.

```sh
node docs/gallery/render.ts frequency
```

```{literalinclude} ../gallery/frequency.ts
:language: typescript
```
