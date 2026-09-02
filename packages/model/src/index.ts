/**
 * `@latkit/model` — the immutable, columnar description of a network and its element classes that
 * a vendor produces once and every latkit renderer and view consumes directly, plus the byte form
 * that lets it cross a process boundary lazily.
 *
 * @packageDocumentation
 */

export type {
  ClassData,
  ClassSpec,
  Column,
  ElementRef,
  Item,
  Model,
  Signal,
  Topology,
} from './model.js';
export { createModel, elementAt, itemOf } from './model.js';

export type { Series } from './series.js';
export { frameAt, sample } from './series.js';

export type { Field, FieldRef } from './field.js';
export { fieldKey, fieldsOf } from './field.js';

export type { Results, RunFrames, Runner, RunUpdate } from './run.js';
export { collect } from './run.js';

export type { Grid, GridSort, GridWindow } from './grid.js';
export { createGrid, formatNumber } from './grid.js';

export type { Progress, Source } from './source.js';
export { openModel, sourceOf } from './source.js';
