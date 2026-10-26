# Command reference

Every command and option of the `latkit` command line, written from its help. The [command-line guide](../cli.md) shows them at work. `--help` prints a command's help in the terminal, and `latkit --version` prints the version.

(cli-latkit)=

## `latkit`

{.signature}
`latkit [OPTIONS] <COMMAND>`

Render scenes of JSON or binary data to images and videos.

```{rubric} Commands
```

{.member}
[`latkit render`](#cli-render)
: Draw scenes of datasets into an image, image sequence, raw frames, or a video.

{.member}
[`latkit validate`](#cli-validate)
: Check every input render reads, including frames, without a GPU.

{.member}
[`latkit inspect`](#cli-inspect)
: Describe datasets as JSON: tables, row counts, fields with kinds, and the axis and its span.

{.member}
[`latkit schema`](#cli-schema)
: Print the JSON Schema of every input latkit reads, or of one input.

{.member}
[`latkit query`](#cli-query)
: Print the rows a query selects, sorted and paged, as JSON Lines with one object per row.

{.member}
[`latkit tile`](#cli-tile)
: Write a dataset as time tiles: `frames.json` (which [`--tiles`](#cli-render-tiles) opens), the dataset without its sampled fields' histories, and those histories in spans at every level of detail.

```{rubric} Options
```

{#cli-latkit-diagnostics .member}
**`--diagnostics`** `<DIAGNOSTICS>` [¶](#cli-latkit-diagnostics){.headerlink}
: Format of errors and render progress on stderr. Defaults to `human`. Every command takes it.

  {#cli-latkit-diagnostics-human .member}
  **`human`** [¶](#cli-latkit-diagnostics-human){.headerlink}
  : Lines of text, for people.

  {#cli-latkit-diagnostics-json .member}
  **`json`** [¶](#cli-latkit-diagnostics-json){.headerlink}
  : One JSON object per line, for programs.

(cli-render)=

## `latkit render`

{.signature}
`latkit render [OPTIONS] <SCENE>...`

Draw scenes of datasets into an image, image sequence, raw frames, or a video.

```{rubric} Arguments
```

{#cli-render-scenes .member}
**`<SCENE>...`** [¶](#cli-render-scenes){.headerlink}
: Scene JSON files, one per panel (`-` reads stdin).

```{rubric} Options
```

{#cli-render-data .member}
`-d,` **`--data`** `<[NAME=]FILE>` [¶](#cli-render-data){.headerlink}
: A dataset file: a JSON document, latkit bytes, or GeoJSON. `NAME=` sets its name, which GeoJSON requires.

{#cli-render-tiles .member}
**`--tiles`** `<NAME=FILE>` [¶](#cli-render-tiles){.headerlink}
: Tiles every view fetches as dataset `NAME`: a time tiles `frames.json`, or a vector tiles PMTiles file, TileJSON, or `{z}/{x}/{y}` template.

{#cli-render-output .member}
`-o,` **`--output`** `<FILE>` [¶](#cli-render-output){.headerlink}
: Output file, `%d` pattern for an image sequence, or `-` for stdout.

{#cli-render-format .member}
**`--format`** `<FORMAT>` [¶](#cli-render-format){.headerlink}
: Output format. Defaults to the one the output's extension names, else PNG.

  {#cli-render-format-png .member}
  **`png`** [¶](#cli-render-format-png){.headerlink}
  : PNG, lossless with alpha. One picture, or one per frame with a `%d` output pattern.

  {#cli-render-format-jpeg .member}
  **`jpeg`** [¶](#cli-render-format-jpeg){.headerlink}
  : JPEG at [`--quality`](#cli-render-quality), without alpha. One picture, or one per frame.

  {#cli-render-format-webp .member}
  **`webp`** [¶](#cli-render-format-webp){.headerlink}
  : Lossless WebP with alpha. One picture, or one per frame.

  {#cli-render-format-rgba .member}
  **`rgba`** [¶](#cli-render-format-rgba){.headerlink}
  : Raw RGBA with straight alpha, frames back to back.

  {#cli-render-format-y4m .member}
  **`y4m`** [¶](#cli-render-format-y4m){.headerlink}
  : YUV4MPEG2 (4:2:0, BT.709 limited range), which any encoder reads.

  {#cli-render-format-mp4 .member}
  **`mp4`** [¶](#cli-render-format-mp4){.headerlink}
  : H.264 in fragmented MP4, from the platform's encoder.

{#cli-render-quality .member}
**`--quality`** `<QUALITY>` [¶](#cli-render-quality){.headerlink}
: JPEG quality, from 1 (smallest) to 100 (sharpest). Defaults to `90`.

{#cli-render-size .member}
**`--size`** `<SIZE>` [¶](#cli-render-size){.headerlink}
: The picture's width and height in pixels, such as `1920x1080`. Defaults to `1600x900`.

{#cli-render-scale .member}
**`--scale`** `<SCALE>` [¶](#cli-render-scale){.headerlink}
: Pixels per CSS pixel. Views lay out size / scale CSS pixels, so 2 draws twice as sharp. Defaults to `1`.

{#cli-render-panel .member}
**`--panel`** `<X,Y,W,H>` [¶](#cli-render-panel){.headerlink}
: A scene's panel of the picture: its x, y, width, and height, as fractions. Give one per scene, in order.

{#cli-render-transparent .member}
**`--transparent`** [¶](#cli-render-transparent){.headerlink}
: Keep alpha where the themes' backgrounds would be.

{#cli-render-deadline .member}
**`--deadline`** `<DEADLINE>` [¶](#cli-render-deadline){.headerlink}
: The longest a picture or video frame may take, in seconds. Defaults to `30`.

{#cli-render-font .member}
**`--font`** `<FILE>` [¶](#cli-render-font){.headerlink}
: A TTF, OTF, or TTC font file. Repeat for fallbacks. Replaces the system fonts.

{#cli-render-camera .member}
**`--camera`** `<FILE>` [¶](#cli-render-camera){.headerlink}
: A camera JSON file per scene, in scene order. Views without one use [`--fit`](#cli-render-fit).

{#cli-render-fit .member}
**`--fit`** `<FIT>` [¶](#cli-render-fit){.headerlink}
: What views without a camera frame: `all`, or a fit as JSON. Defaults to `all`.

{#cli-render-insets .member}
**`--insets`** `<T,R,B,L>` [¶](#cli-render-insets){.headerlink}
: CSS pixels to keep clear at the top, right, bottom, and left.

{#cli-render-at .member}
**`--at`** `<AT>` [¶](#cli-render-at){.headerlink}
: The axis coordinate to show. Sampled fields show their last frame at or before it.

{#cli-render-elapsed .member}
**`--elapsed`** `<ELAPSED>` [¶](#cli-render-elapsed){.headerlink}
: A still's fixed effect time in seconds, for elapsed-time expressions and flowing comets.

{#cli-render-frames .member}
**`--frames`** `<FILE>` [¶](#cli-render-frames){.headerlink}
: Frames as JSON Lines, one line per output frame (`-` reads stdin).

{#cli-render-fps .member}
**`--fps`** `<FPS>` [¶](#cli-render-fps){.headerlink}
: Output frames per second. Defaults to `60`.

{#cli-render-bitrate .member}
**`--bitrate`** `<BITRATE>` [¶](#cli-render-bitrate){.headerlink}
: MP4 bitrate in bits per second. Defaults to about 0.15 bits per pixel per frame.

(cli-validate)=

## `latkit validate`

{.signature}
`latkit validate [OPTIONS] <SCENE>...`

Check every input render reads, including frames, without a GPU.

```{rubric} Arguments
```

{#cli-validate-scenes .member}
**`<SCENE>...`** [¶](#cli-validate-scenes){.headerlink}
: Scene JSON files, one per panel (`-` reads stdin).

```{rubric} Options
```

{#cli-validate-data .member}
`-d,` **`--data`** `<[NAME=]FILE>` [¶](#cli-validate-data){.headerlink}
: A dataset file: a JSON document, latkit bytes, or GeoJSON. `NAME=` sets its name, which GeoJSON requires.

{#cli-validate-tiles .member}
**`--tiles`** `<NAME=FILE>` [¶](#cli-validate-tiles){.headerlink}
: Tiles every view fetches as dataset `NAME`: a time tiles `frames.json`, or a vector tiles PMTiles file, TileJSON, or `{z}/{x}/{y}` template.

{#cli-validate-output .member}
`-o,` **`--output`** `<FILE>` [¶](#cli-validate-output){.headerlink}
: Output file, `%d` pattern for an image sequence, or `-` for stdout.

{#cli-validate-format .member}
**`--format`** `<FORMAT>` [¶](#cli-validate-format){.headerlink}
: Output format. Defaults to the one the output's extension names, else PNG.

  {#cli-validate-format-png .member}
  **`png`** [¶](#cli-validate-format-png){.headerlink}
  : PNG, lossless with alpha. One picture, or one per frame with a `%d` output pattern.

  {#cli-validate-format-jpeg .member}
  **`jpeg`** [¶](#cli-validate-format-jpeg){.headerlink}
  : JPEG at [`--quality`](#cli-validate-quality), without alpha. One picture, or one per frame.

  {#cli-validate-format-webp .member}
  **`webp`** [¶](#cli-validate-format-webp){.headerlink}
  : Lossless WebP with alpha. One picture, or one per frame.

  {#cli-validate-format-rgba .member}
  **`rgba`** [¶](#cli-validate-format-rgba){.headerlink}
  : Raw RGBA with straight alpha, frames back to back.

  {#cli-validate-format-y4m .member}
  **`y4m`** [¶](#cli-validate-format-y4m){.headerlink}
  : YUV4MPEG2 (4:2:0, BT.709 limited range), which any encoder reads.

  {#cli-validate-format-mp4 .member}
  **`mp4`** [¶](#cli-validate-format-mp4){.headerlink}
  : H.264 in fragmented MP4, from the platform's encoder.

{#cli-validate-quality .member}
**`--quality`** `<QUALITY>` [¶](#cli-validate-quality){.headerlink}
: JPEG quality, from 1 (smallest) to 100 (sharpest). Defaults to `90`.

{#cli-validate-size .member}
**`--size`** `<SIZE>` [¶](#cli-validate-size){.headerlink}
: The picture's width and height in pixels, such as `1920x1080`. Defaults to `1600x900`.

{#cli-validate-scale .member}
**`--scale`** `<SCALE>` [¶](#cli-validate-scale){.headerlink}
: Pixels per CSS pixel. Views lay out size / scale CSS pixels, so 2 draws twice as sharp. Defaults to `1`.

{#cli-validate-panel .member}
**`--panel`** `<X,Y,W,H>` [¶](#cli-validate-panel){.headerlink}
: A scene's panel of the picture: its x, y, width, and height, as fractions. Give one per scene, in order.

{#cli-validate-transparent .member}
**`--transparent`** [¶](#cli-validate-transparent){.headerlink}
: Keep alpha where the themes' backgrounds would be.

{#cli-validate-deadline .member}
**`--deadline`** `<DEADLINE>` [¶](#cli-validate-deadline){.headerlink}
: The longest a picture or video frame may take, in seconds. Defaults to `30`.

{#cli-validate-font .member}
**`--font`** `<FILE>` [¶](#cli-validate-font){.headerlink}
: A TTF, OTF, or TTC font file. Repeat for fallbacks. Replaces the system fonts.

{#cli-validate-camera .member}
**`--camera`** `<FILE>` [¶](#cli-validate-camera){.headerlink}
: A camera JSON file per scene, in scene order. Views without one use [`--fit`](#cli-validate-fit).

{#cli-validate-fit .member}
**`--fit`** `<FIT>` [¶](#cli-validate-fit){.headerlink}
: What views without a camera frame: `all`, or a fit as JSON. Defaults to `all`.

{#cli-validate-insets .member}
**`--insets`** `<T,R,B,L>` [¶](#cli-validate-insets){.headerlink}
: CSS pixels to keep clear at the top, right, bottom, and left.

{#cli-validate-at .member}
**`--at`** `<AT>` [¶](#cli-validate-at){.headerlink}
: The axis coordinate to show. Sampled fields show their last frame at or before it.

{#cli-validate-elapsed .member}
**`--elapsed`** `<ELAPSED>` [¶](#cli-validate-elapsed){.headerlink}
: A still's fixed effect time in seconds, for elapsed-time expressions and flowing comets.

{#cli-validate-frames .member}
**`--frames`** `<FILE>` [¶](#cli-validate-frames){.headerlink}
: Frames as JSON Lines, one line per output frame (`-` reads stdin).

{#cli-validate-fps .member}
**`--fps`** `<FPS>` [¶](#cli-validate-fps){.headerlink}
: Output frames per second. Defaults to `60`.

{#cli-validate-bitrate .member}
**`--bitrate`** `<BITRATE>` [¶](#cli-validate-bitrate){.headerlink}
: MP4 bitrate in bits per second. Defaults to about 0.15 bits per pixel per frame.

(cli-inspect)=

## `latkit inspect`

{.signature}
`latkit inspect [OPTIONS] <[NAME=]FILE>...`

Describe datasets as JSON: tables, row counts, fields with kinds, and the axis and its span.

```{rubric} Arguments
```

{#cli-inspect-data .member}
**`<[NAME=]FILE>...`** [¶](#cli-inspect-data){.headerlink}
: Dataset files, each `[NAME=]FILE` (`-` reads stdin).

```{rubric} Options
```

{#cli-inspect-deadline .member}
**`--deadline`** `<DEADLINE>` [¶](#cli-inspect-deadline){.headerlink}
: The longest a dataset may take to load, in seconds. Defaults to `30`.

(cli-schema)=

## `latkit schema`

{.signature}
`latkit schema [OPTIONS] [INPUT]`

Print the JSON Schema of every input latkit reads, or of one input.

```{rubric} Arguments
```

{#cli-schema-input .member}
**`[INPUT]`** [¶](#cli-schema-input){.headerlink}
: Print only this input's schema.

  {#cli-schema-input-scene .member}
  **`scene`** [¶](#cli-schema-input-scene){.headerlink}
  : A scene.

  {#cli-schema-input-data .member}
  **`data`** [¶](#cli-schema-input-data){.headerlink}
  : A dataset's JSON document.

  {#cli-schema-input-patch .member}
  **`patch`** [¶](#cli-schema-input-patch){.headerlink}
  : A patch.

  {#cli-schema-input-query .member}
  **`query`** [¶](#cli-schema-input-query){.headerlink}
  : A query for [`latkit query`](#cli-query).

  {#cli-schema-input-camera .member}
  **`camera`** [¶](#cli-schema-input-camera){.headerlink}
  : A camera for [`--camera`](#cli-render-camera).

  {#cli-schema-input-fit .member}
  **`fit`** [¶](#cli-schema-input-fit){.headerlink}
  : A fit for [`--fit`](#cli-render-fit).

  {#cli-schema-input-frames .member}
  **`frames`** [¶](#cli-schema-input-frames){.headerlink}
  : One line of a [`--frames`](#cli-render-frames) file.

(cli-query)=

## `latkit query`

{.signature}
`latkit query [OPTIONS] <[NAME=]FILE> <QUERY>`

Print the rows a query selects, sorted and paged, as JSON Lines with one object per row.

```{rubric} Arguments
```

{#cli-query-data .member}
**`<[NAME=]FILE>`** [¶](#cli-query-data){.headerlink}
: The dataset, `[NAME=]FILE` (`-` reads stdin).

{#cli-query-query .member}
**`<QUERY>`** [¶](#cli-query-query){.headerlink}
: The query as JSON, such as `{"of":"Branch","filter":{"op":"gt","args":["loading",90]}}`, or a file containing it (`-` reads stdin).

```{rubric} Options
```

{#cli-query-deadline .member}
**`--deadline`** `<DEADLINE>` [¶](#cli-query-deadline){.headerlink}
: The longest the dataset may take to load, in seconds. Defaults to `30`.

(cli-tile)=

## `latkit tile`

{.signature}
`latkit tile [OPTIONS] --output <DIR> <[NAME=]FILE>`

Write a dataset as time tiles: `frames.json` (which [`--tiles`](#cli-render-tiles) opens), the dataset without its sampled fields' histories, and those histories in spans at every level of detail.

```{rubric} Arguments
```

{#cli-tile-data .member}
**`<[NAME=]FILE>`** [¶](#cli-tile-data){.headerlink}
: The dataset, `[NAME=]FILE` (`-` reads stdin).

```{rubric} Options
```

{#cli-tile-output .member}
`-o,` **`--output`** `<DIR>` [¶](#cli-tile-output){.headerlink}
: Directory to write the tiles to.

{#cli-tile-chunk .member}
**`--chunk`** `<CHUNK>` [¶](#cli-tile-chunk){.headerlink}
: Entries per span: frames at full detail, buckets at coarser levels. A multiple of 8. Defaults to `256`.

{#cli-tile-deadline .member}
**`--deadline`** `<DEADLINE>` [¶](#cli-tile-deadline){.headerlink}
: The longest the dataset may take to load, in seconds. Defaults to `30`.
