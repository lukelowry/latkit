---
'@latkit/connect': patch
---

Fix disconnections during backlog draining by coalescing cumulative ACKs per stream through a single outbound writer. Preserve terminal ACKs and stream reservations until they are sent. Socket and credit pressure now wait without an elapsed-time deadline; cancellation remains prompt and local shutdown stays bounded. Public APIs and the wire format are unchanged.
