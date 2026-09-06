# @latkit/gpu

Core WebGPU device and canvas presentation primitives for Latkit.

`@latkit/gpu` handles the environmental part of requesting a device and then
returns the platform `GPUDevice` directly. It also provides the shared
presentation implementation used by Latkit renderers. All exports come from the
single `@latkit/gpu` entrypoint.

## Install

```sh
npm install @latkit/gpu
```

## Request a device

```ts
import { requestDevice } from '@latkit/gpu';

const device = await requestDevice();

try {
  console.log(device.limits);

  void device.lost.then((info) => {
    console.error('GPU device lost:', info.reason, info.message);
  });
} finally {
  device.destroy();
}
```

`requestDevice()` requests Core WebGPU and leaves the adapter power preference
to the browser. Pass `powerPreference` only when the application has a specific
reason to override that choice:

```ts
const device = await requestDevice({
  powerPreference: 'high-performance',
});
```

## Handle availability

```ts
import { GpuUnavailableError, requestDevice } from '@latkit/gpu';

try {
  const device = await requestDevice();

  try {
    // Create renderers that borrow device.
  } finally {
    device.destroy();
  }
} catch (error) {
  if (error instanceof GpuUnavailableError) {
    console.error(`WebGPU unavailable at ${error.stage}:`, error.message);
  } else {
    throw error;
  }
}
```

Only API absence, a null adapter, and device-request rejection use
`GpuUnavailableError`. Other platform and programming failures retain their
original identity.

## Share one device

Every Latkit controller leases its device from `devices`, the realm-wide pool: one device per
page, requested by the first `acquire` and destroyed with the last release. Leases count the
borrowers, concurrent acquisitions coalesce into one request, and a device the platform reports
lost is retired so the next acquisition requests a replacement. `createDevicePool()` makes a
private pool with the same rules and forwards `requestDevice()` options; hand it to a controller
through its `devices` option.

```ts
import { createDevicePool, devices } from '@latkit/gpu';

const lease = await devices.acquire();
try {
  // Borrow lease.device alongside the controllers on this page.
} finally {
  lease.release(); // the device outlives this lease only while another one holds it
}

const network = createNetwork({ devices: createDevicePool({ powerPreference: 'low-power' }) });
```

## Configure presentation

Renderer implementations can configure either an `HTMLCanvasElement` or an
`OffscreenCanvas` through the same primitive:

```ts
import { createPresentation } from '@latkit/gpu';

const presentation = createPresentation(device, canvas);
presentation.resize(800, 450);

try {
  const texture = presentation.context.getCurrentTexture();
  // Encode rendering commands for texture.
} finally {
  presentation.destroy();
}
```

`Presentation` owns its context configuration and backing-size changes. It
preserves aspect ratio when fitting oversized requests to the device limit,
restores the original canvas size when destroyed, and never destroys its
borrowed device. `presentation.observe()` reports device-pixel size and pixel
ratio now and on every change of an HTML canvas (an `OffscreenCanvas` reports
once) while leaving scheduling and resize policy to the renderer:

```ts
const stop = presentation.observe((width, height, pixelRatio) => {
  presentation.resize(width, height);
});
// ...
stop();
```
