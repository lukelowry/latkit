import type {
  Camera2D,
  ContextMenu,
  FieldValues,
  Gpu,
  HoverState,
  Invalidation,
  Renderer,
  Shade,
} from '@latkit/gpu';
import type { ComponentOptions, ConnectionOptions, DiagramData, DiagramItem } from './data.js';
import type { Limits, Options } from './options.js';
/** A gesture identifies existing entities by stable domain ID; the host assigns connection roles. */
export interface ConnectionGesture {
  readonly from: { readonly component: string; readonly port?: string };
  readonly to: { readonly component: string; readonly port?: string } | null;
  readonly replaces?: {
    readonly connection: string;
    readonly endpoint: {
      readonly component: string;
      readonly port?: string;
      readonly role: string;
    };
  };
  readonly position: readonly [x: number, y: number];
  readonly point: readonly [x: number, y: number];
}
export interface DiagramEvents {
  readonly invalidate: Invalidation;
  readonly hover: DiagramItem | null;
  readonly select: readonly DiagramItem[];
  readonly contextmenu: ContextMenu<DiagramItem>;
  readonly open: DiagramItem;
  readonly connect: ConnectionGesture;
  /** Native indexed vector columns. Persist/re-key presentation state in the application. */
  readonly move: { readonly positions: Readonly<Record<string, FieldValues>> };
  /** Stable domain identities, ready for a model remove edit. No mutation is performed. */
  readonly delete: readonly string[];
  readonly fit: boolean;
}
export interface DiagramStats {
  readonly components: number;
  readonly connections: number;
  readonly endpoints: number;
  readonly geometryBytes: number;
  readonly pickingBytes: number;
  readonly prepareMs: number;
  readonly drawCalls: number;
  readonly frames: number;
  readonly hover: HoverState;
}
export interface Diagram extends Renderer {
  setData(data: DiagramData): void;
  setComponent(type: string, patch: Partial<ComponentOptions>): void;
  setConnection(type: string, patch: Partial<ConnectionOptions>): void;
  setOptions(options: Options): void;
  setShade(shade: Shade | null): Promise<void>;
  getCamera(): Camera2D | null;
  setCamera(camera: Camera2D, options?: { readonly animate?: boolean }): void;
  fit(options?: { readonly items?: readonly DiagramItem[]; readonly animate?: boolean }): void;
  reveal(item: DiagramItem, options?: { readonly animate?: boolean }): void;
  panBy(dx: number, dy: number): void;
  zoomBy(factor: number, anchor?: readonly [number, number]): void;
  select(items: readonly DiagramItem[]): void;
  setPointer(point: readonly [number, number] | null): void;
  hitTest(
    point: readonly [number, number],
    options?: { readonly radiusPx?: number },
  ): readonly DiagramItem[];
  locate(item: DiagramItem): readonly [number, number] | null;
  toDiagram(point: readonly [number, number]): readonly [number, number] | null;
  stats(): DiagramStats;
  on<K extends keyof DiagramEvents>(
    event: K,
    listener: (value: DiagramEvents[K]) => void,
  ): () => void;
}
export interface DiagramOptions {
  readonly gpu: Gpu;
  readonly data: DiagramData;
  readonly camera?: Camera2D;
  readonly options?: Options;
  readonly limits?: Limits;
  readonly shade?: Shade;
}
/** Native endpoints/topology, shared fields/scales/text/strokes, renderer-owned routing and layout. */
export declare function createDiagram(options: DiagramOptions): Diagram;
