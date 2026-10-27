# Command line

The `latkit` executable draws [scenes](guide.md#scenes) of datasets to images, image sequences, raw
frames, and video on the machine's GPU, with the same renderer as the browser. Its inputs are
latkit's JSON, so any language can write them: a dataset is a [JSON document](guide.md#json),
latkit's [bytes](guide.md#bytes), or GeoJSON named with `NAME=`. The
[command reference](reference/cli.md) documents every command and option.

```sh
cargo install latkit-cli   # or, from the repository: cargo build --locked -p latkit-cli --profile cli
latkit validate scene.json -d grid.json        # check every input without a GPU
latkit render scene.json -d grid.json -o grid.png --size 2400x1350 --scale 2
latkit render scene.json -d grid.json --camera '{"center":[-97,31],"zoom":5,"pitch":0,"bearing":0}' -o tx.png
latkit render map.json plot.json -d grid.json -d states=usa.geojson \
  --panel 0,0,1,0.8 --panel 0,0.8,1,0.2 --frames frames.jsonl --fps 60 -o film.mp4
latkit render scene.json -d grid.json --frames - --format y4m -o - | ffmpeg -i - film.webm
latkit render scene.json -d grid.json --frames frames.jsonl -o frames/%04d.png
latkit inspect grid.bin                        # tables, fields, and the axis, as JSON
latkit query grid.bin '{"of":"Branch","filter":{"op":"gt","args":["loading",90]},"limit":20}'
latkit tile history.bin -o history/            # time tiles, which --tiles opens
latkit render plot.json --tiles grid=history/frames.json -o year.png
latkit schema scene > scene.schema.json
```

At most one input reads stdin (`-`).

## Frames

`--frames` is a JSON Lines file with one line per output frame; line `n` shows at `n / --fps`
seconds. Every key is optional:

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

| Key      | Changes                                                                        |
| -------- | ------------------------------------------------------------------------------ |
| `at`     | the axis coordinate every view shows                                           |
| `patch`  | patches by dataset name, applied in order, in latkit's JSON                    |
| `camera` | where views look, set at once; `fly` eases there over twice the scene's `ease` |
| `fit`    | what views frame                                                               |
| `insets` | CSS pixels each view keeps clear                                               |
| `orbit`  | degrees per second a map or plane turns                                        |

`camera`, `fly`, and `fit` take one value for every view, or a list with one per view (`null`
leaves that view unchanged). The CLI reads and loads up to two frames ahead of the one drawing.
Changes ease over each scene's `ease`; set `"ease": 0` to show each frame's data without easing.

## Outputs

| Output                   | Writes                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `.png`, `.jpg`, `.webp`  | one picture; JPEG at `--quality`                                 |
| `frame-%04d.png`         | one image per frame (`--frames`)                                 |
| `.rgba`, `--format rgba` | straight-alpha RGBA, frames back to back                         |
| `.y4m`                   | YUV4MPEG2, 4:2:0 BT.709, for any encoder (`--frames`)            |
| `.mp4`                   | H.264 in fragmented MP4 from the platform's encoder (`--frames`) |

A still waits until every view is complete and motion has settled; `--elapsed` sets the time its
animated effects show. A video frame where nothing moved repeats the frame before. An output file is
replaced only once it is completely written. MP4 needs Windows (Media Foundation); elsewhere, pipe
Y4M to an encoder. `--deadline` limits how long each picture or video frame may take (30 seconds by
default).

## Diagnostics

Exit codes: 0 success, 1 failure, 2 usage error. Errors print as `latkit: SOURCE: message`, where
`SOURCE` is the input file at fault; for invalid input, the message starts with the path to the
invalid part, such as `frames[3].patch.grid[0].Bus.x`. An output that cannot be written is named in
the message. `--diagnostics json` writes one JSON object per line to stderr, `{ type, detail }`:
`progress` after each frame, `stats` when done, and `error` with its `code`, `message`, `path`, and
`source`.
