---
'@latkit/connect': major
'@latkit/model': minor
---

A model is a value both sides of a connection share, and either side may dial.

Added

- `Model`, `Command`, `MonitorContext`, `CommandContext`, and `Publication` in model: the contract a
  model meets, whether used in process or across a connection.
- `staticFields(schema)` and `sampledFields(schema, types?)` in model.
- `protocol.subprotocols`: `latkit.connect` for a dialing side that offers a model, `latkit.accept`
  for one that accepts it.
- An accepted model can be offered onward as it is. Publications connect received go on as the bytes
  that arrived when they fit the onward bounds, and the onward connections close with the model.
- A peer that closes a socket before registering rejects with its close reason.

Changed

- `connectModel(model, { url } | { socket })` and `acceptModel({ url } | { socket })`: either side
  dials a URL or answers on a socket a server accepted. The URL is dialed exactly; nothing is
  appended to it.
- An accepted model is a `ConnectedModel`, a `Model` and a `Connection`. Commands run as
  `model.commands[name].run(values, { outputs, publish, progress, log, signal })`, with the context a
  model's own handler receives.
- `monitor` is absent when a model offers no reading, and an empty selection reads nothing.
- A log entry that carries a `dropped` count is counted, not forwarded as an entry.
- `Limits` is `ConnectLimits`.

Removed

- `model.run(name, values, { onData, onProgress, onLog })`, `format: 'encoded'`, `MonitorOptions`,
  `RunOptions`, `EncodedMonitorOptions`, and `EncodedRunOptions`. `EncodedPublication` is in
  `protocol`.
- `Command`, `CommandContext`, `MonitorContext`, `Publication`, and `Publish` from connect; the first
  four are in model.
- `protocol.subprotocol`, and the `/models/<name>` connect appended to a URL.
