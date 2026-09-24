# @latkit/gpu

Core WebGPU device and canvas presentation primitives for Latkit.

`@latkit/gpu` handles the environmental part of requesting a device and then
returns the platform `GPUDevice` directly. It also provides the shared
presentation implementation and frame loop used by Latkit renderers. All exports
come from the single `@latkit/gpu` entrypoint.

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
once) while leaving scheduling and resize policy to the renderer, or to
`createFrameLoop()` below:

```ts
const stop = presentation.observe((width, height, pixelRatio) => {
  presentation.resize(width, height);
});
// ...
stop();
```

## Drive frames

`createFrameLoop()` schedules one canvas's frames: wakes coalesce into one animation frame, a
resize re-renders before the next paint, and the backing store grows in steps of 64 device pixels
while a resize is in flight and snaps exact once the size holds for three frames. `render`
receives the same `Frame` every call (read it, never keep it) and returns true to be called again
next frame:

```ts
import { createFrameLoop, createPresentation } from '@latkit/gpu';

const presentation = createPresentation(device, canvas);
const loop = createFrameLoop(presentation, ({ now, width, height, backingScale, settled }) => {
  // Draw the frame at width x height CSS pixels into presentation.context.getCurrentTexture().
  return animating(now); // true keeps frames coming; false waits for the next wake
});

loop.wake(); // after any change that should be drawn
loop.pause(); // while the view is hidden; resume() schedules a frame
loop.destroy(); // for good, and stop observing the canvas
```

Every size report after the synchronous first one renders a frame, woken or not, and that
includes the observer's initial notification: be ready to draw the current state once the loop
exists. A canvas without area skips its frame until a resize gives it one. A `render` that
pauses or destroys the loop stops it, and wakes while paused are dropped: `resume()` schedules
the next frame.

A renderer that repaints everything whenever the backing size changes gains nothing from those
steps and would repaint twice per resize (rounded up, then exact). It passes
`{ quantize: false }` so the backing store follows the exact size on every frame and `settled` is
always true:

```ts
const loop = createFrameLoop(presentation, render, { quantize: false });
```
