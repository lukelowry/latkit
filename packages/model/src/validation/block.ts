import { blockBuffers, blockByteLength } from '../buffers.js';
import type { Query, QueryBlock, QueryOptions } from '../query.js';
import type { Schema } from '../schema.js';
import type { Problem } from '../types.js';
import { Check, index, own, record } from './check.js';
import { bytes, column, identities } from './column.js';
import { fieldsOf } from './query.js';
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
      for (const key of ['source', 'type', 'version'] as const)
        if (supplied[key] !== query.rows.index[key])
          c.issue(
            ['index', key],
            'Selection index is stale or belongs to another source.',
            'conflict',
          );
    }
  }
  if (query.kind === 'rows' || query.kind === 'samples' || query.kind === 'envelope') {
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
      if (query.ids) identities(c, block.ids, ['ids'], rows?.length);
      else if (own(block, 'ids')) c.issue(['ids'], 'Identity strings were not requested.');
      const columns = c.object(block.columns, ['columns']);
      exactKeys(c, columns, query.select, ['columns']);
      for (const field of query.select)
        if (own(fields, field)) {
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
          references(columns[field], (target, path) =>
            sameSource(c, block.index, target.index, ['columns', field, ...path, 'index']),
          );
        }
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
    } else if (query.kind === 'envelope') {
      c.integer(block.rowOffset, ['rowOffset']);
      const first = c.integer(block.firstBucket, ['firstBucket'], 0, query.buckets - 1);
      const size = c.integer(block.bucketCount, ['bucketCount'], 1, query.buckets);
      if (
        first &&
        size &&
        (block.firstBucket as number) + (block.bucketCount as number) > query.buckets
      )
        c.issue(['bucketCount'], 'Tile exceeds the bucket axis.');
      if (!rows?.length) c.issue(['rows'], 'Envelope tiles must have nonempty rows.');
      const columns = c.object(block.columns, ['columns']);
      exactKeys(c, columns, query.select, ['columns']);
      if (rows && size)
        for (const field of query.select) {
          const path = ['columns', field];
          const item = c.object(columns[field], path);
          const cells = rows.length * (block.bucketCount as number),
            slots = cells * 4;
          if (!c.integer(slots, path, 4, 0x7fffffff)) continue;
          const values = c.object(item.values, [...path, 'values']);
          column(c, item.values, fields[field].type, true, [...path, 'values'], slots, 0, true);
          for (const key of ['coordinates', 'frames']) {
            if (!(item[key] instanceof Float64Array) || item[key].length !== slots)
              c.issue([...path, key], 'Expected one Float64 slot per value.');
          }
          const continuity = bytes(c, item.continuous, [...path, 'continuous']);
          if (continuity && continuity.length !== Math.ceil(cells / 8))
            c.issue([...path, 'continuous'], 'Continuity must cover exactly the row/bucket axis.');
          if (
            !(
              values.values instanceof Float32Array ||
              values.values instanceof Float64Array ||
              values.values instanceof Int32Array ||
              values.values instanceof Uint32Array
            ) ||
            typeof values.offset !== 'number' ||
            !Number.isSafeInteger(values.offset) ||
            values.offset < 0 ||
            values.offset + slots > values.values.length ||
            !(item.coordinates instanceof Float64Array) ||
            !(item.frames instanceof Float64Array)
          )
            continue;
          const valid = (i: number): boolean =>
            !(values.validity instanceof Uint8Array) ||
            !!(
              values.validity[((values.offset as number) + i) >>> 3] &
              (1 << (((values.offset as number) + i) & 7))
            );
          for (let cell = 0; cell < cells; cell++) {
            const start = cell * 4,
              populated = valid(start);
            for (let slot = 0; slot < 4; slot++) {
              const i = start + slot;
              if (valid(i) !== populated)
                c.issue(path, 'All four slots must be present or absent together.');
              if (!populated) continue;
              if (
                !Number.isFinite(item.coordinates[i]) ||
                !Number.isSafeInteger(item.frames[i]) ||
                item.frames[i] < 0
              )
                c.issue(
                  path,
                  'Envelope identities require finite coordinates and exact absolute frames.',
                );
              const coordinate = item.coordinates[i],
                [lo, hi] = query.window.between,
                bucket = (block.firstBucket as number) + (cell % (block.bucketCount as number));
              if (coordinate < lo) {
                if (bucket !== 0 || !query.window.context?.before)
                  c.issue(path, 'Unexpected leading context observation.');
              } else if (coordinate > hi) {
                if (bucket !== query.buckets - 1 || !query.window.context?.after)
                  c.issue(path, 'Unexpected trailing context observation.');
              } else {
                const span = hi - lo;
                const expected =
                  lo === hi
                    ? 0
                    : Math.min(
                        query.buckets - 1,
                        Math.floor(
                          (Number.isFinite(span)
                            ? (coordinate - lo) / span
                            : (coordinate / 2 - lo / 2) / (hi / 2 - lo / 2)) * query.buckets,
                        ),
                      );
                if (bucket !== expected)
                  c.issue(path, 'Observation belongs to a different coordinate bucket.');
              }
            }
            if (!populated && continuity && continuity[cell >>> 3] & (1 << (cell & 7)))
              c.issue(path, 'An empty bucket cannot be continuous.');
            if (populated) {
              const v = values.values,
                at = values.offset + start,
                f = item.frames;
              if (
                v[at + 1] > v[at] ||
                v[at + 1] > v[at + 3] ||
                v[at + 2] < v[at] ||
                v[at + 2] < v[at + 3] ||
                v[at + 1] > v[at + 2]
              )
                c.issue(path, 'Invalid envelope extrema.');
              if (
                f[start] > f[start + 1] ||
                f[start] > f[start + 2] ||
                f[start + 3] < f[start + 1] ||
                f[start + 3] < f[start + 2]
              )
                c.issue(path, 'Extrema must lie between first and last frame.');
            }
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
/** Every reference column within a column, nested ones included. */
function references(
  value: unknown,
  visit: (column: Record<string, unknown>, path: readonly (string | number)[]) => void,
  path: readonly (string | number)[] = [],
): void {
  if (!record(value)) return;
  if (value.kind === 'reference') visit(value, path);
  else if (value.kind === 'vector' || value.kind === 'list')
    references(value.values, visit, [...path, 'values']);
}
function sameSource(c: Check, a: unknown, b: unknown, path: readonly (string | number)[]): void {
  if (record(a) && record(b) && a.source !== b.source)
    c.issue(path, 'Indices refer to different sources.');
}
function gcd(a: number, b: number): number {
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
