# Command reference

Generated from Clap. See the [CLI guide](../cli.md) for examples.

## latkit

```text
Render scenes of JSON or binary data to images and videos

Usage: latkit [OPTIONS] <COMMAND>

Commands:
  render    Draw scenes of datasets into an image, image sequence, raw frames, or a video
  validate  Check every input render reads, including frames, without a GPU
  inspect   Describe datasets as JSON: tables, row counts, fields with kinds, and the axis and its span
  schema    Print the JSON Schema of every input latkit reads, or of one input
  query     Print the rows a query selects, sorted and paged, as JSON Lines with one object per row
  tile      Write a dataset as time tiles: frames.json (which --tiles opens), the dataset without its sampled fields' histories, and those histories in spans at every level of detail
  help      Print this message or the help of the given subcommand(s)

Options:
      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

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
          Scene JSON files, one per panel (- reads stdin)

Options:
  -d, --data <[NAME=]FILE>
          A dataset file: a JSON document, latkit bytes, or GeoJSON. NAME= sets its name, which GeoJSON requires

      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

      --tiles <NAME=FILE>
          Tiles every view fetches as dataset NAME: a time tiles frames.json, or a vector tiles PMTiles file, TileJSON, or {z}/{x}/{y} template

  -o, --output <FILE>
          Output file, %d pattern for an image sequence, or - for stdout

      --format <FORMAT>
          Output format. Defaults to the one the output's extension names, else PNG

          Possible values:
          - png:  PNG, lossless with alpha. One picture, or one per frame with a %d output pattern
          - jpeg: JPEG at --quality, without alpha. One picture, or one per frame
          - webp: Lossless WebP with alpha. One picture, or one per frame
          - rgba: Raw RGBA with straight alpha, frames back to back
          - y4m:  YUV4MPEG2 (4:2:0, BT.709 limited range), which any encoder reads
          - mp4:  H.264 in fragmented MP4, from the platform's encoder

      --quality <QUALITY>
          JPEG quality, from 1 (smallest) to 100 (sharpest)

          [default: 90]

      --size <SIZE>
          The picture's width and height in pixels, such as 1920x1080

          [default: 1600x900]

      --scale <SCALE>
          Pixels per CSS pixel. Views lay out size / scale CSS pixels, so 2 draws twice as sharp

          [default: 1]

      --panel <X,Y,W,H>
          A scene's panel of the picture, as X,Y,WIDTH,HEIGHT fractions. Give one per scene, in order

      --transparent
          Keep alpha where the themes' backgrounds would be

      --deadline <DEADLINE>
          The longest a picture or video frame may take, in seconds

          [default: 30]

      --font <FILE>
          A TTF, OTF, or TTC font file. Repeat for fallbacks. Replaces the system fonts

      --camera <FILE>
          A camera JSON file per scene, in scene order. Views without one use --fit

      --fit <FIT>
          What views without a camera frame: "all", or a fit as JSON

          [default: all]

      --insets <T,R,B,L>
          CSS pixels to keep clear at the top, right, bottom, and left

      --at <AT>
          The axis coordinate to show. Sampled fields show their last frame at or before it

      --elapsed <ELAPSED>
          A still's fixed effect time in seconds, for elapsed-time expressions and flowing comets

      --frames <FILE>
          Frames as JSON Lines, one line per output frame (- reads stdin)

      --fps <FPS>
          Output frames per second

          [default: 60]

      --bitrate <BITRATE>
          MP4 bitrate in bits per second. Defaults to about 0.15 bits per pixel per frame

  -h, --help
          Print help (see a summary with '-h')
```

## validate

```text
Check every input render reads, including frames, without a GPU

Usage: latkit validate [OPTIONS] <SCENE>...

Arguments:
  <SCENE>...
          Scene JSON files, one per panel (- reads stdin)

Options:
  -d, --data <[NAME=]FILE>
          A dataset file: a JSON document, latkit bytes, or GeoJSON. NAME= sets its name, which GeoJSON requires

      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

      --tiles <NAME=FILE>
          Tiles every view fetches as dataset NAME: a time tiles frames.json, or a vector tiles PMTiles file, TileJSON, or {z}/{x}/{y} template

  -o, --output <FILE>
          Output file, %d pattern for an image sequence, or - for stdout

      --format <FORMAT>
          Output format. Defaults to the one the output's extension names, else PNG

          Possible values:
          - png:  PNG, lossless with alpha. One picture, or one per frame with a %d output pattern
          - jpeg: JPEG at --quality, without alpha. One picture, or one per frame
          - webp: Lossless WebP with alpha. One picture, or one per frame
          - rgba: Raw RGBA with straight alpha, frames back to back
          - y4m:  YUV4MPEG2 (4:2:0, BT.709 limited range), which any encoder reads
          - mp4:  H.264 in fragmented MP4, from the platform's encoder

      --quality <QUALITY>
          JPEG quality, from 1 (smallest) to 100 (sharpest)

          [default: 90]

      --size <SIZE>
          The picture's width and height in pixels, such as 1920x1080

          [default: 1600x900]

      --scale <SCALE>
          Pixels per CSS pixel. Views lay out size / scale CSS pixels, so 2 draws twice as sharp

          [default: 1]

      --panel <X,Y,W,H>
          A scene's panel of the picture, as X,Y,WIDTH,HEIGHT fractions. Give one per scene, in order

      --transparent
          Keep alpha where the themes' backgrounds would be

      --deadline <DEADLINE>
          The longest a picture or video frame may take, in seconds

          [default: 30]

      --font <FILE>
          A TTF, OTF, or TTC font file. Repeat for fallbacks. Replaces the system fonts

      --camera <FILE>
          A camera JSON file per scene, in scene order. Views without one use --fit

      --fit <FIT>
          What views without a camera frame: "all", or a fit as JSON

          [default: all]

      --insets <T,R,B,L>
          CSS pixels to keep clear at the top, right, bottom, and left

      --at <AT>
          The axis coordinate to show. Sampled fields show their last frame at or before it

      --elapsed <ELAPSED>
          A still's fixed effect time in seconds, for elapsed-time expressions and flowing comets

      --frames <FILE>
          Frames as JSON Lines, one line per output frame (- reads stdin)

      --fps <FPS>
          Output frames per second

          [default: 60]

      --bitrate <BITRATE>
          MP4 bitrate in bits per second. Defaults to about 0.15 bits per pixel per frame

  -h, --help
          Print help (see a summary with '-h')
```

## inspect

```text
Describe datasets as JSON: tables, row counts, fields with kinds, and the axis and its span

Usage: latkit inspect [OPTIONS] <[NAME=]FILE>...

Arguments:
  <[NAME=]FILE>...
          Dataset files, each [NAME=]FILE (- reads stdin)

Options:
      --deadline <DEADLINE>
          The longest a dataset may take to load, in seconds

          [default: 30]

      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help
```

## schema

```text
Print the JSON Schema of every input latkit reads, or of one input

Usage: latkit schema [OPTIONS] [INPUT]

Arguments:
  [INPUT]
          Print only this input's schema

          Possible values:
          - scene:  A scene
          - data:   A dataset's JSON document
          - patch:  A patch
          - query:  A query for `latkit query`
          - camera: A camera for `--camera`
          - fit:    A fit for `--fit`
          - frames: One line of a `--frames` file

Options:
      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help (see a summary with '-h')
```

## query

```text
Print the rows a query selects, sorted and paged, as JSON Lines with one object per row

Usage: latkit query [OPTIONS] <[NAME=]FILE> <QUERY>

Arguments:
  <[NAME=]FILE>
          The dataset, [NAME=]FILE (- reads stdin)

  <QUERY>
          The query as JSON, such as {"of":"Branch","filter":{"op":"gt","args":["loading",90]}}, or a file containing it (- reads stdin)

Options:
      --deadline <DEADLINE>
          The longest the dataset may take to load, in seconds

          [default: 30]

      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

  -h, --help
          Print help
```

## tile

```text
Write a dataset as time tiles: frames.json (which --tiles opens), the dataset without its sampled fields' histories, and those histories in spans at every level of detail

Usage: latkit tile [OPTIONS] --output <DIR> <[NAME=]FILE>

Arguments:
  <[NAME=]FILE>
          The dataset, [NAME=]FILE (- reads stdin)

Options:
      --diagnostics <DIAGNOSTICS>
          Format of errors and render progress on stderr. JSON writes one object per line

          [default: human]
          [possible values: human, json]

  -o, --output <DIR>
          Directory to write the tiles to

      --chunk <CHUNK>
          Entries per span: frames at full detail, buckets at coarser levels. A multiple of 8

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
