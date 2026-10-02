/** Immutable data, local computation, and portable command descriptions. */
export type {
  Arguments,
  CommandDescription,
  CommandResult,
  Diagnostic,
  InputValue,
  Json,
  LogEntry,
  Parameter,
  Parameters,
  Progress,
} from './commands.js';
export type {
  DataType,
  NumericType,
  NumericArray,
  Index,
  RowSelection,
  RowAxis,
  Column,
  NumericColumn,
  SampleColumn,
  BooleanColumn,
  TextColumn,
  VectorColumn,
  ListColumn,
  ReferenceColumn,
} from './data.js';
export type { Schema, TypeDefinition, FieldDefinition } from './schema.js';
export type {
  QueryHeader,
  FieldSelection,
  QueryOptions,
  Query,
  RowsQuery,
  SamplesQuery,
  SampleWindow,
  SampleRange,
  EnvelopeQuery,
  EnvelopeBlock,
  EnvelopeColumn,
  AggregateQuery,
  Filter,
  QueryBlock,
  RowsBlock,
  SamplesBlock,
  AggregateBlock,
} from './query.js';
export type {
  Version,
  Domain,
  Axis,
  Scalar,
  Value,
  Bound,
  Bounds,
  RequestOptions,
  ProblemTarget,
  Problem,
  Failure,
} from './types.js';
export { blockBuffers, blockByteLength } from './buffers.js';
export { validateSchema } from './validation/schema.js';
export { validateQuery } from './validation/query.js';
export { validateBlock } from './validation/block.js';

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
} from './access.js';

export type {
  Data,
  TableData,
  ColumnPage,
  DataBatch,
  RowBatch,
  SampleBatch,
} from './materialized.js';
export { read, selectRows, locateSample } from './read.js';
export type { ReadResult, SampleLocation } from './read.js';
export { createData, appendData } from './assemble.js';
export { textColumn, sliceColumn, copyBuffers } from './columns.js';

export { validateBatch } from './validation/batch.js';
export { validateSelection } from './validation/selection.js';
export { selectBatches } from './select.js';
export { DEFAULT_BLOCK_BYTES } from './query.js';

export type { ColumnPages } from './pages.js';
export { appendedPages } from './pages.js';
export { resolveRows, type RowMappingRequest, type RowMapping } from './read.js';
export { samplePages } from './read.js';
