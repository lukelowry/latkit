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
borrowed device. `observeCanvas()` provides device-pixel sizes and pixel ratio
for an HTML canvas while leaving scheduling and resize policy to the renderer.
