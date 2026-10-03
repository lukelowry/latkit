/** Immutable data, bounded local reads, portable command descriptions, and the Model contract. */
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
  FailureCode,
} from './types.js';
export { failure, isFailure } from './error.js';
export { Work, interruptible } from './work.js';
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
export type { Item } from './item.js';
export { sameItem } from './item.js';
export { read, selectRows, locateSample, itemId } from './read.js';
export type { ReadResult, SampleLocation } from './read.js';
export { createData, appendData } from './assemble.js';
export { textColumn, sliceSamples } from './columns.js';

export type { Model, Command, MonitorContext, CommandContext, Publication } from './model.js';
export { validateBatch } from './validation/batch.js';
export { validateSelection } from './validation/selection.js';
export { selectBatches, staticFields, sampledFields } from './select.js';

export type { ColumnPages } from './pages.js';
export { appendedPages, sampleDomain } from './pages.js';
export { sampleFrames } from './read.js';

export { createReader } from './reader/reader.js';
export type { Reader, ReadScope, ReaderOptions } from './reader/reader.js';
export { createMemory } from './memory.js';
export type { Memory, Entry as MemoryEntry, MemoryBudget, MemoryStats } from './memory.js';
export type {
  FieldInput,
  FieldBinding,
  FieldValues,
  FieldsRequest,
  FieldsBlock,
  ExtentRequest,
} from './reader/types.js';
