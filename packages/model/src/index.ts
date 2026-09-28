/**
 * `@latkit/model` — the vocabulary every latkit package speaks: the model a vendor builds and the
 * instance every question about it goes to, the recordings its runs fill and the fields a host
 * binds, the structures renderers load and pick, and the sources that move a model or a recording
 * across a boundary lazily.
 *
 * @packageDocumentation
 */

export type { Item, Model, Topology } from './model.js';
export { createModel, validateTopology } from './model.js';

export type { Source } from './source.js';
export { openModel } from './source.js';

export type { Recording, RecordingSource } from './recording.js';
export { openRecording } from './recording.js';

export type { Series } from './series.js';
export { createSeries, validateSeries } from './series.js';

export type { Field, FieldRef } from './field.js';

export type { RunUpdate } from './run.js';

export type { Netlist, Part } from './netlist.js';
export { validateNetlist } from './netlist.js';

export type { Domain } from './domain.js';
export { extent, normalizeDomain, validateDomain } from './domain.js';

export type { Grid } from './grid.js';
export { formatNumber } from './grid.js';
