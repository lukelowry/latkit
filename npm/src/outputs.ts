/** Written by `node npm/build.mjs schema` from `npm/schema.json`, what latkit writes: do not edit. */

import type { Camera, Row, Rows } from './inputs.js';

/**
 * What a dataset holds: its tables, their rows and fields, and the axis its sampled fields are
 * recorded over and span.
 */
export interface Description {
  /** The dataset's name. */
  name: string;
  /** The axis's name and unit. */
  axis: [string, string] | null;
  /** The first and last coordinates its sampled fields hold. */
  span: [number, number] | null;
  /** Its tables, by name. */
  tables: TableDescription[];
}

/** What the user acts with. */
export type Device = 'mouse' | 'pen' | 'touch' | 'keyboard';

/** A vertex a connection ends at, and its port when it has the one the connection meets. */
export interface End {
  /** The vertex. */
  row: Row;
  /** The port, by the reference field naming its net. */
  port?: string;
}

/**
 * What failed: its `code`, the message, and for invalid input the `path` to the part, such as
 * `marks[2].color`.
 */
export interface Failure {
  code: 'invalid' | 'unsupported' | 'limit' | 'io' | 'device-lost' | 'cancelled' | 'timeout';
  message: string;
  path?: string;
}

/** A field described: what it holds, the table a reference names, the coordinates samples span. */
export interface FieldDescription {
  /** The field's name. */
  name: string;
  /** What it holds. */
  kind: Kind;
  /** The table a reference names. */
  to?: string;
  /** The first and last coordinates a sampled field holds. */
  span?: [number, number];
}

/** A row under a point, as the frame drew it. */
export interface Hit {
  /** The row. */
  row: Row;
  /** The name of the mark that drew it, when it has one: what tells two marks of one table apart. */
  mark?: string;
  /** The point of the row nearest the probe, CSS pixels from the top left. */
  point: [number, number];
  /** That point in the space's coordinates: x, y, and elevation. */
  position: [number, number, number];
  /** CSS pixels from the probe to the row. */
  distance: number;
  /** The port hit, when a vertex's port was. */
  port?: string;
  /** The sample hit, when a line tracing a sampled field was. */
  sample?: Sample;
}

/** What a field holds. */
export type Kind =
  'number' | 'bool' | 'text' | 'point' | 'path' | 'parts' | 'polygons' | 'reference' | 'sampled';

/** Keys held during an input. */
export interface Modifiers {
  /** Shift. */
  shift: boolean;
  /** Control. */
  control: boolean;
  /** Alt or Option. */
  alt: boolean;
  /** Meta: Command or Windows. */
  meta: boolean;
}

/** The phase of a `Drag`. */
export type Phase = 'start' | 'move' | 'end';

/** A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value. */
export interface Sample {
  /** The frame, numbered from the first ever recorded. */
  frame: number;
  /** The axis coordinate. */
  at: number;
  /** The value. */
  value: number;
}

/** What a view does each frame. */
export interface Stats {
  /** Frames rendered. */
  frames: number;
  /** Rows of every mark's table. */
  rows: number;
  /**
   * Rows every mark draws: every row of a table drawn whole, the rows of the tiles in view of one
   * drawn through tiles.
   */
  drawn: number;
  /** Draw calls the last frame recorded, shadows and labels with the marks. */
  draws: number;
  /**
   * Instances the last frame's draws drew: points, segments, triangles, glyphs; at most, for
   * segments the GPU culls.
   */
  instances: number;
  /** Fetched tiles the view draws, of every tile source. */
  tiles: number;
  /** Tiles being fetched or decoded, of every tile source. */
  tilesLoading: number;
  /** Bytes of data waiting to upload. */
  uploading: number;
  /** Bytes of data pages on the GPU, for every view of its `Gpu`. */
  resident: number;
  /** Bytes the GPU's `Budget` lets data take. */
  budget: number;
  /**
   * The work under way the last frame stood in for; nothing when it drew everything as the data,
   * scene, and camera say: see `View::complete`.
   */
  waiting: Waiting;
  /** Milliseconds the last frame took to record on the CPU. */
  cpuMs: number;
  /**
   * Milliseconds the GPU takes on a frame: the median of the last frames it measured; 0 where the
   * device cannot measure.
   */
  gpuMs: number;
}

/** A table described: its rows, and its fields by name. */
export interface TableDescription {
  /** The table's name. */
  name: string;
  /** How many rows it has. */
  rows: number;
  /** Its fields, by name. */
  fields: FieldDescription[];
}

/**
 * Where, with what keys, and with what the user acted. For keys, the point is the row they point
 * at, else the pointer, else the view's middle.
 */
export interface Trigger {
  /** CSS pixels from the top left. */
  point: [number, number];
  /** The keys held. */
  modifiers: Modifiers;
  /** What acted. */
  device: Device;
}

/**
 * A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as
 * nested `[x, y]` points; a reference as the id of the row it names.
 */
export type Value = number | boolean | string | null | [number, number] | unknown[][];

/** What happened in a view, for the application to act on. Drain them with `View::events`. */
export type ViewEvent =
  | {
      type: 'click';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user clicked it. */
        trigger: Trigger;
      };
    }
  | {
      type: 'open';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user opened it. */
        trigger: Trigger;
      };
    }
  | {
      type: 'menu';
      detail: {
        /** What lies under the point, nearest first. */
        hits: Hit[];
        /** How the user asked. */
        trigger: Trigger;
      };
    }
  | {
      type: 'drag';
      detail: {
        /** Whether the drag starts, moves, or ends. */
        phase: Phase;
        /** The row dragged, as it was hit. */
        hit: Hit;
        /** The point under the pointer at the depth the drag started, in the space's coordinates. */
        position: [number, number, number];
        /** The pointer. */
        trigger: Trigger;
      };
    }
  | {
      type: 'connect';
      detail: {
        /** The end it was drawn from: for an edge, the end that stayed. */
        from: End;
        /** The vertex it was released over, if any. */
        to: End | null;
        /** The edge whose other end was dragged, which `to` replaces. */
        edge: Row | null;
        /** Where it was released. */
        trigger: Trigger;
      };
    }
  | {
      type: 'delete';
      detail: {
        /** The rows selected. */
        rows: Rows[];
        /** The key. */
        trigger: Trigger;
      };
    }
  | {
      type: 'hover';
      detail: {
        /** The row now pointed at; `null` once it left every row. */
        hit: Hit | null;
        /** The pointer, or the keys. */
        trigger: Trigger;
      };
    }
  | {
      type: 'select';
      detail: {
        /** The rows selected now. */
        rows: Rows[];
        /** How the user changed it; `null` when the data dropped rows from it. */
        trigger: Trigger | null;
      };
    }
  | { type: 'camera'; detail: Camera }
  | { type: 'waiting'; detail: Waiting }
  | { type: 'error'; detail: Failure };

/**
 * Work under way a frame stands in for: pages uploading or tables not yet built from them
 * (`data`); layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); a label placement or
 * texts not yet set (`labels`); a fit due or being measured (`fit`); row regions laid out again,
 * segment counts, or a transition beginning (`marks`). Empty once a frame is complete.
 */
export type Waiting = ('data' | 'derived' | 'labels' | 'fit' | 'marks')[];

/** What a `Gpu` did since it was made; subtract two for what happened between. */
export interface Work {
  /** Bytes of data pages uploaded. */
  uploaded: number;
  /** Bytes written besides pages: uniforms, programs, label runs, the selection, textures. */
  written: number;
  /** Rows whose channels the GPU evaluated. */
  evaluated: number;
  /**
   * Reads back from the GPU: probes, queries, fits, label placements, segment counts, pictures; not
   * the frame timer's, which only some devices have.
   */
  readbacks: number;
  /**
   * Jobs handed out: layouts, routes, lanes, triangulations, pyramids, tiles; to the host's workers,
   * or done at once without a host.
   */
  jobs: number;
  /** Label texts the host was asked to set. */
  texts: number;
  /** Pipelines made. */
  pipelines: number;
}
