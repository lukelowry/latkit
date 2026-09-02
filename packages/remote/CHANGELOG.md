# @latkit/remote

## 0.2.0

### Minor Changes

- 299e99f: Add `serveResults` and `connectResults`: a `Results` served across a port, one class's batches per stream, with an optional `maxSignals` bound on what one read may select.

### Patch Changes

- Updated dependencies [299e99f]
  - @latkit/model@0.2.0

## 0.1.0

### Minor Changes

- e65dc17: Add `@latkit/remote`: a `@latkit/model` model served across a `@latkit/port`. `serveSource` and
  `connectSource` carry a source, its runner as one stream, and the reopen that continues a lineage;
  `serveGrid` and `connectGrid` carry a grid as its header and windows of display text.

### Patch Changes

- Updated dependencies [e65dc17]
  - @latkit/port@0.1.0
