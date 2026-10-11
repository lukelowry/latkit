/** Immutable data, bounded local reads, portable command descriptions, and the Model contract. */
export type { Column, Domain, Index } from './data/column.js';
export type { Data } from './data/data.js';
export { createData, appendData } from './data/assemble.js';
export { textColumn, sliceSamples } from './data/columns.js';
export {
  sameIndex,
  assertIndex,
  rowCount,
  rowAt,
  sliceRows,
  bitAt,
  numberAt,
  textAt,
  sampleAt,
} from './data/access.js';
export { appendedPages, sampleDomain, samePages } from './data/pages.js';
export { blockBuffers, blockByteLength } from './data/buffers.js';

export type { Schema } from './schema/schema.js';
export { fieldDefinition } from './schema/field.js';
export { validateSchema } from './validation/schema.js';

export type { Query, Block } from './query/query.js';
export { read, selectRows, itemId, locateSample, sampleFrames, sampleRuns } from './query/read.js';
export { selectBatches, staticFields, sampledFields } from './query/select.js';
export { validateQuery } from './validation/query.js';
export { validateBlock } from './validation/block.js';

export type { Item } from './item.js';
export { itemKey } from './item.js';

export type { Failure } from './failure.js';
export { failure, isFailure } from './failure.js';
export { Work, interruptible } from './work.js';

export type { Reader } from './reader/reader.js';
export { createReader } from './reader/reader.js';
export type { FieldInput } from './reader/types.js';
export type { Memory } from './reader/memory.js';
export { createMemory } from './reader/memory.js';

export type { Model, Command } from './model/model.js';
export { validateBatch } from './validation/batch.js';
export { validateSelection } from './validation/selection.js';
