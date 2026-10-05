/** Copy exactly the source range accepted by queue.writeBuffer. */
export function copyUpload(
  data: Parameters<GPUQueue['writeBuffer']>[2],
  dataOffset = 0,
  size?: number,
): Uint8Array {
  const view = ArrayBuffer.isView(data),
    unit = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1,
    bytes = view
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data),
    elements = bytes.byteLength / unit,
    count = size ?? elements - dataOffset;
  if (
    !Number.isSafeInteger(dataOffset) ||
    !Number.isSafeInteger(count) ||
    dataOffset < 0 ||
    count < 0 ||
    dataOffset > elements ||
    count > elements - dataOffset
  )
    throw new RangeError('Invalid upload source range');
  if ((count * unit) % 4) throw new RangeError('Upload size must be a multiple of four bytes');
  return bytes.slice(dataOffset * unit, (dataOffset + count) * unit);
}

/** A WebGPU device that does no GPU work: benchmarks time the JavaScript a frame costs. */
export function nullDevice(): GPUDevice {
  Object.assign(globalThis, {
    GPUBufferUsage: bits(
      'MAP_READ MAP_WRITE COPY_SRC COPY_DST INDEX VERTEX UNIFORM STORAGE INDIRECT QUERY_RESOLVE',
    ),
    GPUTextureUsage: bits('COPY_SRC COPY_DST TEXTURE_BINDING STORAGE_BINDING RENDER_ATTACHMENT'),
    GPUShaderStage: bits('VERTEX FRAGMENT COMPUTE'),
    GPUMapMode: bits('READ WRITE'),
  });
  // Encoders and passes accept any call; everything else is a distinct object, as on a real device.
  const sink: object = new Proxy(
    {},
    { get: (_, key) => (key === 'then' ? undefined : () => sink) },
  );
  const done = Promise.resolve();
  return {
    limits: {
      maxBufferSize: 1 << 30,
      maxStorageBufferBindingSize: 1 << 30,
      maxStorageBuffersPerShaderStage: 10,
      maxUniformBufferBindingSize: 65536,
      minStorageBufferOffsetAlignment: 256,
      minUniformBufferOffsetAlignment: 256,
      maxTextureDimension1D: 8192,
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    features: new Set(),
    lost: new Promise(() => {}),
    queue: {
      // Copies as a real queue does, so upload cost stays in the measurement.
      writeBuffer: (
        _buffer: GPUBuffer,
        _offset: number,
        data: Parameters<GPUQueue['writeBuffer']>[2],
        dataOffset = 0,
        size?: number,
      ) => void copyUpload(data, dataOffset, size),
      writeTexture() {},
      copyExternalImageToTexture() {},
      submit() {},
      onSubmittedWorkDone: () => done,
    },
    createBuffer: ({ size, usage }: GPUBufferDescriptor) => ({
      size,
      usage,
      destroy() {},
      mapAsync: () => done,
      getMappedRange: () => new ArrayBuffer(size),
      unmap() {},
    }),
    createTexture: ({ size, format, usage, sampleCount }: GPUTextureDescriptor) => {
      const [width, height = 1, depthOrArrayLayers = 1] = size as number[];
      return {
        width,
        height,
        depthOrArrayLayers,
        format,
        usage,
        sampleCount: sampleCount ?? 1,
        destroy() {},
        createView: () => ({}),
      };
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createSampler: () => ({}),
    createQuerySet: () => ({ destroy() {} }),
    createCommandEncoder: () => sink,
    pushErrorScope() {},
    popErrorScope: async () => null,
    addEventListener() {},
    removeEventListener() {},
    destroy() {},
  } as unknown as GPUDevice;
}
const bits = (names: string) =>
  Object.fromEntries(names.split(' ').map((name, i) => [name, 1 << i]));
