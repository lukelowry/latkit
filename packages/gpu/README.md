# @latkit/gpu

What every Latkit renderer shares: Core WebGPU devices and the pool they are leased from, canvas
presentation, the frame loop, the attach lifecycle, the channels a renderer binds values and series
to, the colormap lookup texture, and controller events.

`@latkit/gpu` handles the environmental part of requesting a device and then returns the platform
`GPUDevice` directly. Applications rarely import it beyond the device pool; a renderer is built on
the rest. All exports come from the single `@latkit/gpu` entrypoint.

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

## Attach a controller

`createAttachment()` is the attach lifecycle every Latkit controller shares: supersession, joining a
repeat attach, and recovery on a replacement device, as the [lifecycle guide](https://latkit.readthedocs.io/en/latest/lifecycle.html)
describes. A renderer supplies what one binding builds and what its release forgets:

```ts
import { createAttachment, devices } from '@latkit/gpu';

const attachment = createAttachment({
  devices,
  bind(device, canvas, cleanup) {
    const presentation = createPresentation(device, canvas);
    cleanup(() => presentation.destroy()); // cleanups run in reverse on release
    return presentation;
  },
  release: (presentation) => {}, // before the cleanups
  attached: (bound) => emit('attached', bound),
  lost: (loss) => emit('deviceLost', loss),
});

await attachment.attach(canvas); // false when a newer attach or a detach took over
attachment.detach(canvas); // only while `canvas` is the current one
```

## Bind channels

`createChannels()` is the channel binder every renderer's `setChannel` runs on. A renderer hands it
its registry (each channel's scope, components, whether it is normalized, and whether it can follow
a series), the store its shaders read (`reserve` and `writeWords`), and how a channel's record
reaches its uniforms: the word its values start at, whether it is bound, and the
`(value - min) * scale` its values map through.

```ts
import { createChannels } from '@latkit/gpu';

const channels = createChannels<Channel, 'vertex' | 'edge'>({
  name: 'network',
  structure: 'topology',
  channels: CHANNELS,
  store: () => renderer, // null while detached: the CPU keeps every value, and upload() restores it
  record: (channel, offset, bound, min, scale) => writeUniforms(channel, offset, bound, min, scale),
  shown: () => loop.wake(), // a followed channel shows another frame
  error: (channel, cause) => emit('error', { channel, cause }),
});

channels.load({ vertex: vertexCount, edge: edgeCount }); // a slot per channel
channels.set('vertexColor', values, [0, 1]);
channels.set('vertexHeight', { series, signal: 0 }); // follows the signal; the domain follows its range
channels.seek(t); // every followed channel at the playhead
```

Every channel owns a slot for as long as a load holds, so binding one is one write and never a
relayout. A followed signal's frames stay resident in a window of the store after the slots, shared
by every channel following that signal, and the next ones load as the playhead advances or the
series appends, so a seek within them rewrites one word per channel.

## Colormaps and events

`bakeColormap(colormap)` samples a `Colormap` into `COLORMAP_LUT_SIZE` opaque rgba8 texels, the
lookup texture every renderer's shaders map normalized values through. `createEmitter()` is the
typed event dispatcher behind every controller's `on`: listeners run in order, and one that throws
rethrows on a microtask while the rest still run.

## Render targets

`RenderTarget` is a device, format, dimensions, and `texture()` for the next frame. `Presentation` implements it for a canvas; `createRenderTarget(device, width, height)` owns a fixed texture for offscreen composition. Destroy a fixed target after the renderers borrowing it are destroyed. `SceneRenderer.prepare(sourceTime, signal)` waits for channel samples; `draw(outputTimeMs)` advances visual animation. These are the shared primitives used by `@latkit/video`.
