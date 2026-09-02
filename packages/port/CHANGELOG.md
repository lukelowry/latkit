# @latkit/port

## 0.2.0

### Minor Changes

- 4219e1e: Narrow the root barrel to `messagePort`, `bytePort`, `socketPort`, `protocol`, `serve`, `connect`, `transferred`, `describeError` and the types `Port`, `Protocol`, `Service`, `Connection`. `ByteTarget`, `MessageTarget`, `SocketTarget`, `Progress`, `Handler`, `CallOptions`, and the `Transferred` class are no longer exported (the constructors take their targets structurally, and call options are inline on `call` and `stream`); `Guard` is imported from `@latkit/port/guard`.

## 0.1.0

### Minor Changes

- e65dc17: Add `@latkit/port`: a two-method `Port` over workers, webviews, and sockets (`messagePort`,
  `bytePort`, `socketPort`); one versioned binary frame that carries typed arrays intact; and typed
  request, reply, and stream protocols (`protocol`, `serve`, `connect`) with guards from
  `@latkit/port/guard` and an in-memory pair in `@latkit/port/testing`.
