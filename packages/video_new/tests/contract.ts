import { exportVideo, type VideoWrite } from '../src/index.js';
import type { Gpu, Renderer } from '@latkit/gpu';
export function usage(gpu: Gpu, renderer: Renderer, output: WritableStream<VideoWrite>) {
  return exportVideo({
    gpu,
    renderer,
    output,
    width: 1920,
    height: 1080,
    frameRate: 60,
    frames: 600,
    at: (frame) => 20 + frame / 60,
  });
}
