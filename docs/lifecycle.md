# Lifecycle and failures

Applications own Core WebGPU devices and canvases. Latkit renderers borrow both and own only their renderer-specific GPU resources and event bindings. Request a device when a view group mounts, share it across that group, and destroy it after every borrowing renderer has been destroyed.

## Handle WebGPU support

`requestDevice()` reports WebGPU availability and device-request failures. Renderer creation is separate and requires the native device explicitly.

```ts
import { GpuUnavailableError, requestDevice } from '@latkit/gpu';
import { createNetwork, type Network } from '@latkit/network';

const networkCanvas = document.querySelector<HTMLCanvasElement>('#network');
if (!networkCanvas) throw new Error('Missing #network canvas');

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
  network = await createNetwork(device, networkCanvas);
  network.load(topology);
} catch (error) {
  network?.destroy();
  device.destroy();
  throw error;
}
```

Pass the same device to `createMonitor(device, monitorCanvas)` when both views share an application lifetime.

## Listen for device loss

Browsers can lose a WebGPU device after creation. Both renderers surface this with a `deviceLost` event.

```ts
network.on('deviceLost', ({ reason, message }) => {
  console.error(reason, message);
});

network.on('pipelineError', ({ family, cause }) => {
  console.error(`Unable to build ${family} shaders`, cause);
});

monitor.on('deviceLost', ({ reason, message }) => {
  console.error(reason, message);
});
```

A lost device cannot be restored. Destroy every renderer borrowing it, request a new device, and recreate the views. A `pipelineError` identifies an asynchronous `plane` or `globe` projection-family failure; late subscribers receive the latest failure so applications can replace a canvas that never became renderable.

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
networkCanvas.remove();
monitorCanvas.remove();
device.destroy();
```

Destroying a renderer clears its event handlers, unconfigures its canvas, and releases its GPU resources. It never removes the borrowed canvas or destroys the borrowed device.
