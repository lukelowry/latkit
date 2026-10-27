/** The types latkit writes, written by `node npm/build.mjs schema` from `npm/schema.json`. Do not edit. */

import type { Camera, Id, Row, Rows } from './inputs.js';

/**
 * A summary of a dataset: its tables with their rows and fields, the axis sampled fields are
 * recorded over, and the part of the axis they cover.
 */
export interface Description {
  /** The dataset's name. */
  name: string;
  /** The axis name and unit, if set. */
  axis: [string, string] | null;
  /** The first and last axis coordinates held by any sampled field, or `null` if no field holds any. */
  span: [number, number] | null;
  /** Its tables, sorted by name. */
  tables: TableDescription[];
}

/** The input device. */
export type Device =
  | /** A mouse or a trackpad. */ 'mouse'
  | /** A pen. */ 'pen'
  | /** A finger. Picks find rows up to 8 CSS pixels farther away. */ 'touch'
  | /** The keyboard. */ 'keyboard';

/** A vertex a connection ends at, and the port the connection meets, if any. */
export interface End {
  /** The vertex. */
  row: Row;
  /** The port, by the reference field naming its net. */
  port?: string;
}

/** A failure as JSON, in the same form as the npm package's `LatkitError`. */
export interface Failure {
  /** The kind of failure. See `LatkitError.code`. */
  code: 'invalid' | 'unsupported' | 'limit' | 'io' | 'device-lost' | 'cancelled' | 'timeout';
  /** A description of what failed. */
  message: string;
  /** For `invalid` failures, the path of the invalid input, such as `marks[2].color`. */
  path?: string;
}

/** A summary of one field: its kind, plus its target table or axis span where those apply. */
export interface FieldDescription {
  /** The field's name. */
  name: string;
  /** The kind of values it holds. */
  kind: Kind;
  /** For a reference, the target table. */
  to?: string;
  /** For a sampled field, the first and last axis coordinates it holds. */
  span?: [number, number];
}

/** A row under a point, as the frame drew it. */
export interface Hit {
  /** The row. */
  row: Row;
  /** The name of the mark that drew it, if the mark has one. It tells apart two marks of one table. */
  mark?: string;
  /**
   * The row's point nearest the probe, in CSS pixels from the top left: a vertex's or port's middle,
   * or the nearest point of a stroke or triangle.
   */
  point: [number, number];
  /** That point in the space's coordinates: x, y, and elevation. */
  position: [number, number, number];
  /** CSS pixels from the probe to the row. */
  distance: number;
  /** The port hit, if the hit is on a vertex's port. */
  port?: string;
  /** The sample hit, if the hit is on a line tracing a sampled field. */
  sample?: Sample;
}

/** The kind of values a field holds. */
export type Kind =
  | /** Numbers. */ 'number'
  | /** Booleans. */ 'bool'
  | /** Texts. */ 'text'
  | /** `[x, y]` points. */ 'point'
  | /** Paths of points. */ 'path'
  | /** Parts: the rings of a polygon, or the paths of a multi-path. */ 'parts'
  | /** Polygons of rings. */ 'polygons'
  | /** Rows of another table, by id. */ 'reference'
  | /** Numbers sampled over the dataset's axis. */ 'sampled';

/** Modifier keys held during an input. */
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
export type Phase =
  | /** The pointer moved far enough to drag. */ 'start'
  | /** The pointer moved. */ 'move'
  | /** The pointer was released, or the drag was cancelled. */ 'end';

/** A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value. */
export interface Sample {
  /** The frame, numbered from the first ever recorded. JSON uses a decimal string above 2^53 - 1. */
  frame: Id;
  /** The axis coordinate. */
  at: number;
  /** The value. */
  value: number;
}

/** Counters describing a view's frames. */
export interface Stats {
  /** Frames rendered. */
  frames: number;
  /** Rows of every mark's table. */
  rows: number;
  /**
   * Rows the marks draw: every row of a fully drawn table, and the rows in the tiles in view of a
   * paged table.
   */
  drawn: number;
  /** Draw calls the last frame recorded, label draws included. */
  draws: number;
  /**
   * Instances the last frame's draws drew: points, segments, triangles, and glyphs. An upper bound
   * for segments, which the GPU may cull.
   */
  instances: number;
  /** Fetched tiles the view draws, across all tile sources. */
  tiles: number;
  /** Tiles being fetched or decoded, across all tile sources. */
  tilesLoading: number;
  /** Milliseconds the last frame took to record on the CPU. */
  cpuMs: number;
  /**
   * Milliseconds the GPU takes per frame: the median of recently measured frames. 0 if the device
   * cannot measure GPU time.
   */
  gpuMs: number;
}

/** A summary of one table: its row count and its fields, sorted by name. */
export interface TableDescription {
  /** The table's name. */
  name: string;
  /** The number of rows. */
  rows: number;
  /** Its fields, sorted by name. */
  fields: FieldDescription[];
}

/**
 * Where the user acted, with which modifier keys and device. For keyboard input, the point is the
 * row the keys point at, or else the pointer, or else the view's middle.
 */
export interface Trigger {
  /** CSS pixels from the top left. */
  point: [number, number];
  /** The modifier keys held. */
  modifiers: Modifiers;
  /** The device used. */
  device: Device;
}

/**
 * A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as
 * nested `[x, y]` points; a reference as the id of the row it names.
 */
export type Value = number | boolean | string | null | [number, number] | unknown[][];

/** Something that happened in a view, as `view.on` reports it. */
export type ViewEvent =
  | /** A row was clicked. */ {
      type: 'click';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user clicked it. */
        trigger: Trigger;
      };
    }
  | /** A row was double-clicked, or Enter was pressed on the row the keyboard points at. */ {
      type: 'open';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user opened it. */
        trigger: Trigger;
      };
    }
  | /**
     * A context menu was requested: by a secondary click, the menu key, or a touch or pen held still.
     * Lists the rows under the trigger's point, for a menu of actions on them.
     */ {
      type: 'menu';
      detail: {
        /** The rows under the point, nearest first. */
        hits: Hit[];
        /** How the user asked. */
        trigger: Trigger;
      };
    }
  | /**
     * A row of a draggable mark is dragged. The drag starts once the pointer moves more than 4 CSS
     * pixels from where it pressed the row.
     */ {
      type: 'drag';
      detail: {
        /** Whether the drag starts, moves, or ends. */
        phase: Phase;
        /** The row dragged, as it was hit. */
        hit: Hit;
        /**
         * The row's new position in the space's coordinates. It is the hit point moved with the pointer
         * since the press, at the depth where the drag started, so a vertex keeps its offset from the
         * pointer. Snapped to a diagram's grid dots when the grid snaps.
         */
        position: [number, number, number];
        /** The pointer. */
        trigger: Trigger;
      };
    }
  | /**
     * A connection was drawn with `controls.connect` on: from a port, from a vertex with Alt held, or
     * by dragging an edge's end off it.
     */ {
      type: 'connect';
      detail: {
        /** The end it was drawn from. For a dragged edge end, the edge's other end. */
        from: End;
        /** The vertex it was released over, if any. */
        to: End | null;
        /** The edge whose end was dragged off. `to` replaces that end. */
        edge: Row | null;
        /** Where it was released. */
        trigger: Trigger;
      };
    }
  | /** Delete or Backspace was pressed with rows selected and `controls.delete` on. */ {
      type: 'delete';
      detail: {
        /** The rows selected. */
        rows: Rows[];
        /** The key. */
        trigger: Trigger;
      };
    }
  | /** The hovered row changed: `view.hovered`. */ {
      type: 'hovered';
      detail: {
        /** The row now hovered, or `null` if no row is. */
        hit: Hit | null;
        /** The pointer, or the keys. */
        trigger: Trigger;
      };
    }
  | /** The selection changed: `view.selection`. */ {
      type: 'selection';
      detail: {
        /** The rows selected now. */
        rows: Rows[];
        /** How the user changed it, or `null` when the data dropped rows from it. */
        trigger: Trigger | null;
      };
    }
  | /**
     * The camera moved: `view.camera`. A gesture, fit, flight, coast, or orbit moved it, or it moved
     * back within its zoom and pan limits after the view's size, insets, or space changed.
     */ { type: 'camera'; detail: Camera }
  | /** The work the last frame waited on changed: `view.waiting`. Empty once frames are complete. */ {
      type: 'waiting';
      detail: Waiting;
    }
  | /**
     * Something failed. Reported once. A mark that no longer fits its data is also listed in
     * `view.failures`.
     */ { type: 'error'; detail: Failure };

/**
 * What a frame still waits on: pipelines the scene draws with, which compile before the view draws
 * anything new (`compiling`); pages uploading, or tables not yet built from them (`data`);
 * layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); label texts being read back, or
 * not yet set (`labels`); a fit due or being measured (`fit`); segment counts, or a transition
 * starting (`marks`). Empty once the frame is complete.
 */
export type Waiting = ('compiling' | 'data' | 'derived' | 'labels' | 'fit' | 'marks')[];

/**
 * Counts of the work a `Gpu` has done since it was created. Subtract two snapshots to get the work
 * between them.
 */
export interface Work {
  /** Bytes of data pages uploaded. */
  uploaded: number;
  /**
   * Data pages, or pieces of pages, uploaded. A change's uploads count pages here and bytes in
   * `uploaded`.
   */
  uploads: number;
  /** Bytes written other than pages: uniforms, programs, label runs, the selection, and textures. */
  written: number;
  /** Rows whose channels the GPU evaluated. */
  evaluated: number;
  /**
   * Edge and face rows whose endpoints the GPU resolved to resident vertex rows. These are rows that
   * changed, plus every row of a page that references a vertex now resident elsewhere.
   */
  resolved: number;
  /**
   * Bytes of per-row word pages the GPU cleared: pages read before anything writes them, and the
   * normals that faces sum from scratch.
   */
  cleared: number;
  /**
   * Rows packed into pages of a paged table's draw order. Each page is packed once, the first time a
   * view draws it, and again only when a write changes its rows.
   */
  packed: number;
  /**
   * Readbacks from the GPU: probes, queries, fits, label texts, segment counts, and pictures. Frame
   * timer readbacks, which only some devices support, are not counted.
   */
  readbacks: number;
  /**
   * Jobs started: layouts, routes, lanes, triangulations, pyramids, and tiles. They run on the
   * host's workers, or immediately without a host.
   */
  jobs: number;
  /** Label texts the host was asked to rasterize. */
  texts: number;
  /**
   * Pipelines compiled. In a browser, each compiles in the background when a view or shot requests
   * it ahead of use. Natively, each compiles when first created.
   */
  pipelines: number;
  /**
   * Pipelines not requested ahead of use, compiled when first used. In a browser they compile on the
   * GPU's thread and delay frames. Zero unless a scene uses a pipeline it did not request.
   */
  late: number;
}
