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
  /** The first and last axis coordinates held by any sampled field; `null` when none holds any. */
  span: [number, number] | null;
  /** Its tables, sorted by name. */
  tables: TableDescription[];
}

/** The input device. */
export type Device = 'mouse' | 'pen' | 'touch' | 'keyboard';

/** A vertex a connection ends at, and the port the connection meets, if any. */
export interface End {
  /** The vertex. */
  row: Row;
  /** The port, by the reference field naming its net. */
  port?: string;
}

/**
 * What failed: its `code`, the message, and for invalid input the `path` to the part, such as
 * `marks[2].vertices.color`.
 */
export interface Failure {
  code: 'invalid' | 'unsupported' | 'limit' | 'io' | 'device-lost' | 'cancelled' | 'timeout';
  message: string;
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
  /** The name of the mark that drew it, if named. It tells two marks of one table apart. */
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
  /** The port hit, when a vertex's port was. */
  port?: string;
  /** The sample hit, when a line tracing a sampled field was. */
  sample?: Sample;
}

/** The kind of values a field holds. */
export type Kind =
  'number' | 'bool' | 'text' | 'point' | 'path' | 'parts' | 'polygons' | 'reference' | 'sampled';

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
export type Phase = 'start' | 'move' | 'end';

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
   * Rows every mark draws: every row of a table drawn whole, and the rows of the tiles in view of a
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
  /** Fetched tiles the view draws, of every tile source. */
  tiles: number;
  /** Tiles being fetched or decoded, of every tile source. */
  tilesLoading: number;
  /** Milliseconds the last frame took to record on the CPU. */
  cpuMs: number;
  /**
   * Milliseconds the GPU takes per frame: the median of recently measured frames; 0 if the device
   * cannot measure.
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
 * Where the user acted, with which modifier keys, and with which device. For keyboard input, the
 * point is the row the keys point at, else the pointer, else the view's middle.
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
        /** The rows under the point, nearest first. */
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
        /**
         * The row's new position in the space's coordinates: the hit point moved with the pointer since
         * the press, at the depth where the drag started, so a vertex keeps its grab offset. Snapped to a
         * diagram's dots when its grid snaps.
         */
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
        /** The edge whose end was dragged off; `to` replaces that end. */
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
      type: 'hovered';
      detail: {
        /** The row now hovered; `null` once no row is. */
        hit: Hit | null;
        /** The pointer, or the keys. */
        trigger: Trigger;
      };
    }
  | {
      type: 'selection';
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
 * What a frame still waits on: pipelines the scene draws with, which compile before the view draws
 * anything new (`compiling`); pages uploading, or tables not yet built from them (`data`);
 * layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); label placement, or text not yet
 * set (`labels`); a fit due or being measured (`fit`); segment counts, or a transition starting
 * (`marks`). Empty once the frame is complete.
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
   * Edge and face rows whose endpoints the GPU resolved to their vertices' resident rows: rows that
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
   * Readbacks from the GPU: probes, queries, fits, label placements, segment counts, and pictures.
   * Frame timer readbacks, which only some devices support, are not counted.
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
