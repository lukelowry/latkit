import type { kit } from '@latkit/gpu';
import type { VideoProgress, VideoResult } from '@latkit/video';
import type { ExampleView } from './scene.js';
export interface ExportRequest {
  readonly kind: 'export';
  readonly view: ExampleView;
  readonly format: 'mp4' | 'webm';
  readonly filename: string;
  readonly duration: number;
}
export interface ExportResult {
  readonly kind: 'done';
  readonly result: VideoResult;
  readonly filename: string;
  readonly elapsedMs: number;
  readonly gpu: kit.GpuStats;
}
export type WorkerRequest = ExportRequest | { readonly kind: 'cancel' };
export type WorkerResult = ExportResult | { readonly kind: 'error'; readonly message: string };
export type WorkerReply =
  WorkerResult | { readonly kind: 'progress'; readonly progress: VideoProgress };
