/* global GPUTextureUsage, GPUBufferUsage, GPUMapMode, requestAnimationFrame */
import { createSeries, bakeColormap } from '../../model/src/index.ts';
import { LanePainter } from '../src/painter.ts';
import { Lane } from '../src/lane.ts';

/** Real GPU pixel checks, run by examples/monitor/check.html. */
export async function checkGpu() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('WebGPU unavailable');
  const device = await adapter.requestDevice();
  try {
    const errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    device.pushErrorScope('validation');
    const checks = [];
    async function render(
      values,
      options = {},
      elementCount = 1,
      selected = null,
      time = [0, 1],
      map = (t) => [t, t, t],
    ) {
      const output = device.createTexture({
        size: [128, 128],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const painter = new LanePainter(
        { device, context: { getCurrentTexture: () => output }, format: 'rgba8unorm' },
        128,
        128,
      );
      painter.writeColormap(bakeColormap(map));
      const series = createSeries({
        elementCount,
        signalCount: 1,
        time: Float64Array.from(time),
        values: Float64Array.from(values),
      });
      let lane;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('render timeout')), 5000);
        lane = new Lane(
          series,
          0,
          painter,
          {
            valueRange: [0, 1],
            timeRange: [0, 1],
            colorRange: null,
            lineWidth: 3,
            focusColor: [1, 0, 0, 1],
            unselectedAlpha: 0.2,
            ...options,
          },
          { frames: 0, range: null },
          {
            error: reject,
            range() {},
            rendered() {
              clearTimeout(timeout);
              resolve();
            },
            present() {
              requestAnimationFrame(() => lane.frame());
            },
          },
        );
        lane.select(selected);
        lane.resume();
      });
      const buffer = device.createBuffer({
        size: 128 * 128 * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 512 }, [128, 128]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(buffer.getMappedRange()).slice();
      buffer.unmap();
      buffer.destroy();
      lane.destroy();
      painter.destroy();
      output.destroy();
      return {
        pixel(x, y) {
          return [...pixels.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
        },
        count: pixels.filter((_, i) => i % 4 === 3 && pixels[i] > 0).length,
      };
    }
    function check(name, okay, detail) {
      if (!okay) throw Error(name + ': ' + JSON.stringify(detail));
      checks.push({ name, detail });
    }
    let image = await render([0.5, 0.5], { colorRange: [0, 2] });
    let pixel = image.pixel(64, 64);
    check(
      'independent color and value ranges',
      pixel[0] >= 62 && pixel[0] <= 66 && pixel[3] === 255,
      pixel,
    );
    image = await render(
      [1e12 + 0.25, 1e12 + 0.75],
      { valueRange: [1e12, 1e12 + 1], timeRange: [1e12, 1e12 + 1] },
      1,
      null,
      [1e12 + 0.25, 1e12 + 0.75],
    );
    pixel = image.pixel(64, 63);
    check(
      'f64 values and timestamps retain visible differences',
      pixel[3] > 200 && image.count > 50,
      pixel,
    );
    image = await render([2, 2]);
    check('outside samples do not flatten onto the axis', image.count === 0, image.count);
    image = await render([-1, 2]);
    check(
      'clipped crossings remain visible',
      image.pixel(64, 63)[3] > 200 && image.count > 100,
      image.pixel(64, 63),
    );
    image = await render([NaN, 0.5]);
    check('missing samples break traces', image.count === 0, image.count);
    image = await render([0.25, 0.75, 0.25, 0.75], {}, 2, 0);
    const selected = image.pixel(64, 96),
      other = image.pixel(64, 32);
    check(
      'focus stays opaque while history dims',
      selected[0] === 255 && selected[3] === 255 && other[3] >= 49 && other[3] <= 53,
      { selected, other },
    );
    image = await render([-1e308, 1e308], { valueRange: [-1e308, 1e308] });
    check(
      'overflowing f64 spans normalize before upload',
      image.pixel(64, 63)[3] > 200,
      image.pixel(64, 63),
    );
    image = await render([0, 1], {}, 1, null, [0, 1], (t) => [t * t, 0, 0]);
    pixel = image.pixel(64, 63);
    check(
      'nonlinear palette follows interpolated sample values',
      pixel[0] >= 62 && pixel[0] <= 68 && pixel[1] === 0,
      pixel,
    );
    image = await render([-1, 2]);
    pixel = image.pixel(53, 95);
    check(
      'clipping preserves absolute color coordinates',
      pixel[0] >= 62 && pixel[0] <= 68 && pixel[3] > 240,
      pixel,
    );
    image = await render([0.5, 0.5], { focusColor: [1, 0, 0, 0.5], unselectedAlpha: 0 }, 1, 0);
    pixel = image.pixel(64, 64);
    check(
      'focus respects RGBA opacity',
      pixel[0] >= 126 && pixel[0] <= 129 && pixel[3] >= 126 && pixel[3] <= 129,
      pixel,
    );
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    check('WebGPU validation', errors.length === 0, errors);
    return checks;
  } finally {
    device.destroy();
  }
}
