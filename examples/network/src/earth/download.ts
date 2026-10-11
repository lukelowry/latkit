export type Progress = (message: string) => void;

/** A file's bytes, reporting progress, and inflated where it arrives gzip-compressed. */
export async function download(
  url: string,
  signal: AbortSignal,
  progress: Progress,
): Promise<{ readonly buffer: ArrayBuffer; readonly received: number }> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0,
    reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // A compressed response's length counts fewer bytes than arrive.
    progress(
      `downloading ${(received / 1e6).toFixed(1)}${total >= received ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB`,
    );
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  // A server may have inflated it on the way already.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { buffer: bytes.buffer, received };
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return { buffer: await new Response(inflated).arrayBuffer(), received };
}
