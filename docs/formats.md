# File formats

## Schema

Run `latkit schema` to print the schema used for both JSON validation and the npm types.
Inputs such as `Scene`, `Data`, and `Patch` appear under `$defs`. Results such as `Stats`,
`Description`, and `Failure` appear under `outputs`.

(json)=

## JSON

A dataset's JSON document holds its name and the patch that builds it. A patch is a list of
changes. Each change is an object keyed by its method name, holding its parameters by name:

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

A field is an array of one kind of value, a reference `{ reference, ids }`, or a slice of a binary
file next to the document, `{ file, dtype, offset, count }`. A slice reads `count` values starting
at byte `offset`. Its `dtype` is `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, or `u8` for numbers,
or `bool` for booleans (one byte each, nonzero is true). A `null` id in a reference leaves that row
unconnected.

(bytes)=

## Bytes

A patch encodes as one frame, and a dataset's bytes are the patch that builds it. A frame's header
gives its length, so a reader can split frames written back to back without decoding them. All
values are little endian.

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
| samples      | `u32` rows, `u64` first frame read, `u64` frames read, `u8` highest stored level, `u32` run count, runs                                                                                                                   |
| run          | `u8` level, `u64` first entry, `u32` entries, `f64` coordinates (a frame's; a bucket's first and last frame's), `f32` values: a frame's per row, or each bucket's least per row, then each bucket's greatest; NaN missing |
| ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32`, or texts                                                                                                                                                      |
| values       | `u8` storage, `u32` length, data, `u8` 1 and validity bits, or `u8` 0                                                                                                                                                     |
| storage      | 0 `f64`, 1 `f32`, 2 `i32`, 3 `u32`, 4 `u64`, 5 bits, 6 texts (`u32` offsets, then `u32` byte length and UTF-8), 7 geometry (`u8` depth, each level's `u32` count and offsets, `u32` point count, `f64` x y pairs)         |
| text         | `u32` byte length, UTF-8                                                                                                                                                                                                  |

Bits are packed into `u64` words, low bit first. A sampled field's entries are frames at level 0
and buckets of `8^k` frames at level `k`, for levels 0 to 21. A bucket is left out when all eight
entries one level below it are stored, since it can be computed from them. Writers outside latkit
should record frames as `append` changes.

The 12-byte header contains the magic `LATK` and the frame length. Readers reject any other magic,
unknown operation or storage tags, truncated frames, and trailing bytes. The format has no version.
A release that changes it says so, and files written before that release no longer open. A [sample frame](https://github.com/lukelowry/latkit/blob/main/crates/latkit/tests/fixtures/patch.hex) is included with the Rust tests.

Absolute frame indexes are `u64`, and counts within an encoded run are `u32`. JavaScript builders
accept only safe integers. In Rust, `Patch::from_bytes` decodes with the default `DecodeLimits`: a
256 MiB frame and 512 MiB of decoded storage. `Patch::stream(read, limits)` takes other limits.
