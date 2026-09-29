import { protocol } from '@latkit/port';
import type { Config } from './config.js';
import type { WireScene } from './scenes.js';
import type { Progress, VideoWrite } from './types.js';
export const writes = protocol<VideoWrite, void>('video-output');
export type Request =
  | {
      readonly kind: 'start';
      readonly config: Config;
      readonly views: readonly WireScene[];
      readonly seriesCount: number;
      readonly streaming: boolean;
    }
  | { readonly kind: 'cancel' };
export type Response =
  | { readonly kind: 'progress'; readonly progress: Progress }
  | { readonly kind: 'done'; readonly buffer?: ArrayBuffer }
  | { readonly kind: 'error'; readonly name: string; readonly message: string };
