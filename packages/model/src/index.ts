/** Public Model/Document/Recording contracts and explicit boundary validation. */
export type { ModelService, Format, OpenInput } from './service.js';
export type { Input, InputMetadata } from './input.js';
export type { Resource, ResourceInfo, ResourceRead, ResourceWrite, WritePart } from './resource.js';
export type { SavedDocument, SaveTarget, SaveOptions, ReloadOptions } from './document.js';
export type { Model, CallOptions } from './model.js';
export type { Document, ElementReference, Endpoint, Edit, Change } from './document.js';
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
  Routine,
  Parameter,
  InputValue,
  Command,
  CommandResult,
  CommandEntry,
  CommandEvent,
  Diagnostic,
} from './routine.js';
export type {
  MonitorScope,
  Retention,
  RecordedFields,
  MonitorConfig,
  Recording,
  RecordingStatus,
  RecordingOutcome,
} from './recording.js';
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
