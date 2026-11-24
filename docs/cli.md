# Render from the command line

From the repository root, render the [Hawaiʻi one-line](examples/hawaii.md) from its checked-in scene and drawing data.

```sh
cargo install latkit-cli
latkit validate docs/gallery/hawaii/scene.json -d docs/gallery/hawaii/data.json
latkit render docs/gallery/hawaii/scene.json -d docs/gallery/hawaii/data.json --camera docs/gallery/hawaii/camera.json --size 3804x1842 --scale 2 -o hawaii.png
```

## Render a recording

The [WECC240 example](examples/wecc.md) puts a map and two traces in one frame. With Python 3.10+ and the CLI installed, render a still at 1.12 s. The case and recording are included.

```sh
python crates/latkit-cli/examples/wecc240-fault/render.py --preview --at 1.12 --output target/wecc
```

On Windows, render the first two seconds of playback at 60 fps. The script writes `target/wecc/animation.mp4`. Omit `--limit 120` for the full recording.

```sh
python crates/latkit-cli/examples/wecc240-fault/render.py --limit 120 --output target/wecc
```

Run the script with `--prepare-only` to inspect its scenes, frame file and CLI command. The [CLI reference](reference/cli.md) lists individual flags.

## Frames

`--frames` is a JSON Lines file with one line per output frame, or with [`--span`](#spans), lines
at axis coordinates. Line `n` shows at `n / --fps` seconds. Every key is optional:

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

`camera`, `fly`, and `fit` take one value for every view, or a list with one value per view (`null`
leaves that view unchanged). A camera or flight replaces a pending fit. The CLI loads up to two
frames ahead of the one it draws. Changes ease over each scene's `ease`; `"ease": 0` shows each
frame's data as is.

## Spans

`--span FROM,TO` plays an axis interval at `--rate` units per second (default 1). A video or image
sequence without `--frames` plays the datasets' span.

With `--span`, each line needs `at`, in order, and applies when playback reaches it. Between lines
that set a view's camera, the view flies from one to the next:

```text
{"at": 0.6, "camera": {"center": [-92, 36.5], "zoom": 5.09, "pitch": 48, "bearing": -10}}
{"at": 1, "patch": {"grid": [{"set": {"table": "Branch", "ids": ["b1"], "fields": {"open": [true]}}}]}}
{"at": 10, "camera": {"center": [-92, 36.5], "zoom": 5.09, "pitch": 48, "bearing": 20}}
```

## Outputs

| Output                   | Writes                                              |
| ------------------------ | --------------------------------------------------- |
| `.png`, `.jpg`, `.webp`  | one picture; JPEG at `--quality`                    |
| `frame-%04d.png`         | one image per frame                                 |
| `.rgba`, `--format rgba` | straight-alpha RGBA, frames back to back            |
| `.y4m`                   | YUV4MPEG2, 4:2:0 BT.709, for any encoder            |
| `.mp4`                   | H.264 in fragmented MP4 from the platform's encoder |

A still picture waits until every view is complete and motion has settled. `--elapsed` sets the
time its animated effects show. A video frame where nothing moved repeats the frame before. An
output file is replaced only once the new file is completely written. MP4 needs Windows (Media
Foundation). On other systems, pipe Y4M to an encoder. `--deadline` limits how long each picture or
video frame may take, and defaults to 30 seconds.

## Diagnostics

Exit codes are 0 for success, 1 for failure, and 2 for a usage error. Errors print as
`latkit: SOURCE: message`, where `SOURCE` is the input file at fault. For invalid input, the
message starts with the path to the invalid part, such as `frames[3].patch.grid[0].Bus.x`. When an
output cannot be written, the message names it. `--diagnostics json` writes one JSON object per
line to stderr, `{ type, detail }`. The `type` is `progress` after each frame, `stats` when done,
or `error` with its `code`, `message`, `path`, and `source`.
