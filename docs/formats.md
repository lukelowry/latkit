# Formats

## Schema

Everything latkit reads and writes as JSON has a JSON Schema, derived from the same declarations
that read and write it: `latkit schema` prints it, and the npm package's types are written from it.
Its `$defs` are the inputs (`Scene`, `Data`, `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`)
and its `outputs` what latkit writes back (`ViewEvent`, `Stats`, `Work`, `Description`, `Rows`,
`Camera`, `Budget`, `Value`, `Failure`).

(json)=

## JSON

A dataset's document is its name and the patch that builds it. A patch is a list of changes, each
named by its method with its parameters by name:

```json
{
  "name": "grid",
  "patch": [
    {
      "replace": {
        "table": "Bus",
        "ids": [101, 205],
        "fields": { "x": [0, 10], "name": ["North", null] }
      }
    },
    {
      "replace": {
        "table": "Branch",
        "ids": { "count": 1 },
        "fields": {
          "from": { "reference": "Bus", "ids": [101] },
          "to": { "reference": "Bus", "ids": [205] }
        }
      }
    },
    { "axis": { "name": "time", "unit": "s" } },
    {
      "append": {
        "at": [0, 0.5],
        "table": "Bus",
        "fields": { "vm": { "file": "vm.f32", "dtype": "f32le", "count": 4 } }
      }
    }
  ]
}
```

- `replace` and `set` take `{ table, ids, fields }`, `remove` `{ table, ids }`, `append`
  `{ at, table, ids?, fields }`, `forget` `{ before }`, `axis` `{ name, unit }`, and `frames`
  `{ table, field, level?, first, at, values }`, a run of a sampled field's entries as a
  [time tile](data.md#fetch-long-histories-in-spans) holds them.
- `ids` are numbers or texts, or `{ "count": n }`; `null` leaves a reference unwired.
- A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
  file beside the document, `{ file, dtype, offset, count }`: `count` values from byte `offset`, of
  dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8`, or `bool` (a byte each, nonzero true).

(bytes)=

## Bytes

LATK v1 encodes a patch as one frame; a dataset's bytes are the patch that builds it. A frame says its
length up front, so frames back to back split without decoding. Little endian throughout.

| Part         | Layout                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame        | `LATK`, `u16` version (1), `u16` flags (0), `u64` length of the whole frame, dataset name (empty for none), `u32` op count, ops                                                                                           |
| op           | `u8` tag: 0 axis, 1 replace, 2 set, 3 remove, 4 append, 5 forget, 6 frames; then its payload                                                                                                                              |
| axis         | name, unit                                                                                                                                                                                                                |
| replace, set | table name, ids, `u32` field count; per field: name, `u8` 0 values, 1 reference (target table name, ids as values), or 2 samples                                                                                          |
| remove       | table name, ids                                                                                                                                                                                                           |
| append       | table name, `u8` 1 and ids or `u8` 0 for every row, `u32` frames, `f64` coordinates, `u32` field count; per field: name, values frame-major                                                                               |
| forget       | `f64` before                                                                                                                                                                                                              |
| frames       | table name, field name, `u32` rows, run                                                                                                                                                                                   |
| samples      | `u32` rows, `u64` first frame read, `u64` frames read, `u8` highest stored level, `u32` run count, runs                                                                                                                   |
| run          | `u8` level, `u64` first entry, `u32` entries, `f64` coordinates (a frame's; a bucket's first and last frame's), `f32` values: a frame's per row, or each bucket's least per row, then each bucket's greatest; NaN missing |
| ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32`, or texts                                                                                                                                                      |
| values       | `u8` storage, `u32` length, data, `u8` 1 and validity bits, or `u8` 0                                                                                                                                                     |
| storage      | 0 `f64`, 1 `f32`, 2 `i32`, 3 `u32`, 4 `u64`, 5 bits, 6 texts (`u32` offsets, then `u32` byte length and UTF-8), 7 geometry (`u8` depth, each level's `u32` count and offsets, `u32` point count, `f64` x y pairs)         |
| text         | `u32` byte length, UTF-8                                                                                                                                                                                                  |

Bits are `u64` words, low bit first. A sampled field's entries are frames at level 0, and at level
`k` buckets of `8^k` frames; a bucket whose eight entries a level below are held is left out, as it
follows from them. A writer outside latkit writes frames as `append` changes.

The header is 16 bytes. The version is independent of the crate/npm version. Readers reject
unknown versions, nonzero flags, unknown operation/storage tags, truncated frames, and trailing
bytes. Pre-release unversioned frames must be regenerated from source data; they are not v1.
The checked-in `latk-v1.hex` fixture is tested by Rust and JavaScript.

Absolute frame indexes are `u64`; counts within an encoded run remain `u32`. A run's end and its
span in frames must fit in `u64`. JavaScript builders accept only safe integers, including the
run's end (`2^53 - 1` at most). Levels 0 through 21 are legal; the writer records the highest
stored level so changing the renderer's detail policy does not change the file's interpretation.
Normal appends currently derive up to six levels. Tile manifests record each field's `levels`.
Sample indexes in query/pick JSON outputs use decimal strings above JavaScript's safe-integer range.

Sample values and extrema are `f32`, with NaN representing missing values. Axis coordinates and
geometry coordinates are `f64`. An appended `Float64Array` is normalized to sampled `f32` storage;
this is a visualization history, not a lossless float64 archive. Static float64 columns stay float64.

`Patch.stream` limits one encoded frame (256 MiB by default), in addition to the supplied input
chunk and patches retained by the caller. It validates the header before allocating the frame body
and cancels its reader on failure or early termination. Rust decoding defaults to a 256 MiB frame
limit and a 512 MiB conservative decoded-storage budget; `Patch::decode_with_limits` accepts
`DecodeLimits` for applications with different needs. Applying patches and retaining snapshots
have their own memory costs, separate from decoding.
