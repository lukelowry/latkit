/** Public Model/Recording contracts and explicit boundary validation. */
export type { Model } from './model.js';
export type { Recording, RecordingStatus } from './recording.js';
export type {
  Routine,
  Parameter,
  Input,
  InputValue,
  Command,
  CommandResult,
  Diagnostic,
} from './routine.js';
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
} from './data.js';
export type {
  Schema,
  ComponentDefinition,
  ComponentPort,
  ConnectionDefinition,
  ConnectionRole,
  TableDefinition,
  FieldDefinition,
} from './schema.js';
export type {
  Queryable,
  QueryHeader,
  FieldSelection,
  QueryOptions,
  RetainOptions,
  Query,
  RowsQuery,
  SamplesQuery,
  SampleWindow,
  SampleRange,
  EnvelopeQuery,
  EnvelopeBlock,
  EnvelopeColumn,
  EndpointsQuery,
  LinksQuery,
  AggregateQuery,
  Filter,
  QueryBlock,
  RowsBlock,
  SamplesBlock,
  EndpointsBlock,
  LinksBlock,
  AggregateBlock,
  Update,
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
  Export,
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
