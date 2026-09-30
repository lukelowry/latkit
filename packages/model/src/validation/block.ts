import { blockBuffers, blockByteLength } from '../buffers.js';
import type { Query, QueryBlock, QueryOptions } from '../query.js';
import type { Schema } from '../schema.js';
import type { Problem } from '../types.js';
import { Check, own, record } from './check.js';
import { bytes, column, offsetsOf, uints } from './column.js';
import { fieldsOf, index } from './query.js';
import { rowAxis } from './axis.js';

/**
 * Validate one block against a previously validated schema/request. Does not prove exclusive
 * ownership, row existence, stream completeness, or cross-block coherence; those need source tests.
 * Full validation is explicit boundary work, not an implicit cost on every local read.
 */
export function validateBlock(
  schema: Schema,
  query: Query,
  value: unknown,
  options: QueryOptions = {},
): readonly Problem[] {
  const c = new Check();
  const block = c.object(value, []);
  if (block.kind !== query.kind) {
    c.issue(['kind'], 'Block kind differs from its query.');
    return c.issues;
  }
  c.text(block.version, ['version']);
  if (block.schemaVersion !== schema.version)
    c.issue(['schemaVersion'], 'Block schema differs from the supplied schema.', 'conflict');
  if (options.maxBlockBytes !== undefined)
    c.integer(options.maxBlockBytes, ['options', 'maxBlockBytes'], 1);
  if (options.buffers !== undefined)
    c.enum(options.buffers, ['borrowed', 'owned'], ['options', 'buffers']);
  if (c.issues.length) return c.issues;
  const bound = Math.min(schema.limits.maxBlockBytes, options.maxBlockBytes ?? Infinity);
  const allocations = blockBuffers(value as QueryBlock);
  if (
    blockByteLength(value as QueryBlock) > bound ||
    (options.buffers === 'owned' &&
      allocations.reduce((sum, buffer) => sum + buffer.byteLength, 0) > bound)
  ) {
    c.issue([], 'Block exceeds its payload or owned-allocation bound.', 'resource-limit');
    return c.issues;
  }
  if (
    options.buffers === 'owned' &&
    allocations.some((buffer) => !(buffer instanceof ArrayBuffer))
  ) {
    c.issue([], 'Owned blocks cannot use shared backing allocations.');
    return c.issues;
  }
  const fields = fieldsOf(schema, query.from) ?? {};
  if (query.kind !== 'aggregate') {
    index(c, block.index, ['index'], query.from);
    if (query.rows && query.rows.kind !== 'ids' && query.rows.index) {
      const supplied = c.object(block.index, ['index']);
      for (const key of ['document', 'type', 'version'] as const)
        if (supplied[key] !== query.rows.index[key])
          c.issue(
            ['index', key],
            'Selection index is stale or belongs to another source.',
            'conflict',
          );
    }
  }
  if (query.kind === 'rows' || query.kind === 'samples' || query.kind === 'links') {
    const rows = rowAxis(c, block.rows, ['rows']);
    if (rows && query.rows?.kind === 'range') {
      const { offset, count } = query.rows;
      if (rows.range) {
        if (
          rows.length &&
          (rows.range.offset < offset || rows.range.offset + rows.length > offset + count)
        )
          c.issue(['rows'], 'Row lies outside the requested range.');
      } else
        for (let i = 0; i < rows.length; i++)
          if (rows.at(i) < offset || rows.at(i) >= offset + count) {
            c.issue(['rows'], 'Row lies outside the requested range.');
            break;
          }
    }
    if (rows && query.rows?.kind === 'indices') {
      const selected = new Set(query.rows.values);
      if (rows.length > selected.size) c.issue(['rows'], 'Too many rows for the selection.');
      else
        for (let i = 0; i < rows.length; i++)
          if (!selected.has(rows.at(i))) {
            c.issue(['rows'], 'Row lies outside the requested selection.');
            break;
          }
    }
    if (query.kind === 'rows') {
      c.integer(block.position, ['position']);
      if (own(block, 'total')) c.integer(block.total, ['total'], rows?.length ?? 0);
      if (query.count && !own(block, 'total')) c.issue(['total'], 'Count was requested.');
      if (query.ids)
        column(c, block.ids, { kind: 'reference', to: query.from }, false, ['ids'], rows?.length);
      else if (own(block, 'ids')) c.issue(['ids'], 'Identity strings were not requested.');
      const columns = c.object(block.columns, ['columns']);
      exactKeys(c, columns, query.select, ['columns']);
      for (const field of query.select)
        if (own(fields, field))
          column(
            c,
            columns[field],
            fields[field].type,
            fields[field].nullable === true,
            ['columns', field],
            rows?.length,
            0,
            !fields[field].sampled,
          );
    } else if (query.kind === 'samples') {
      c.integer(block.rowOffset, ['rowOffset']);
      c.integer(block.firstFrame, ['firstFrame']);
      let frames = 0;
      if (!(block.coordinates instanceof Float64Array))
        c.issue(['coordinates'], 'Expected Float64Array.');
      else {
        frames = block.coordinates.length;
        const range = query.window.kind === 'range' ? query.window : undefined;
        let before = 0;
        let after = 0;
        for (let i = 0; i < frames; i++) {
          const coordinate = block.coordinates[i];
          if (!Number.isFinite(coordinate) || (i > 0 && coordinate < block.coordinates[i - 1])) {
            c.issue(['coordinates', i], 'Coordinates must be finite and nondecreasing.');
            break;
          }
          if (range) {
            if (coordinate < range.between[0]) before++;
            else if (coordinate > range.between[1]) after++;
          }
        }
        // A block can bound context counts, but nearest neighbors and total coverage across
        // frame/row tiles require whole-stream checks against the source's pinned frame index.
        if (range && (before > (range.context?.before ?? 0) || after > (range.context?.after ?? 0)))
          c.issue(['coordinates'], 'Coordinates exceed the requested interval and context.');
        if (
          query.window.kind === 'at' &&
          (frames !== 1 || block.coordinates[0] > query.window.value)
        )
          c.issue(['coordinates'], 'Invalid at-coordinate result.');
      }
      if (!frames || !rows?.length) c.issue([], 'Sample tiles must have nonempty axes.');
      if (
        query.window.kind === 'frames' &&
        typeof block.firstFrame === 'number' &&
        (block.firstFrame < query.window.offset ||
          block.firstFrame + frames > query.window.offset + query.window.count)
      )
        c.issue(['firstFrame'], 'Tile lies outside the requested frame interval.');
      const columns = c.object(block.columns, ['columns']);
      exactKeys(c, columns, query.select, ['columns']);
      for (const field of query.select)
        if (own(fields, field)) {
          const path = ['columns', field];
          const col = c.object(columns[field], path);
          const fs = c.integer(col.frameStride, [...path, 'frameStride'], 1);
          const rs = c.integer(col.rowStride, [...path, 'rowStride'], 1);
          if (!fs || !rs || !rows || !frames) continue;
          const frameStride = col.frameStride as number;
          const rowStride = col.rowStride as number;
          const divisor = gcd(frameStride, rowStride);
          if (frames > rowStride / divisor && rows.length > frameStride / divisor)
            c.issue(path, 'Sample strides alias distinct cells.');
          const span = (frames - 1) * frameStride + (rows.length - 1) * rowStride + 1;
          if (!c.integer(span, path, 1, 0x7fffffff)) continue;
          column(c, col, fields[field].type, true, path, span);
          if (
            !fields[field].nullable &&
            col.validity instanceof Uint8Array &&
            typeof col.offset === 'number' &&
            Number.isSafeInteger(col.offset) &&
            col.offset >= 0
          ) {
            const mask = col.validity;
            // Do not scan malformed storage, or unaddressed stride padding.
            if (mask.length < Math.ceil((col.offset + span) / 8)) continue;
            let missing = false;
            for (let frame = 0; frame < frames && !missing; frame++)
              for (let row = 0; row < rows.length; row++) {
                const address = col.offset + frame * frameStride + row * rowStride;
                if (!(mask[address >>> 3] & (1 << (address & 7)))) {
                  missing = true;
                  break;
                }
              }
            if (missing) c.issue([...path, 'validity'], 'Null in a non-nullable sample cell.');
          }
        }
    } else {
      index(c, block.targetIndex, ['targetIndex'], query.to);
      sameDocument(c, block.index, block.targetIndex, ['targetIndex']);
      uints(c, block.source, ['source'], rows?.length);
      uints(c, block.target, ['target'], rows?.length);
      const mask = bytes(c, block.validity, ['validity']);
      if (mask && rows && mask.length !== Math.ceil(rows.length / 8))
        c.issue(['validity'], 'Link validity must cover exactly the row axis.');
    }
  } else if (query.kind === 'endpoints') {
    const connections = uints(c, block.connections, ['connections']);
    const componentRows = uints(c, block.componentRow, ['componentRow']);
    const count = componentRows?.length ?? 0;
    const types = uints(c, block.componentType, ['componentType'], count);
    const ports = uints(c, block.port, ['port'], count);
    const roles = uints(c, block.role, ['role'], count);
    const first = uints(c, block.firstEndpoint, ['firstEndpoint'], connections?.length);
    const total = uints(c, block.totalEndpoints, ['totalEndpoints'], connections?.length);
    const offsets = offsetsOf(c, block.offsets, 0, connections?.length ?? 0, count, ['offsets']);
    if (
      offsets &&
      connections &&
      (offsets[0] !== 0 ||
        offsets.length !== connections.length + 1 ||
        offsets[connections.length] !== count)
    )
      c.issue(['offsets'], 'CSR offsets must cover the full endpoint axis.');
    const indexes = c.array(block.componentIndexes, ['componentIndexes']);
    const indexTypes = new Set<unknown>();
    for (const [i, idx] of indexes.entries()) {
      if (record(idx)) {
        if (indexTypes.has(idx.type))
          c.issue(['componentIndexes', i], 'Each component type needs one index dictionary entry.');
        indexTypes.add(idx.type);
      }
      index(c, idx, ['componentIndexes', i]);
      sameDocument(c, block.index, idx, ['componentIndexes', i]);
      if (record(idx) && (typeof idx.type !== 'string' || !own(schema.components, idx.type)))
        c.issue(['componentIndexes', i], 'Endpoint index must name a component type.');
    }
    const names = c.array(block.portNames, ['portNames']);
    if (new Set(names).size !== names.length) c.issue(['portNames'], 'Duplicate dictionary entry.');
    for (const [i, name] of names.entries()) if (name !== null) c.text(name, ['portNames', i]);
    const roleNames = c.strings(
      block.roleNames,
      ['roleNames'],
      Object.keys(schema.connections[query.from]?.roles ?? {}),
    );
    if (types && ports && roles)
      for (let i = 0; i < count; i++) {
        const idx = indexes[types[i]];
        if (!record(idx)) c.issue(['componentType', i], 'Dictionary index is out of bounds.');
        if (ports[i] >= names.length) c.issue(['port', i], 'Dictionary index is out of bounds.');
        if (roles[i] >= roleNames.length)
          c.issue(['role', i], 'Dictionary index is out of bounds.');
        if (record(idx) && typeof idx.type === 'string' && own(schema.components, idx.type)) {
          const declared = schema.components[idx.type].ports ?? {};
          const port = names[ports[i]];
          if (
            port === null
              ? Object.keys(declared).length > 0
              : typeof port !== 'string' || !own(declared, port)
          )
            c.issue(['port', i], 'Port is not declared by the endpoint component type.');
        }
      }
    if (connections && offsets && first && total)
      for (let i = 0; i < connections.length; i++) {
        const size = offsets[i + 1] - offsets[i];
        if (size === 0 && total[i] !== 0)
          c.issue(
            ['connections', i],
            'Empty segments cannot make progress through a nonempty connection.',
          );
        if (first[i] + size > total[i])
          c.issue(['firstEndpoint', i], 'Segment exceeds total endpoint count.');
        if (first[i] === 0 && size === total[i] && roles) {
          const declared = schema.connections[query.from]?.roles ?? {};
          for (const [name, role] of Object.entries(declared)) {
            let actual = 0;
            for (let j = offsets[i]; j < offsets[i + 1]; j++)
              if (roleNames[roles[j]] === name) actual++;
            if (actual < role.min || (role.max !== undefined && actual > role.max))
              c.issue(['connections', i], 'Endpoint role cardinality is invalid.');
          }
        }
      }
  } else {
    const values = c.object(block.values, ['values']);
    if (!Object.keys(values).length)
      c.issue(['values'], 'Aggregate blocks must contain at least one requested field.');
    for (const [name, value] of Object.entries(values)) {
      if (!query.select.includes(name)) c.issue(['values', name], 'Unrequested field.');
      const entry = c.object(value, ['values', name]);
      c.integer(entry.count, ['values', name, 'count']);
      exactKeys(c, entry, ['count', ...query.measures], ['values', name]);
      for (const measure of query.measures) {
        if (
          entry.count === 0
            ? entry[measure] !== null
            : !c.finite(entry[measure], ['values', name, measure])
        )
          c.issue(
            ['values', name, measure],
            'Empty aggregates use null; populated aggregates are finite.',
          );
      }
      if (typeof entry.min === 'number' && typeof entry.max === 'number' && entry.min > entry.max)
        c.issue(['values', name], 'Minimum exceeds maximum.');
    }
  }
  return c.issues;
}

function exactKeys(
  c: Check,
  object: Record<string, unknown>,
  expected: readonly string[],
  path: readonly (string | number)[],
): void {
  for (const name of expected)
    if (!own(object, name)) c.issue([...path, name], 'Missing requested value.');
  for (const name of Object.keys(object))
    if (!expected.includes(name)) c.issue([...path, name], 'Unrequested value.');
}
function sameDocument(c: Check, a: unknown, b: unknown, path: readonly (string | number)[]): void {
  if (record(a) && record(b) && a.document !== b.document)
    c.issue(path, 'Indices refer to different documents.');
}
function gcd(a: number, b: number): number {
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
