# latkit CLI

Draws latkit scenes of datasets into images, image sequences, raw frames, and videos, on the
machine's GPU, with the same renderer as the browser package. Inputs are the library's JSON, so any
language can write them. The package is `latkit-cli`; the executable is `latkit`.

```sh
cargo build --locked -p latkit-cli --profile cli          # target/cli/latkit
latkit validate scene.json -d grid.json
latkit render scene.json -d grid.json -o grid.png --size 2400x1350 --scale 2
latkit render map.json plot.json -d grid.json -d states=usa.geojson \
  --panel 0,0,1,0.8 --panel 0,0.8,1,0.2 --frames frames.jsonl --fps 60 -o film.mp4
latkit render scene.json -d grid.json --frames - --format y4m -o - | ffmpeg -i - film.webm
latkit inspect grid.bin
```

| Command    | Does                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `render`   | draws the scenes, one per `--panel`, and writes `--output`                              |
| `validate` | reads and checks everything `render` would, frames and overlays included, without a GPU |
| `inspect`  | prints datasets as JSON: tables, rows, fields' kinds, the axis and its span             |

## Inputs

- **Scenes** are the library's scene JSON ([format](../latkit/src/scene/decode.rs)), with a
  `title`, `subtitle`, and `legends`. `--camera FILE` gives scenes cameras in order; a view without
  one frames `--fit` (`all`, or a fit as JSON). `--insets T,R,B,L` keeps room clear.
- **Datasets** (`-d [NAME=]FILE`) are the library's dataset JSON, `{"name", "patch"}`
  ([format](../latkit/src/data/json.rs)), latkit bytes (`Data::to_bytes`), or GeoJSON, which takes
  a `NAME`. A `NAME` renames any dataset. Slices of binary files are read relative to the document.
- **Tiles** (`--tiles NAME=FILE`) are a PMTiles file, TileJSON, or `{z}/{x}/{y}` template on disk.
- **Fonts** (`--font FILE`, repeated) replace system fonts; the first is the fallback.
- Only one input reads stdin (`-`).

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
  "fly": { "center": [-90, 35], "zoom": 4, "pitch": 40, "bearing": 0 },
  "overlay": "caption.png"
}
```

| Key       | Changes                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `at`      | the axis coordinate every view shows: sampled fields read their last frame at or before it |
| `patch`   | datasets by name, each a patch in the library's JSON                                       |
| `camera`  | where views look at once; `fly` eases there over twice the scene's `ease`                  |
| `fit`     | what views frame                                                                           |
| `insets`  | CSS pixels each view keeps clear                                                           |
| `orbit`   | degrees a second a map or plane turns                                                      |
| `overlay` | a transparent PNG of the picture's size drawn over this frame                              |

`camera`, `fly`, and `fit` take one value for every view it fits, or a list with one per view
(`null` leaves one). Scenes ease as they say; `"ease": 0` shows each frame's data as it is.
Effects such as flowing comets follow the video's time.

## Outputs

| Output                   | Writes                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `.png`                   | one picture, or a sequence's single frame                        |
| `frame-%04d.png`         | a PNG a frame (`--frames`)                                       |
| `.rgba`, `--format rgba` | straight-alpha RGBA, frames back to back, no header              |
| `.y4m`                   | YUV4MPEG2, 4:2:0 BT.709 limited, for any encoder (`--frames`)    |
| `.mp4`                   | H.264 in fragmented MP4 from the platform's encoder (`--frames`) |

A still waits until every view is complete and settled; `--elapsed` fixes its effect time. A video
frame draws once its views are complete; a frame where nothing moved is held, repeated in raw
outputs and lasting longer in MP4. A file is replaced only once it is whole; stdout streams.
Videos are `--size` multiples of 4 by 2 and opaque. MP4 needs Windows (Media Foundation, hardware
where present); elsewhere, pipe Y4M to an encoder. `--deadline` bounds each picture or frame.

## Diagnostics

Exit codes: 0 success, 1 failure, 2 usage. Errors print `latkit: SOURCE: message` with the part's
path, such as `frames[3].patch.grid[0].Bus.x`; on a terminal, rendering shows progress.
`--diagnostics json` writes one object a line to stderr, `{"type", "detail"}`: `progress` after each
frame, `stats` when done (frames, seconds, each view's stats, the GPU's work), and `error` with the
library's `{code, message, path}` and its `source`.

[The gallery](../../examples/cli-gallery/README.md) and [the 70,000-bus fault](../../examples/bus-fault/README.md)
are made with Python and this CLI alone.
