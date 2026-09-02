# @latkit/port

## 0.1.0

### Minor Changes

- e65dc17: Add `@latkit/port`: a two-method `Port` over workers, webviews, and sockets (`messagePort`,
  `bytePort`, `socketPort`); one versioned binary frame that carries typed arrays intact; and typed
  request, reply, and stream protocols (`protocol`, `serve`, `connect`) with guards from
  `@latkit/port/guard` and an in-memory pair in `@latkit/port/testing`.
