# Command reference

Generated from Clap. See the [CLI guide](../cli.md) for examples.

## latkit

```text
Render scenes of JSON or binary data to images and videos

Usage: latkit [OPTIONS] <COMMAND>

Commands:
  render    Draw scenes of datasets into an image, image sequence, raw frames, or a video
  validate  Check everything render reads, frames included, without a GPU
  inspect   Describe datasets as JSON: tables, rows, fields and their kinds, the axis and its span
  schema    Print the JSON Schema of what latkit reads: every input, or one of them
  query     Read rows back as JSON Lines, an object a row: those a query keeps, sorted and paged
  tile      Write a dataset as time tiles: frames.json, which --tiles opens, the dataset without its sampled fields' histories, and their spans at every level of detail
  help      Print this message or the help of the given subcommand(s)

Options:
      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help

  -V, --version
          Print version
```

## render

```text
Draw scenes of datasets into an image, image sequence, raw frames, or a video

Usage: latkit render [OPTIONS] <SCENE>...

Arguments:
  <SCENE>...
          Scene JSON files, one per panel; - reads stdin

Options:
  -d, --data <[NAME=]FILE>
          A dataset: JSON document, latkit bytes, or GeoJSON (which needs a NAME); NAME= renames it

      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

      --tiles <NAME=FILE>
          Tiles every view fetches as dataset NAME: time tiles' frames.json, or vector tiles' PMTiles file, TileJSON, or {z}/{x}/{y} template

  -o, --output <FILE>
          Image file, %d pattern for an image sequence, or - for stdout

      --format <FORMAT>
          What to write; otherwise the output's extension says, or PNG for stdout

          Possible values:
          - png:  PNG, lossless with alpha: one picture, or one a frame where the output has a %d pattern
          - jpeg: JPEG at --quality, its alpha dropped: one picture, or one a frame
          - webp: WebP, lossless with alpha: one picture, or one a frame
          - rgba: Raw RGBA, straight alpha, frames back to back
          - y4m:  YUV4MPEG2: 4:2:0 BT.709 limited range, for any encoder
          - mp4:  H.264 in fragmented MP4, from the platform's encoder

      --quality <QUALITY>
          A JPEG's quality, from 1, smallest, to 100, sharpest

          [default: 90]

      --size <SIZE>
          The picture's width and height in pixels, such as 1920x1080

          [default: 1600x900]

      --scale <SCALE>
          Pixels per CSS pixel: views lay out size / scale CSS pixels, so 2 draws twice as sharp

          [default: 1]

      --panel <X,Y,W,H>
          A scene's panel of the picture, X,Y,WIDTH,HEIGHT as fractions; one per scene, in order

      --transparent
          Keep alpha where the themes' backgrounds would be

      --deadline <DEADLINE>
          The longest a picture, or a video frame, may take, in seconds

          [default: 30]

      --font <FILE>
          TTF/OTF/TTC file; repeat for fallbacks; replaces system fonts

      --camera <FILE>
          Camera JSON for a scene, in scene order; a view without one fits

      --fit <FIT>
          What a view without a camera frames: "all", or a fit as JSON

          [default: all]

      --insets <T,R,B,L>
          CSS pixels kept clear at the top, right, bottom, and left, T,R,B,L

      --at <AT>
          The axis coordinate shown; sampled fields read their last frame at or before it

      --elapsed <ELAPSED>
          A still's effect time in seconds, where elapsed time and flowing comets read it

      --frames <FILE>
          Frames as JSON Lines, one per output frame, or - for stdin

      --fps <FPS>
          Output frames a second

          [default: 60]

      --bitrate <BITRATE>
          MP4 bits a second; about 0.15 bits a pixel a frame otherwise

  -h, --help
          Print help (see a summary with '-h')
```

## validate

```text
Check everything render reads, frames included, without a GPU

Usage: latkit validate [OPTIONS] <SCENE>...

Arguments:
  <SCENE>...
          Scene JSON files, one per panel; - reads stdin

Options:
  -d, --data <[NAME=]FILE>
          A dataset: JSON document, latkit bytes, or GeoJSON (which needs a NAME); NAME= renames it

      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

      --tiles <NAME=FILE>
          Tiles every view fetches as dataset NAME: time tiles' frames.json, or vector tiles' PMTiles file, TileJSON, or {z}/{x}/{y} template

  -o, --output <FILE>
          Image file, %d pattern for an image sequence, or - for stdout

      --format <FORMAT>
          What to write; otherwise the output's extension says, or PNG for stdout

          Possible values:
          - png:  PNG, lossless with alpha: one picture, or one a frame where the output has a %d pattern
          - jpeg: JPEG at --quality, its alpha dropped: one picture, or one a frame
          - webp: WebP, lossless with alpha: one picture, or one a frame
          - rgba: Raw RGBA, straight alpha, frames back to back
          - y4m:  YUV4MPEG2: 4:2:0 BT.709 limited range, for any encoder
          - mp4:  H.264 in fragmented MP4, from the platform's encoder

      --quality <QUALITY>
          A JPEG's quality, from 1, smallest, to 100, sharpest

          [default: 90]

      --size <SIZE>
          The picture's width and height in pixels, such as 1920x1080

          [default: 1600x900]

      --scale <SCALE>
          Pixels per CSS pixel: views lay out size / scale CSS pixels, so 2 draws twice as sharp

          [default: 1]

      --panel <X,Y,W,H>
          A scene's panel of the picture, X,Y,WIDTH,HEIGHT as fractions; one per scene, in order

      --transparent
          Keep alpha where the themes' backgrounds would be

      --deadline <DEADLINE>
          The longest a picture, or a video frame, may take, in seconds

          [default: 30]

      --font <FILE>
          TTF/OTF/TTC file; repeat for fallbacks; replaces system fonts

      --camera <FILE>
          Camera JSON for a scene, in scene order; a view without one fits

      --fit <FIT>
          What a view without a camera frames: "all", or a fit as JSON

          [default: all]

      --insets <T,R,B,L>
          CSS pixels kept clear at the top, right, bottom, and left, T,R,B,L

      --at <AT>
          The axis coordinate shown; sampled fields read their last frame at or before it

      --elapsed <ELAPSED>
          A still's effect time in seconds, where elapsed time and flowing comets read it

      --frames <FILE>
          Frames as JSON Lines, one per output frame, or - for stdin

      --fps <FPS>
          Output frames a second

          [default: 60]

      --bitrate <BITRATE>
          MP4 bits a second; about 0.15 bits a pixel a frame otherwise

  -h, --help
          Print help (see a summary with '-h')
```

## inspect

```text
Describe datasets as JSON: tables, rows, fields and their kinds, the axis and its span

Usage: latkit inspect [OPTIONS] <[NAME=]FILE>...

Arguments:
  <[NAME=]FILE>...
          Dataset files, each [NAME=]FILE; - reads stdin

Options:
      --deadline <DEADLINE>
          The longest a dataset may take to load, in seconds

          [default: 30]

      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help
```

## schema

```text
Print the JSON Schema of what latkit reads: every input, or one of them

Usage: latkit schema [OPTIONS] [INPUT]

Arguments:
  [INPUT]
          One input's schema

          Possible values:
          - scene:  A scene
          - data:   A dataset's JSON document
          - patch:  A patch's JSON
          - query:  A query of `latkit query`
          - camera: A camera of `--camera`
          - fit:    A fit of `--fit`
          - frames: A line of `--frames`

Options:
      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help (see a summary with '-h')
```

## query

```text
Read rows back as JSON Lines, an object a row: those a query keeps, sorted and paged

Usage: latkit query [OPTIONS] <[NAME=]FILE> <QUERY>

Arguments:
  <[NAME=]FILE>
          The dataset, [NAME=]FILE; - reads stdin

  <QUERY>
          The query: JSON such as {"of":"Branch","filter":{"op":"gt","args":["loading",90]}}, or a file of it

Options:
      --deadline <DEADLINE>
          The longest the dataset may take to load, in seconds

          [default: 30]

      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help
```

## tile

```text
Write a dataset as time tiles: frames.json, which --tiles opens, the dataset without its sampled fields' histories, and their spans at every level of detail

Usage: latkit tile [OPTIONS] --output <DIR> <[NAME=]FILE>

Arguments:
  <[NAME=]FILE>
          The dataset, [NAME=]FILE; - reads stdin

Options:
      --diagnostics <DIAGNOSTICS>
          Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line

          [default: human]
          [possible values: human, json]

  -o, --output <DIR>
          The directory the tiles go in

      --chunk <CHUNK>
          Entries a span holds: frames, or buckets of a level of detail; a multiple of 8

          [default: 256]

      --deadline <DEADLINE>
          The longest the dataset may take to load, in seconds

          [default: 30]

  -h, --help
          Print help
```

## help

```text
Print this message or the help of the given subcommand(s)

Usage: latkit help [COMMAND]...

Arguments:
  [COMMAND]...
          Print help for the subcommand(s)
```
