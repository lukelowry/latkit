---
'@latkit/remote': minor
---

Add `Remote<T>`, the shape every connected side shares: what the peer serves plus `close`. `connectResults` returns `Remote<Results>` and `RemoteSource` is a `Remote<Served>` with `reopen`; the `RemoteGrid`, `RemoteResults`, `ServeOptions`, and `ResultsOptions` names are gone, their shapes stated inline on `connectGrid`, `serveSource`, and `serveResults`.
