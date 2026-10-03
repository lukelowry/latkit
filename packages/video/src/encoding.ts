import { failure } from '@latkit/model';
import {
  canEncodeVideo,
  Mp4OutputFormat,
  WebMOutputFormat,
  Quality,
  Output,
  StreamTarget,
  VideoSampleSource,
  type VideoSample,
  type StreamTargetChunk,
} from 'mediabunny';
import type { settings } from './timing.js';
export async function encoding(config: ReturnType<typeof settings>) {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof OffscreenCanvas === 'undefined'
  )
    throw failure('unavailable', 'Video export requires WebCodecs and OffscreenCanvas');
  const codec: 'avc' | 'vp9' = config.format === 'mp4' ? 'avc' : 'vp9';
  const options = {
    codec,
    quality: new Quality(
      config.bitrate === undefined ? config.quality : { bitrate: config.bitrate },
    ),
    keyFrameInterval: 1,
    latencyMode: 'quality' as const,
    hardwareAcceleration: 'no-preference' as const,
    alpha: 'discard' as const,
  };
  if (
    !(await canEncodeVideo(codec, {
      ...options,
      width: config.width,
      height: config.height,
      frameRate: config.frameRate,
    }))
  )
    throw failure(
      'unavailable',
      `Cannot encode ${config.format} at ${config.width}x${config.height}, ${config.frameRate} fps`,
    );
  let output: Output | undefined, source: VideoSampleSource | undefined;
  return {
    open(stream: WritableStream<StreamTargetChunk>) {
      output = new Output({
        // Fragments bound MP4 media/metadata storage independently of total duration.
        format:
          config.format === 'mp4'
            ? new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 })
            : new WebMOutputFormat({ minimumClusterDuration: 1 }),
        target: new StreamTarget(stream, { chunked: true, chunkSize: 256 * 1024 }),
      });
      source = new VideoSampleSource(options);
      // Track frameRate quantizes durations, including the shorter final frame. Preserve explicit sample timing.
      output.addVideoTrack(source);
    },
    start: () => output!.start(),
    // Awaited add bounds the library's encoder queue (four frames) and propagates write pressure.
    add: (sample: VideoSample, keyFrame: boolean) => source!.add(sample, { keyFrame }),
    async finish() {
      source!.close();
      await output!.finalize();
    },
    async cancel() {
      await output?.cancel();
    },
  };
}
