import type { Scene as NetworkScene } from '@latkit/network';
import type { Scene as DiagramScene } from '@latkit/diagram';
import type { Scene as MonitorScene } from '@latkit/monitor';

/** Renderer-owned scenes, normally obtained from a controller's snapshot(). */
export type Scene = NetworkScene | DiagramScene | MonitorScene;
/** Positional writes: a sink must honor position, including container header rewrites. */
export interface VideoWrite {
  readonly type: 'write';
  readonly position: number;
  readonly data: Uint8Array<ArrayBuffer>;
}
export interface Progress {
  readonly phase: 'rendering' | 'finalizing';
  readonly completedFrames: number;
  readonly totalFrames: number;
}
export interface Options {
  readonly views: readonly Scene[];
  /** Source time, in seconds. End is exclusive. */
  readonly timeRange: readonly [number, number];
  readonly width: number;
  readonly height: number;
  /** Output frames per second. Default 30. */
  readonly frameRate?: number;
  /** Source seconds per output second. Default 1. */
  readonly rate?: number;
  /** Equal panels. Default column. */
  readonly layout?: 'row' | 'column';
  /** Opaque background, RGB values in [0, 1]. */
  readonly background?: readonly [number, number, number];
  /** MP4 uses H.264; WebM uses VP9. Default mp4. */
  readonly format?: 'mp4' | 'webm';
  /** Quality preset, or target bits per second. Default high. */
  readonly quality?: 'medium' | 'high' | 'very-high' | number;
  /** Optional positional sink, e.g. a FileSystemWritableFileStream. Closed on success; abort requested on failure. */
  readonly output?: WritableStream<VideoWrite>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
}
