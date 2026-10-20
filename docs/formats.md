# Formats

## Schema

Everything latkit reads and writes as JSON has a JSON Schema, derived from the same declarations
that read and write it: `latkit schema` prints it, and the npm package's types are written from it.
Its `$defs` are the inputs (`Scene`, `Data`, `Patch`, `Query`, `Camera`, `Fit`, `Budget`, `Shot`)
and its `outputs` what latkit writes back (`ViewEvent`, `Stats`, `Work`, `Description`, `Rows`,
`Value`, `Failure`).

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

A patch as bytes is one frame; a dataset's bytes are the patch that builds it. A frame says its
length up front, so frames back to back split without decoding. Little endian throughout.

| Part         | Layout                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame        | `LATK`, `u64` length of the whole frame, dataset name (empty for none), `u32` op count, ops                                                                                                                               |
| op           | `u8` tag: 0 axis, 1 replace, 2 set, 3 remove, 4 append, 5 forget, 6 frames; then its payload                                                                                                                              |
| axis         | name, unit                                                                                                                                                                                                                |
| replace, set | table name, ids, `u32` field count; per field: name, `u8` 0 values, 1 reference (target table name, ids as values), or 2 samples                                                                                          |
| remove       | table name, ids                                                                                                                                                                                                           |
| append       | table name, `u8` 1 and ids or `u8` 0 for every row, `u32` frames, `f64` coordinates, `u32` field count; per field: name, values frame-major                                                                               |
| forget       | `f64` before                                                                                                                                                                                                              |
| frames       | table name, field name, `u32` rows, run                                                                                                                                                                                   |
| samples      | `u32` rows, `u32` first frame read, `u32` frames read, `u32` run count, runs                                                                                                                                              |
| run          | `u8` level, `u32` first entry, `u32` entries, `f64` coordinates (a frame's; a bucket's first and last frame's), `f32` values: a frame's per row, or each bucket's least per row, then each bucket's greatest; NaN missing |
| ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32`, or texts                                                                                                                                                      |
| values       | `u8` storage, `u32` length, data, `u8` 1 and validity bits, or `u8` 0                                                                                                                                                     |
| storage      | 0 `f64`, 1 `f32`, 2 `i32`, 3 `u32`, 4 `u64`, 5 bits, 6 texts (`u32` offsets, then `u32` byte length and UTF-8), 7 geometry (`u8` depth, each level's `u32` count and offsets, `u32` point count, `f64` x y pairs)         |
| text         | `u32` byte length, UTF-8                                                                                                                                                                                                  |

Bits are `u64` words, low bit first. A sampled field's entries are frames at level 0, and at level
`k` buckets of `8^k` frames; a bucket whose eight entries a level below are held is left out, as it
follows from them. A writer outside latkit writes frames as `append` changes.
