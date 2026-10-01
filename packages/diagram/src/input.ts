import type { Diagram } from './diagram.js';
export interface InputOptions {
  readonly diagram: Diagram;
  readonly canvas: HTMLCanvasElement;
  readonly interaction?: 'edit' | 'navigate' | 'inspect' | 'none';
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
/** Uses shared GPU DOM primitives. Editing gestures emit proposals with stable domain identities. */
export declare function attachDiagramInput(options: InputOptions): () => void;
