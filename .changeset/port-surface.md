---
'@latkit/port': minor
---

Narrow the root barrel to `messagePort`, `bytePort`, `socketPort`, `protocol`, `serve`, `connect`, `transferred`, `describeError` and the types `Port`, `Protocol`, `Service`, `Connection`. `ByteTarget`, `MessageTarget`, `SocketTarget`, `Progress`, `Handler`, `CallOptions`, and the `Transferred` class are no longer exported (the constructors take their targets structurally, and call options are inline on `call` and `stream`); `Guard` is imported from `@latkit/port/guard`.
