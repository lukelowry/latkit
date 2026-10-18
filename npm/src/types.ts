/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].color`.
 */
export interface LatkitError extends Error {
  code: 'invalid' | 'unsupported' | 'limit' | 'load' | 'device-lost' | 'cancelled' | 'timeout';
  path?: string;
}

/** A row's id. */
export type Id = number | string;

/** Row ids: a count for rows `0..n`, or numbers or texts. */
export type Ids =
  number | Uint32Array | Float64Array | readonly (number | null)[] | readonly (string | null)[];

/** One column of values; `null` is missing. A `Uint8Array` holds booleans, nonzero true. */
export type Values =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Uint8Array
  | readonly (number | null)[]
  | readonly (boolean | null)[]
  | readonly (string | null)[]
  | readonly [number, number][]
  | readonly [number, number][][]
  | readonly [number, number][][][]
  | readonly [number, number][][][][];

/** A field naming rows of another table by id. */
export interface Reference {
  reference: string;
  ids: Ids;
}

/** Values of a field naming rows of `table` by id. */
export function reference(table: string, ids: Ids): Reference {
  return { reference: table, ids };
}

/** A row of a table in a dataset. */
export interface Row {
  data: string;
  table: string;
  id: Id;
}

/** A row under a point, as the frame drew it. */
export interface Hit {
  row: Row;
  /** The index of the scene's mark that drew it. */
  mark: number;
  /** The row's point nearest the probe, CSS pixels from the top left. */
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

/** A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value. */
export interface Sample {
  frame: number;
  at: number;
  value: number;
}

/** Keys held. */
export interface Modifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** What the user acts with. A finger's picks reach 8 CSS pixels farther. */
export type Device = 'mouse' | 'pen' | 'touch' | 'keyboard';

/**
 * Where, with what keys, and with what the user acted. For keys, the point is the row they point
 * at, else the pointer, else the view's middle.
 */
export interface Trigger {
  /** CSS pixels from the top left. */
  point: [number, number];
  modifiers: Modifiers;
  device: Device;
}

/** A vertex a connection ends at, and its port when it has the one the connection meets. */
export interface End {
  row: Row;
  port?: string;
}

/**
 * What a view tells its listeners, by type. Intents (`click`, `open`, `menu`, `drag`, `connect`,
 * `delete`) are told once each, in the order the user acted. Changes (`hover`, `select`, `camera`,
 * `waiting`) tell only their latest, and their state can always be read. A view tells only what
 * the application did not do itself: its setters change state silently.
 */
export interface ViewEvents {
  /** A row was clicked. */
  click: { hit: Hit; trigger: Trigger };
  /** A row was double clicked, or Enter pressed on the row the keys point at. */
  open: { hit: Hit; trigger: Trigger };
  /** The secondary button clicked, or the menu key pressed: what lies under the trigger's point,
   * nearest first. */
  menu: { hits: Hit[]; trigger: Trigger };
  /** A row of a draggable mark follows the pointer: `position` is the point under it at the depth
   * the drag started, x, y, and elevation. */
  drag: {
    phase: 'start' | 'move' | 'end';
    hit: Hit;
    position: [number, number, number];
    trigger: Trigger;
  };
  /** A connection was drawn, with `controls.connect` on: from a port, an Alt-held vertex, or an edge
   * whose end was dragged off it, to the vertex released over; `edge` is the edge `to` replaces. */
  connect: { from: End; to: End | null; edge: Row | null; trigger: Trigger };
  /** Delete or Backspace with rows selected, with `controls.delete` on. */
  delete: { rows: Row[]; trigger: Trigger };
  /** What the user points at changed: `View.hovered`. */
  hover: { hit: Hit | null; trigger: Trigger };
  /** The selection changed: `View.selection`. Without a trigger, the data dropped rows. */
  select: { rows: Row[]; trigger: Trigger | null };
  /** The camera moved by a gesture, a fit, a flight, coasting, or an orbit. */
  camera: Camera;
  /** What the last frame stood in for changed; empty once it is complete. */
  waiting: Waiting[];
  /** Something failed, told once; a mark its data no longer fits also lists in
   * `View.failures`. */
  error: LatkitError;
}

/**
 * Where a view looks. On the earth, a plane, or a diagram: the point looked at and turned about
 * (`[x, y]` on the ground, or `[x, y, elevation]`), log₂ zoom, and degrees of pitch and bearing, which
 * a diagram keeps at 0. On a plot: the ranges shown, `y: null` fitting the values in view.
 */
export type Camera =
  | {
      center: [number, number] | [number, number, number];
      zoom: number;
      pitch: number;
      bearing: number;
    }
  | { x: [number, number]; y: [number, number] | null };

/** What {@link View.fit} frames: everything, some rows, one row kept in view, or a box. */
export type Fit =
  | 'all'
  | { rows: Row[] }
  | { reveal: Row }
  | { bounds: { min: [number, number, number]; max: [number, number, number] } };

/** What a view does each frame. */
export interface Stats {
  frames: number;
  /** Rows of every mark's table. */
  rows: number;
  /** Rows every mark draws: every row of a table drawn whole, the rows of the tiles in view of one
   * drawn through tiles. */
  drawn: number;
  /** Bytes of data waiting to upload. */
  uploading: number;
  /** Bytes of data pages on the GPU, for every view of its GPU. */
  resident: number;
  /** Bytes the GPU's budget lets data take. */
  budget: number;
  /**
   * The work under way the last frame stood in for; empty when it drew everything as the data,
   * scene, and camera say: no tile drawing its ancestor, no wire its elbows, no label its estimate.
   */
  waiting: Waiting[];
  /** Milliseconds the last frame took to record. */
  cpuMs: number;
  /** Milliseconds the GPU takes on a frame: the median of the last it measured; 0 where it cannot. */
  gpuMs: number;
}

/**
 * Work under way a frame stands in for: pages uploading or tables not yet built from them
 * (`data`); layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); a label placement or
 * texts not yet set (`labels`); a fit due or being measured (`fit`); row regions laid out again,
 * segment counts, or a transition beginning (`marks`).
 */
export type Waiting = 'data' | 'derived' | 'labels' | 'fit' | 'marks';

/**
 * What a GPU did since it was created, counted exactly. Unlike time, it repeats wherever the
 * budget, the device's limits, and the frames drawn do, so tests and benchmarks hold it to what it
 * was; subtract two for what happened between.
 */
export interface Work {
  /** Bytes of data pages uploaded. */
  uploaded: number;
  /** Bytes written besides pages: uniforms, programs, label runs, the selection, textures. */
  written: number;
  /** Rows whose channels the GPU evaluated. */
  evaluated: number;
  /**
   * Reads back from the GPU: probes, queries, fits, label placements, segment counts, pictures;
   * not the frame timer's, which only some devices have.
   */
  readbacks: number;
  /**
   * Jobs handed out: layouts, routes, lanes, triangulations, pyramids, tiles; to workers, or done
   * at once without them.
   */
  jobs: number;
  /** Label texts asked to be set. */
  texts: number;
  /** Pipelines made. */
  pipelines: number;
}

/**
 * How much GPU memory data takes. A view draws a table too large for its share of `bytes` through
 * the tiles the camera asks for, so what it draws always fits; pages no view draws stay cached in
 * the room left. By default half the device's largest storage buffer; set it before data draws.
 */
export interface Budget {
  bytes: number;
  /** Bytes uploaded per frame at most; larger data streams in over frames. */
  uploadPerFrame: number;
}
