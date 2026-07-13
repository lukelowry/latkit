# @latkit/gpu

Shared Core WebGPU device acquisition for Latkit.

`@latkit/gpu` gives one part of an application explicit ownership of a logical
GPU device while allowing renderers in the same browser realm to borrow it. It
does not configure canvases or manage renderer resources.

## Install

```sh
npm install @latkit/gpu
```

## Create a device

```ts
import { createGpu } from '@latkit/gpu';

const gpu = await createGpu();

try {
  console.log(gpu.device.limits);
  console.log(gpu.format);

  void gpu.device.lost.then((info) => {
    console.error('GPU device lost:', info.reason, info.message);
  });
} finally {
  gpu.destroy();
}
```

`createGpu()` requests Core WebGPU and leaves the adapter power preference to
the browser. Pass `powerPreference` only when the application has a specific
reason to override that choice:

```ts
const gpu = await createGpu({ powerPreference: 'high-performance' });
```

## Handle availability

```ts
import { createGpu, GpuUnavailableError } from '@latkit/gpu';

try {
  const gpu = await createGpu();

  try {
    // Use gpu.device while the owner remains alive.
  } finally {
    gpu.destroy();
  }
} catch (error) {
  if (error instanceof GpuUnavailableError) {
    console.error(`WebGPU unavailable at ${error.stage}:`, error.message);
  } else {
    throw error;
  }
}
```

Only expected API, adapter, device, and canvas-context availability failures
use `GpuUnavailableError`. Programming and validation failures are not
reclassified.
