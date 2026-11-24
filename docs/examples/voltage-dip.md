# Bus voltage during a fault

```{image} ../images/voltage-dip.png
:alt: Voltage at John Day drops from about 1.08 to 0.91 per unit during the fault, then rises when it clears.
:class: picture
```

A fault at bus 4005 in the WECC240 simulation starts at 1.00 s and clears at 1.15 s. This monitor shows the bus voltage over 0.8 seconds. The recording retains a sample on each side of both switching events.

With the [browser examples](index.md#try-the-browser-examples) running, [open the standalone monitor](http://127.0.0.1:5200/monitor.html?plot=voltage). To reproduce the image:

```sh
node docs/gallery/render.ts voltage-dip
```

```{literalinclude} ../gallery/voltage.ts
:language: typescript
```
