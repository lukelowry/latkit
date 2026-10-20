# Command line

The `latkit` executable draws scenes of datasets into images, image sequences, raw frames, and
video on the machine's GPU, with the browser's renderer. Its inputs are latkit's JSON, so any
language can write them.

```sh
cargo install latkit-cli   # or, from the repository: cargo build --locked -p latkit-cli --profile cli
latkit validate scene.json -d grid.json
latkit render scene.json -d grid.json -o grid.png --size 2400x1350 --scale 2
latkit render map.json plot.json -d grid.json -d states=usa.geojson \
  --panel 0,0,1,0.8 --panel 0,0.8,1,0.2 --frames frames.jsonl --fps 60 -o film.mp4
latkit render scene.json -d grid.json --frames - --format y4m -o - | ffmpeg -i - film.webm
latkit inspect grid.bin
latkit query grid.bin '{"of":"Branch","filter":{"op":"gt","args":["loading",90]},"limit":20}'
latkit schema scene > scene.schema.json
```

| Command    | Does                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `render`   | draws the scenes, one per `--panel`, and writes `--output`                                                |
| `validate` | reads and checks everything `render` would, frames included, without a GPU                                |
| `inspect`  | prints datasets as JSON: tables, rows, fields and their kinds, the axis and its span                      |
| `query`    | prints the rows a query keeps, sorted and paged, as JSON Lines                                            |
| `schema`   | prints the JSON Schema of every input, or of `scene`, `data`, `patch`, `query`, `camera`, `fit`, `frames` |

## Inputs

- **Scenes** are the [scene](scenes.md) JSON, with a `title` and `subtitle`, and on any mark a
  `legend`. `--camera FILE` gives scenes cameras, in order; a view without one frames `--fit`
  (`all`, or a fit as JSON). `--insets T,R,B,L` keeps room clear.
- **Datasets** (`-d [NAME=]FILE`) are a [JSON document](formats.md#json), latkit's
  [bytes](formats.md#bytes), or GeoJSON, which takes a `NAME`. A `NAME` renames any dataset.
  Slices of binary files load relative to the document.
- **Tiles** (`--tiles NAME=FILE`) are a PMTiles file, TileJSON, or a `{z}/{x}/{y}` template on disk.
- **Fonts** (`--font FILE`, repeated) replace system fonts; the first is the fallback.
- One input at most reads stdin (`-`).

## Frames

`--frames` is JSON Lines, a line an output frame at `n / --fps` seconds. Every key is optional:

```json
{
  "at": 1.3,
  "patch": {
    "grid": [
      {
        "append": {
          "at": 1.3,
          "table": "Bus",
          "fields": {
            "df": { "file": "df.f32", "dtype": "f32le", "offset": 280000, "count": 70000 }
          }
        }
      },
      { "forget": { "before": 1.3 } }
    ]
  },
  "fly": { "center": [-90, 35], "zoom": 4, "pitch": 40, "bearing": 0 }
}
```

| Key      | Changes                                                                   |
| -------- | ------------------------------------------------------------------------- |
| `at`     | the axis coordinate every view shows                                      |
| `patch`  | datasets by name, in order, each a patch in latkit's JSON                 |
| `camera` | where views look at once; `fly` eases there over twice the scene's `ease` |
| `fit`    | what views frame                                                          |
| `insets` | CSS pixels each view keeps clear                                          |
| `orbit`  | degrees a second a map or plane turns                                     |

`camera`, `fly`, and `fit` take one value for every view, or a list with one per view (`null`
leaves one). Frames load a couple ahead of the one drawing. Scenes ease as they say; `"ease": 0`
shows each frame's data as it is.

## Outputs

| Output                   | Writes                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `.png`, `.jpg`, `.webp`  | one picture; JPEG at `--quality`                                 |
| `frame-%04d.png`         | an image a frame (`--frames`)                                    |
| `.rgba`, `--format rgba` | straight-alpha RGBA, frames back to back                         |
| `.y4m`                   | YUV4MPEG2, 4:2:0 BT.709, for any encoder (`--frames`)            |
| `.mp4`                   | H.264 in fragmented MP4 from the platform's encoder (`--frames`) |

A still waits until every view is complete and settled; `--elapsed` fixes its effect time. A frame
where nothing moved is held. A file is replaced only once it is whole. MP4 needs Windows (Media
Foundation); elsewhere, pipe Y4M to an encoder. `--deadline` bounds each picture or frame.

## Diagnostics

Exit codes: 0 success, 1 failure, 2 usage. Errors print `latkit: SOURCE: message` with the part's
path, such as `frames[3].patch.grid[0].Bus.x`. `--diagnostics json` writes one object a line to
stderr, `{ type, detail }`: `progress` after each frame, `stats` when done, and `error` with its
`code`, `message`, `path`, and `source`.
