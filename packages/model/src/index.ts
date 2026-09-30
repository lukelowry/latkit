/**
 * `@latkit/model` — what a format, an engine, and an editor implement, and what they make. An
 * engine subclasses `Engine`: it keeps a vendor's cases, opening each as a `Document` through its
 * `Document.Format` and handing out `Document.Session`s on it, and records any model, offering
 * its studies as forms. A document produces immutable `Model` snapshots on demand; a `Recording`
 * is what an engine fills, and a `Series` is what every view follows. Every other type lives
 * under the class that speaks it: `Model.Topology`, `Engine.Case`, `Document.Operation`.
 *
 * @packageDocumentation
 */

export { Model, validateTopology } from './model.js';
export { Engine } from './engine.js';
export { Document, DocumentConflict } from './document.js';
export { Refusal } from './refusal.js';
export { validateNetlist } from './netlist.js';
export { Recording } from './recording.js';
export { Series, validateSeries } from './series.js';

export type { Domain } from './domain.js';
export { extent, normalizeDomain, validateDomain } from './domain.js';
export { formatNumber } from './grid.js';
