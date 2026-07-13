# @latkit/gpu

Native Core WebGPU device acquisition for Latkit.

`@latkit/gpu` handles the environmental part of requesting a device and then
returns the platform `GPUDevice` directly. The caller owns that device. Canvas
configuration and renderer resources remain with the rendering packages.

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
