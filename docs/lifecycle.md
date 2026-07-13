# Lifecycle and failures

Applications own Core WebGPU devices. Latkit renderers borrow a device and own only their canvas and renderer-specific GPU resources. Request a device when a view group mounts, share it across that group, and destroy it after every borrowing renderer has been destroyed.

## Handle WebGPU support

`requestDevice()` reports WebGPU availability and device-request failures. Renderer creation is separate and requires the native device explicitly.

```ts
import { GpuUnavailableError, requestDevice } from '@latkit/gpu';
import { createNetwork, type Network } from '@latkit/network';

let device: GPUDevice;

try {
  device = await requestDevice();
} catch (error) {
  if (error instanceof GpuUnavailableError) {
    console.error(`WebGPU unavailable at ${error.stage}:`, error.message);
  }
  throw error;
}

let network: Network | undefined;

try {
  network = await createNetwork(device, container);
  network.load(topology);
} catch (error) {
  network?.destroy();
  device.destroy();
  throw error;
}
```

Pass the same device to `createMonitor(device, container)` when both views share an application lifetime.

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

A lost device cannot be restored. Destroy every renderer borrowing it, request a new device, and recreate the views.

## Pause and resume rendering

Use `pause()` for hidden panels, inactive tabs inside your app, or temporary work that should stop animation. Use `resume()` when rendering should continue.

```ts
network.pause();
network.resume();

monitor.pause();
monitor.resume();
```

## Release resources

Always destroy renderers before destroying their device:

```ts
network.destroy();
monitor.destroy();
device.destroy();
```

Destroying a renderer removes its canvas, clears event handlers, and releases its GPU resources. It never destroys the borrowed device.
