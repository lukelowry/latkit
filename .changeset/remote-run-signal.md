---
'@latkit/remote': patch
---

`connectSource` forwards a run's abort signal to the runner stream, so cancelling a run stops the serving side, and `reopen` transfers an owned copy of the bytes instead of a view over a buffer the caller may still hold.
