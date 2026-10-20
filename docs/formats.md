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
  `{ at, table, ids?, fields }`, `forget` `{ before }`, and `axis` `{ name, unit }`.
- `ids` are numbers or texts, or `{ "count": n }`; `null` leaves a reference unwired.
- A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
  file beside the document, `{ file, dtype, offset, count }`: `count` values from byte `offset`, of
  dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8`, or `bool` (a byte each, nonzero true).

(bytes)=

## Bytes

A patch as bytes is one frame; a dataset's bytes are the patch that builds it. A frame says its
length up front, so frames back to back split without decoding. Little endian throughout.

| Part         | Layout                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame        | `LATK`, `u64` length of the whole frame, dataset name (empty for none), `u32` op count, ops                                                                                                                       |
| op           | `u8` tag: 0 axis, 1 replace, 2 set, 3 remove, 4 append, 5 forget; then its payload                                                                                                                                |
| axis         | name, unit                                                                                                                                                                                                        |
| replace, set | table name, ids, `u32` field count; per field: name, `u8` 0 values or 1 reference (target table name, ids as values)                                                                                              |
| remove       | table name, ids                                                                                                                                                                                                   |
| append       | table name, `u8` 1 and ids or `u8` 0 for every row, `u32` frames, `f64` coordinates, `u32` field count; per field: name, values frame-major                                                                       |
| forget       | `f64` before                                                                                                                                                                                                      |
| ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32`, or texts                                                                                                                                              |
| values       | `u8` storage, `u32` length, data, `u8` 1 and validity bits, or `u8` 0                                                                                                                                             |
| storage      | 0 `f64`, 1 `f32`, 2 `i32`, 3 `u32`, 4 `u64`, 5 bits, 6 texts (`u32` offsets, then `u32` byte length and UTF-8), 7 geometry (`u8` depth, each level's `u32` count and offsets, `u32` point count, `f64` x y pairs) |
| text         | `u32` byte length, UTF-8                                                                                                                                                                                          |

Bits are `u64` words, low bit first. A dataset's sampled fields carry their frames in its bytes; a
writer outside latkit writes them as `append` changes.
