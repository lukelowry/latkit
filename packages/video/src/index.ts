/**
 * `@latkit/video` exports renderer-owned scenes as video. {@link exportVideo} owns the worker,
 * GPU composition, sample transport, encoder, and output lifecycle; the host supplies scenes
 * and optionally a destination.
 *
 * @packageDocumentation
 */

export { exportVideo } from './export.js';
export type { Options, Progress, Scene, VideoWrite } from './types.js';
