import type { AdapterEvidence, WebGpuFeatureLevel } from './protocol.js';

const LIMIT_NAMES = [
  'maxTextureDimension2D',
  'maxBufferSize',
  'maxVertexBuffers',
  'maxVertexAttributes',
  'maxVertexBufferArrayStride',
  'maxBindGroups',
  'maxUniformBufferBindingSize',
  'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
  'maxStorageBuffersInVertexStage',
  'maxColorAttachments',
] as const satisfies readonly (keyof GPUSupportedLimits)[];

const ADAPTER_INFO_NAMES = ['vendor', 'architecture', 'device', 'description'] as const;

const PROBE_SHADER = /* wgsl */ `
struct Tint {
  value: vec4f,
}

struct VertexInput {
  @location(0) position: vec2f,
  @location(1) offset: vec2f,
}

@group(0) @binding(0) var<uniform> tint: Tint;
@group(0) @binding(1) var probe_texture: texture_2d<f32>;
@group(0) @binding(2) var probe_sampler: sampler;

@vertex
fn vs(input: VertexInput) -> @builtin(position) vec4f {
  return vec4f(input.position + input.offset, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return tint.value * textureSample(probe_texture, probe_sampler, vec2f(0.5));
}
`;

export function emptyAdapterEvidence(requestedFeatureLevel: WebGpuFeatureLevel): AdapterEvidence {
  return {
    requestedFeatureLevel,
    effectiveFeatureLevel: null,
    adapterAvailable: false,
    deviceAvailable: false,
    fallback: null,
    info: {},
    features: [],
    limits: {},
    renderProbe: 'not-run',
    error: null,
  };
}

export function evidenceFromDevice(
  requestedFeatureLevel: WebGpuFeatureLevel,
  device: GPUDevice,
): AdapterEvidence {
  return {
    requestedFeatureLevel,
    effectiveFeatureLevel: device.features.has('core-features-and-limits')
      ? 'core'
      : 'compatibility',
    adapterAvailable: true,
    deviceAvailable: true,
    fallback: device.adapterInfo.isFallbackAdapter,
    info: adapterInfoRecord(device.adapterInfo),
    features: [...device.features].sort(),
    limits: limitRecord(device.limits),
    renderProbe: 'not-run',
    error: null,
  };
}

export async function probeCompatibility(gpu: GPU | undefined): Promise<AdapterEvidence> {
  if (!gpu) return emptyAdapterEvidence('compatibility');

  let adapter: GPUAdapter | null = null;
  let device: GPUDevice | null = null;
  try {
    adapter = await gpu.requestAdapter({ featureLevel: 'compatibility' });
    if (!adapter) return emptyAdapterEvidence('compatibility');

    device = await adapter.requestDevice();
    const effectiveFeatureLevel: WebGpuFeatureLevel = adapter.features.has(
      'core-features-and-limits',
    )
      ? 'core'
      : 'compatibility';

    await runCompatibilityRenderProbe(device);
    return {
      requestedFeatureLevel: 'compatibility',
      effectiveFeatureLevel,
      adapterAvailable: true,
      deviceAvailable: true,
      fallback: adapter.info.isFallbackAdapter,
      info: adapterInfoRecord(adapter.info),
      features: [...adapter.features].sort(),
      limits: limitRecord(adapter.limits),
      renderProbe: 'passed',
      error: null,
    };
  } catch (error) {
    return {
      requestedFeatureLevel: 'compatibility',
      effectiveFeatureLevel: adapter
        ? adapter.features.has('core-features-and-limits')
          ? 'core'
          : 'compatibility'
        : null,
      adapterAvailable: adapter !== null,
      deviceAvailable: device !== null,
      fallback: adapter?.info.isFallbackAdapter ?? null,
      info: adapter ? adapterInfoRecord(adapter.info) : {},
      features: adapter ? [...adapter.features].sort() : [],
      limits: adapter ? limitRecord(adapter.limits) : {},
      renderProbe: device ? 'failed' : 'not-run',
      error: errorMessage(error),
    };
  } finally {
    device?.destroy();
  }
}

function adapterInfoRecord(info: GPUAdapterInfo): Readonly<Record<string, string>> {
  return Object.fromEntries(
    ADAPTER_INFO_NAMES.flatMap((name) => {
      const value = info[name];
      return value.length > 0 ? [[name, value] as const] : [];
    }),
  );
}

function limitRecord(limits: GPUSupportedLimits): Readonly<Record<string, number>> {
  return Object.fromEntries(
    LIMIT_NAMES.flatMap((name) => {
      const value = limits[name];
      return typeof value === 'number' ? [[name, value] as const] : [];
    }),
  );
}

async function runCompatibilityRenderProbe(device: GPUDevice): Promise<void> {
  let vertexBuffer: GPUBuffer | null = null;
  let instanceBuffer: GPUBuffer | null = null;
  let uniformBuffer: GPUBuffer | null = null;
  let readbackBuffer: GPUBuffer | null = null;
  let sampledTexture: GPUTexture | null = null;
  let targetTexture: GPUTexture | null = null;

  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let failure: unknown;

  try {
    const shader = device.createShaderModule({ label: 'compatibility-probe', code: PROBE_SHADER });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'compatibility-probe',
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
          {
            arrayStride: 8,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    vertexBuffer = createBufferWithData(
      device,
      'compatibility-probe-vertices',
      GPUBufferUsage.VERTEX,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
    );
    instanceBuffer = createBufferWithData(
      device,
      'compatibility-probe-instance',
      GPUBufferUsage.VERTEX,
      new Float32Array([0, 0]),
    );
    uniformBuffer = createBufferWithData(
      device,
      'compatibility-probe-uniform',
      GPUBufferUsage.UNIFORM,
      new Float32Array([0.25, 0.5, 0.75, 1]),
    );

    sampledTexture = device.createTexture({
      label: 'compatibility-probe-sampled-texture',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      textureBindingViewDimension: '2d',
    });
    device.queue.writeTexture(
      { texture: sampledTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    targetTexture = device.createTexture({
      label: 'compatibility-probe-target',
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    readbackBuffer = device.createBuffer({
      label: 'compatibility-probe-readback',
      size: 256 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const bindGroup = device.createBindGroup({
      label: 'compatibility-probe',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampledTexture.createView() },
        { binding: 2, resource: device.createSampler() },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'compatibility-probe' });
    const pass = encoder.beginRenderPass({
      label: 'compatibility-probe',
      colorAttachments: [
        {
          view: targetTexture.createView(),
          clearValue: [0, 0, 0, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setVertexBuffer(1, instanceBuffer);
    pass.draw(3, 1);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: targetTexture },
      { buffer: readbackBuffer, bytesPerRow: 256, rowsPerImage: 4 },
      { width: 4, height: 4 },
    );
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const pixel = new Uint8Array(readbackBuffer.getMappedRange(), 0, 4);
    if (pixel[0] < 48 || pixel[1] < 96 || pixel[2] < 144 || pixel[3] < 240) {
      throw new Error(`Compatibility render probe returned [${pixel.join(', ')}]`);
    }
    readbackBuffer.unmap();
  } catch (error) {
    failure = error;
  } finally {
    const validationError = await device.popErrorScope();
    const outOfMemoryError = await device.popErrorScope();
    vertexBuffer?.destroy();
    instanceBuffer?.destroy();
    uniformBuffer?.destroy();
    readbackBuffer?.destroy();
    sampledTexture?.destroy();
    targetTexture?.destroy();

    failure ??= validationError ?? outOfMemoryError;
  }

  if (failure) throw failure instanceof Error ? failure : new Error(errorMessage(failure));
}

function createBufferWithData(
  device: GPUDevice,
  label: string,
  usage: GPUBufferUsageFlags,
  data: Float32Array,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
