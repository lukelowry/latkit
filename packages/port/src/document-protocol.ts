/**
 * The document wire contract. Commands address a revision and a client's monotonically increasing
 * sequence; updates carry changed schematic columns, never a vendor's private history objects.
 */
import { validateNetlist, type Document, type Model } from '@latkit/model';

import { check, type Check } from './check.js';
import { protocol } from './protocol.js';

const MAX_ELEMENTS = 1_000_000;
export const MAX_OPERATIONS = 256;
export const MAX_COMMAND_BYTES = 1 << 20;

type Address = {
  readonly client: string;
  readonly sequence: number;
  readonly base: Document.Version;
};
export type Command = Address &
  (
    | { readonly op: 'apply'; readonly operations: readonly Document.Operation[] }
    | { readonly op: 'undo' }
    | { readonly op: 'redo' }
  );
export type Request =
  | Command
  | { readonly op: 'open'; readonly client?: string }
  | { readonly op: 'view' }
  | { readonly op: 'model'; readonly base: Document.Version }
  | { readonly op: 'bytes'; readonly base: Document.Version };

export type Receipt =
  | {
      readonly kind: 'accepted';
      readonly version: Document.Version;
      readonly change: Document.Change | null;
    }
  | { readonly kind: 'conflict'; readonly version: Document.Version }
  | {
      readonly kind: 'refused';
      readonly message: string;
      readonly at: Document.Port | Model.Element | null;
    }
  | { readonly kind: 'expired'; readonly message: string }
  | { readonly kind: 'busy'; readonly message: string };

export type Reply =
  | Receipt
  | {
      readonly kind: 'opened';
      readonly client: string;
      readonly next: number;
      readonly view: Document.View;
    }
  | { readonly kind: 'view'; readonly view: Document.View }
  | { readonly kind: 'model'; readonly version: Document.Version; readonly id: string }
  | { readonly kind: 'bytes'; readonly version: Document.Version; readonly bytes: Uint8Array };

export interface Update {
  readonly kind: 'update';
  readonly from: Document.Version;
  readonly to: Document.Version;
  readonly change: Document.Change;
  readonly schematic: Partial<Document.Schematic>;
  readonly palette?: readonly Document.BlockClass[];
  readonly history: Document['history'];
}

const token: Check<string> = (value, name) => {
  check.string(value, name);
  if (value.length === 0 || value.length > 128)
    throw new TypeError(`${name} must be 1 to 128 characters`);
};
export const version: Check<Document.Version> = check.object({
  epoch: token,
  revision: check.index,
});
const element: Check<Model.Element> = check.object({ classId: check.string, index: check.index });
const port: Check<Document.Port> = check.object({ element, port: check.string });
const location: Check<Document.Port | Model.Element> = (value, name) => {
  if (typeof value === 'object' && value !== null && 'element' in value) port(value, name);
  else element(value, name);
};
function typed<T extends ArrayBufferView>(kind: string): Check<T> {
  return (value, name) => {
    if (
      Object.prototype.toString.call(value) !== `[object ${kind}]` ||
      (value as T).byteLength > 64 << 20
    )
      throw new TypeError(`${name} must be a bounded ${kind}`);
  };
}
const floats = typed<Float32Array>('Float32Array');
const point: Check<readonly [number, number]> = (value, name) => {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name} must be a point`);
  check.finite(value[0], name);
  check.finite(value[1], name);
};
const scalar: Check<number | string | boolean | null> = (value, name) => {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') check.string(value, name);
  else check.finite(value, name);
};
const netDestination: Check<{ readonly net: Model.Element }> = check.object({ net: element });
const destination: Check<Document.Port | { readonly net: Model.Element }> = (value, name) => {
  if (typeof value === 'object' && value !== null && 'net' in value) netDestination(value, name);
  else port(value, name);
};
// Reuse the exhaustive request checker for Operation's `kind` discriminant.
type OperationRequest<T = Document.Operation> = T extends { readonly kind: infer K extends string }
  ? Omit<T, 'kind'> & { readonly op: K }
  : never;
const operationFields: Check<OperationRequest> = check.requests<OperationRequest>({
  connect: { from: port, to: destination },
  disconnect: { port },
  insert: {
    classId: check.string,
    at: check.nullable(point),
    wire: check.optional(check.object({ port: check.string, to: port })),
  },
  remove: { elements: check.array(element, MAX_ELEMENTS) },
  place: { elements: check.array(element, MAX_ELEMENTS), positions: check.nullable(floats) },
  set: { element, column: check.string, value: scalar },
  record: { classId: check.string, signal: check.string, recorded: check.boolean },
});
const operation: Check<Document.Operation> = (value, name) => {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${name} must be an operation`);
  const record = value as Record<string, unknown>;
  operationFields({ ...record, op: record.kind }, name);
  const op = value as Document.Operation;
  if (op.kind === 'place' && op.positions !== null) {
    if (op.positions.length !== op.elements.length * 2)
      throw new TypeError(`${name}.positions must contain two coordinates per element`);
    for (const coordinate of op.positions) check.finite(coordinate, `${name}.positions`);
  }
};
const address = { client: token, sequence: check.index, base: version };
export const DOCUMENT = protocol<Request, Reply, Update>(
  'document',
  check.requests<Request>({
    open: { client: check.optional(token) },
    view: {},
    apply: { ...address, operations: check.array(operation, MAX_OPERATIONS) },
    undo: address,
    redo: address,
    model: { base: version },
    bytes: { base: version },
  }),
);

const change: Check<Document.Change> = check.object({
  label: check.string,
  scope: check.oneOf(['layout', 'values', 'structure'] as const),
  created: check.array(element, MAX_ELEMENTS),
});
const history: Check<Document['history']> = check.object({
  undo: check.array(change, 200),
  redo: check.array(change, 200),
});
const palette: Check<readonly Document.BlockClass[]> = check.array(
  check.object<Document.BlockClass>({
    classId: check.string,
    label: check.string,
    group: check.string,
    ports: check.array(
      check.object({
        name: check.string,
        flow: check.oneOf(['in', 'out', 'bus'] as const),
        required: check.boolean,
      }),
      MAX_ELEMENTS,
    ),
  }),
  MAX_ELEMENTS,
);
const netlist: Check<Document.Netlist> = (value, name) => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} must be a netlist`);
  validateNetlist(value as Document.Netlist);
};
const schematicFields = {
  netlist,
  blocks: check.array(element, MAX_ELEMENTS),
  nets: check.array(check.nullable(element), MAX_ELEMENTS),
  sources: check.array(
    check.nullable(
      check.object({
        field: check.object<Model.FieldRef>({
          classId: check.string,
          kind: check.oneOf(['column', 'signal'] as const),
          id: check.string,
        }),
        index: check.index,
      }),
    ),
    MAX_ELEMENTS,
  ),
  status: floats,
  positions: floats,
  problems: check.array(
    check.object<Document.Problem>({
      at: location,
      kind: check.oneOf(['unwired', 'invalid', 'unsupported'] as const),
      message: check.string,
    }),
    MAX_ELEMENTS,
  ),
};
const schematic: Check<Document.Schematic> = check.object(schematicFields);

/** Check cross-column lengths; netlist validation is needed only when the netlist changes. */
export function checkSchematicLengths(value: Document.Schematic): void {
  const { netlist, blocks, nets, sources, status, positions } = value;
  if (
    blocks.length !== netlist.blockCount ||
    positions.length !== blocks.length * 2 ||
    nets.length !== netlist.netStart.length - 1 ||
    sources.length !== nets.length ||
    status.length !== netlist.portFlow.length
  )
    throw new TypeError('document schematic columns have inconsistent lengths');
}
const viewFields: Check<Document.View> = check.object({ version, schematic, palette, history });
const view: Check<Document.View> = (value, name) => {
  viewFields(value, name);
  checkSchematicLengths((value as Document.View).schematic);
};
const patch: Check<Partial<Document.Schematic>> = check.object({
  netlist: check.optional(netlist),
  blocks: check.optional(schematicFields.blocks),
  nets: check.optional(schematicFields.nets),
  sources: check.optional(schematicFields.sources),
  status: check.optional(floats),
  positions: check.optional(floats),
  problems: check.optional(schematicFields.problems),
});
export const checkUpdate: Check<Update> = check.object({
  kind: check.oneOf(['update'] as const),
  from: version,
  to: version,
  change,
  schematic: patch,
  palette: check.optional(palette),
  history,
});
type ReplyRequest<T = Reply> = T extends { readonly kind: infer K extends string }
  ? Omit<T, 'kind'> & { readonly op: K }
  : never;
const replyFields: Check<ReplyRequest> = check.requests<ReplyRequest>({
  accepted: { version, change: check.nullable(change) },
  conflict: { version },
  refused: { message: check.string, at: check.nullable(location) },
  expired: { message: check.string },
  busy: { message: check.string },
  opened: { client: token, next: check.index, view },
  view: { view },
  model: { version, id: token },
  bytes: { version, bytes: check.bytes },
});
export const checkReply: Check<Reply> = (value, name) => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${name} must be a reply`);
  const record = value as Record<string, unknown>;
  replyFields({ ...record, op: record.kind }, name);
};

export function sameVersion(a: Document.Version, b: Document.Version): boolean {
  return a.epoch === b.epoch && a.revision === b.revision;
}

/** Only public history metadata crosses; format-specific inverse edits stay with the document. */
export function publicChange(value: Document.Change): Document.Change {
  return {
    label: value.label,
    scope: value.scope,
    created: value.created.map(({ classId, index }) => ({ classId, index })),
  };
}
