import { exportVideo, type VideoWrite } from '../src/index.js';
import type { View } from '@latkit/gpu';
export function usage(view: View, output: WritableStream<VideoWrite>) {
  return exportVideo(view, {
    output,
    width: 1920,
    height: 1080,
    frameRate: 60,
    duration: 10,
    at: (seconds) => 20 + seconds,
  });
}
