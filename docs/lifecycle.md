# Lifecycle and failures

A controller outlives its canvas and its device. Create it when the data arrives, attach it when there is a canvas to draw on, detach when the canvas goes away, and destroy it when the view is gone for good.

## Create, attach, detach

`createNetwork()`, `createMonitor()`, and `createDiagram()` are synchronous and take neither a device nor a canvas. Everything given to a controller before `attach` is retained and painted onto the canvas:

```ts
import { createDiagram } from '@latkit/diagram';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';

const network = createNetwork({ graticule: true });
network.load(topology);
network.setChannel('vertexColor', load, [0, 1]);

const monitor = createMonitor({ valueRange: [0, 1] });
monitor.load(series);

const diagram = createDiagram({ interaction: 'edit' });
diagram.load(netlist);

await network.attach(networkCanvas);
await monitor.attach(monitorCanvas);
await diagram.attach(diagramCanvas);
```

`attach` leases a device from the realm-wide pool in `@latkit/gpu`, so every controller on the page shares one device without owning it; the `devices` option names a private pool instead. A newer `attach` or a `detach` supersedes an attach still waiting for its device, which then resolves `false`, and attaching the canvas already bound or binding joins that attach, so a host may call `attach` whenever its canvas becomes visible. `detach(canvas)` detaches only while that canvas is the current one, so a view that has lost its canvas cannot release another's.

`detach()` returns the device and the canvas and keeps every state, so a view that moves between panels attaches again with nothing to reload:

```ts
network.detach();
await network.attach(otherCanvas);
```

The `attached` property and event report the binding, and `canvas` names the canvas bound or binding.

## Handle WebGPU support

`attach` rejects with `GpuUnavailableError` when no Core device can be leased. Everything loaded before the attempt stays loaded.

```ts
import { GpuUnavailableError } from '@latkit/gpu';

try {
  await network.attach(canvas);
} catch (error) {
  if (error instanceof GpuUnavailableError) showFallback(error.message);
  else throw error;
}
```

## Listen for device loss

A controller releases a lost device, leases a replacement, and paints its state again. `deviceLost` reports it; `recovering` is false when the controller stays detached: no replacement could be leased, or a handler of `attached: false` or `deviceLost` detached or attached anew first. The controller then stays detached until the next `attach`.

```ts
network.on('deviceLost', ({ message, recovering }) => {
  if (!recovering) showFallback(message);
});

network.on('pipelineError', ({ family, cause }) => {
  console.error(`Unable to build ${family} shaders`, cause);
});
```

A network `pipelineError` identifies an asynchronous `plane` or `globe` projection-family failure; a diagram has one pipeline family, so its `pipelineError` carries only `cause`. Late subscribers receive the latest one.

## Pause and resume

`pause()` stops animation and rendering for hidden panels or inactive tabs and clears any hover, so a concealed surface emits `hover` with `null` at once; `resume()` continues. A pause survives `detach` and holds the next binding. The network and the diagram also pause themselves while the page is hidden.

The `painted` event and property report the first successful frame after each attach and turn false again on detach. Neither `attached` nor a resolved `attach()` promises a frame: pipelines compile asynchronously, and `painted` is the signal a poster or placeholder should wait for. A monitor reports `rendered` instead, each time what it holds is on screen. No frame draws before the canvas has a layout size, so neither event fires for a canvas kept at `display: none` until it does; the resize that gives the canvas area draws and reports.

`paint()` schedules a frame and resolves once it is painted, after a pending shade and a deferred camera placement, and after `resume()` while paused. It rejects while detached, with an `AbortError` on detach, and with the cause of a pipeline failure for the active projection.

```ts
network.setChannel('vertexColor', values, [0, 1]);
await network.paint();
```

## Release resources

`destroy()` detaches and forgets everything; the controller cannot be used afterwards. It never removes the canvas.

```ts
network.destroy();
canvas.remove();
```

The pooled device is destroyed when its last lease releases.
