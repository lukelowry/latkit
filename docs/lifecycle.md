# Lifecycle and failures

Latkit renderers own browser and GPU resources. Create them when a view mounts, pause them when the view should stop rendering, and destroy them when the host removes the view.

## Handle WebGPU support

Renderer creation can fail when WebGPU is unavailable or the browser cannot create a device.

```ts
try {
  const network = await createNetwork(container);
  network.load(topology);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Cannot start Latkit renderer:', message);
}
```

Use the same pattern with `createMonitor()`.

## Listen for device loss

Browsers can lose a WebGPU device after creation. Both renderers surface this with a `deviceLost` event.

```ts
network.on('deviceLost', (reason, message) => {
  console.error(reason, message);
});

monitor.on('deviceLost', (info) => {
  console.error(info.reason, info.message);
});
```

## Pause and resume rendering

Use `pause()` for hidden panels, inactive tabs inside your app, or temporary work that should stop animation. Use `resume()` when rendering should continue.

```ts
network.pause();
network.resume();

monitor.pause();
monitor.resume();
```

## Release resources

Always destroy renderers when their host UI is removed:

```ts
network.destroy();
monitor.destroy();
```

Destroying removes the inserted canvas, clears event handlers, and releases renderer-owned GPU resources.
