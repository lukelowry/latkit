import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny';
export async function verify(blob: Blob, width: number, height: number, duration: number) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || track.displayWidth !== width || track.displayHeight !== height)
      throw new Error('Invalid video dimensions');
    const actual = (await input.getDurationFromMetadata()) ?? (await input.computeDuration());
    if (Math.abs(actual - duration) > 0.003) throw new Error(`Invalid duration: ${actual}`);
    const sink = new VideoSampleSink(track);
    const canvas = new OffscreenCanvas(320, 180),
      context = canvas.getContext('2d', { willReadFrequently: true })!;
    let first: Uint8ClampedArray | undefined,
      changed = false;
    for (const at of [0, duration * 0.5, duration - 1 / 30]) {
      const sample = await sink.getSample(at);
      if (!sample) throw new Error(`Undecodable frame at ${at}`);
      try {
        sample.draw(context, 0, 0, 320, 180);
        const pixels = context.getImageData(0, 0, 320, 180).data;
        let minimum = 255,
          maximum = 0,
          difference = 0;
        for (let i = 0; i < pixels.length; i++)
          if (i % 4 !== 3) {
            minimum = Math.min(minimum, pixels[i]!);
            maximum = Math.max(maximum, pixels[i]!);
            if (first) difference += Math.abs(pixels[i]! - first[i]!);
          }
        if (maximum - minimum < 20) throw new Error('Blank video frame');
        if (first) changed ||= difference / pixels.length > 0.01;
        else first = pixels;
      } finally {
        sample.close();
      }
    }
    if (!changed) throw new Error('Video did not animate');
    return { width, height, duration: actual, decoded: 3 };
  } finally {
    input.dispose();
  }
}
