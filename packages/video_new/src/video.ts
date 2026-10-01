import type { RequestOptions } from '@latkit/model';
import type { Gpu, Renderer } from '@latkit/gpu';
/** Positional container writes, including header rewrites. Awaited writes apply backpressure. */
export interface VideoWrite {
  readonly position: number;
  readonly bytes: Uint8Array;
}
export interface Progress {
  readonly phase: 'rendering' | 'finalizing';
  readonly completedFrames: number;
  readonly totalFrames: number;
}
export interface VideoOptions extends RequestOptions {
  /** Borrowed; no hidden device acquisition or renderer construction. */
  readonly gpu: Gpu;
  /** Use a separate renderer for export to avoid sharing interactive view state. */
  readonly renderer: Renderer;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frames: number;
  /** Maps output frame number to a model coordinate. Omit for a static model view.
   * timeMs remains output time, computed from frame number rather than accumulated deltas. */
  readonly at?: (frame: number) => number;
  readonly format?: 'mp4' | 'webm';
  readonly quality?: 'medium' | 'high' | 'very-high' | number;
  readonly maxFramesInFlight?: number;
  /** Borrowed writer lease. Release the lock on every exit; never close/abort a caller-owned sink. */
  readonly output: WritableStream<VideoWrite>;
  readonly onProgress?: (progress: Progress) => void;
}
export interface VideoResult {
  readonly frames: number;
  readonly durationSeconds: number;
  readonly byteLength: number;
  readonly mediaType: string;
}
/** Same Renderer.prepare/encode path as the canvas. Owns only export targets and encoder resources.
 * Source retention is explicit at the application boundary; export never closes sources or renderer.
 * Workers construct their GPU/renderer locally and may consume connect-backed acquisitions. */
export declare function exportVideo(options: VideoOptions): Promise<VideoResult>;
