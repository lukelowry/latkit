import { failure } from '@latkit/model';

/** Whether bytes begin as gzip does. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gzipped bytes, decompressed. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw failure('unsupported', 'This runtime cannot decompress gzip');
  try {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw failure('protocol', 'The bytes are not valid gzip', { cause: error });
  }
}

/** Bytes as they are, or decompressed where they are gzipped. */
export function ungzipped(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array {
  return isGzip(bytes) ? gunzip(bytes) : bytes;
}
