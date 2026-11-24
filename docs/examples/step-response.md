# Setpoint and response

```{image} ../images/step-response.png
:alt: The dashed command steps from 40 to 80 MW and then down to 55 MW. The solid output approaches each new value gradually.
:class: picture
```

The command changes at 3 s and 14 s. The output follows with a two-second time constant. Both traces use the same time axis. Step interpolation holds the command between changes.

With the [browser examples](index.md#try-the-browser-examples) running, [open the standalone monitor](http://127.0.0.1:5200/monitor.html?plot=response). To reproduce the image:

```sh
node docs/gallery/render.ts step-response
```

```{literalinclude} ../gallery/step-response.ts
:language: typescript
```
