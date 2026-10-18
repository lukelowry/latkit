/**
 * What latkit throws: an `Error` with a `code`, and for invalid input the `path` to the part, such
 * as `marks[2].color`.
 */
export interface LatkitError extends Error {
  code: 'invalid' | 'unsupported' | 'limit' | 'load' | 'device-lost' | 'cancelled';
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

/** A vertex a connection ends at, and its port when it has the one the connection meets. */
export interface End {
  row: Row;
  port?: string;
}

/** What lies under a secondary click or the menu key's point, for a menu of what to do with it. */
export interface Menu {
  /** CSS pixels from the top left: the pointer, or for the key the view's middle. */
  point: [number, number];
  /** What lies under it, nearest first. */
  hits: Hit[];
  /** Whether the menu key asked. */
  keyboard: boolean;
  modifiers: Modifiers;
}

/** A connection drawn from a port, an Alt-held vertex, or an edge whose end was dragged off it. */
export interface Connect {
  /** The end it was drawn from: for an edge, the end that stayed. */
  from: End;
  /** The vertex it was released over, if any. */
  to: End | null;
  /** The edge whose other end was dragged, which `to` replaces. */
  edge: Row | null;
  /** Where it was released, CSS pixels from the top left. */
  point: [number, number];
}

/** A row of a draggable mark following the pointer. */
export interface Drag {
  phase: 'start' | 'move' | 'end';
  /** The row dragged, as it was hit. */
  hit: Hit;
  /** The pointer, CSS pixels from the top left. */
  point: [number, number];
  /** The point under the pointer at the depth the drag started: x, y, and elevation. */
  position: [number, number, number];
}

/** What a view tells its listeners, by type. */
export interface ViewEvents {
  /** The row under the pointer changed; `null` when it left every row. */
  hover: Hit | null;
  click: Hit;
  /** A row was double clicked. */
  open: Hit;
  /** The selection changed. */
  select: Row[];
  drag: Drag;
  /** The secondary button clicked, or the menu key pressed. */
  menu: Menu;
  /** A connection was drawn, with `controls.connect` on. */
  connect: Connect;
  /** Delete or Backspace with rows selected, with `controls.delete` on. */
  delete: Row[];
  /** The camera moved. */
  camera: Camera;
  /** A mark does not fit its data and draws nothing until a scene or data fixes it. */
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
