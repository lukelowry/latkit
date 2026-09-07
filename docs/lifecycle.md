# Lifecycle and failures

A controller outlives its canvas and its device. Create it when the data arrives, attach it when there is a canvas to draw on, detach when the canvas goes away, and destroy it when the view is gone for good.

## Create, attach, detach

`createNetwork()` and `createMonitor()` are synchronous and take neither a device nor a canvas. Everything given to a controller before `attach` is retained and painted onto the canvas:

```ts
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';

const network = createNetwork({ graticule: true });
network.load(topology);
network.setChannel('vertexColor', load, [0, 1]);

const monitor = createMonitor({ valueRange: [0, 1] });
monitor.load(series);

await network.attach(networkCanvas);
await monitor.attach(monitorCanvas);
```

`attach` leases a device from the realm-wide pool in `@latkit/gpu`, so every controller on the page shares one device without owning it; the `devices` option names a private pool instead. A newer `attach` or a `detach` supersedes an attach still waiting for its device, which rejects with an `AbortError`.

`detach()` returns the device and the canvas and keeps every state, so a view that moves between panels attaches again with nothing to reload:

```ts
network.detach();
await network.attach(otherCanvas);
```

The `attached` property and event report the binding.

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

A controller releases a lost device, leases a replacement, and paints its state again. `deviceLost` reports it; `recovering` is false only when no replacement could be leased, and the controller then stays detached until the next `attach`.

```ts
network.on('deviceLost', ({ message, recovering }) => {
  if (!recovering) showFallback(message);
});

network.on('pipelineError', ({ family, cause }) => {
  console.error(`Unable to build ${family} shaders`, cause);
});
```

A `pipelineError` identifies an asynchronous `plane` or `globe` projection-family failure; late subscribers receive the latest one.

## Pause and resume

`pause()` stops animation and rendering for hidden panels or inactive tabs and clears any hover, so a concealed surface emits `hover` with `null` at once; `resume()` continues. A pause survives `detach` and holds the next binding. The network also pauses itself while the page is hidden.

The `painted` event and property report the first successful frame after each attach and turn false again on detach. Neither `attached` nor a resolved `attach()` promises a frame: pipelines compile asynchronously, and `painted` is the signal a poster or placeholder should wait for.

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
