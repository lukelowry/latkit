---
'@latkit/network': minor
'@latkit/embed': minor
---

Add raw `vertexVisible` and `edgeVisible` channels with matching renderer, picking, Embed attributes, and lifecycle behavior; `Network` and `NetworkElement` consistently ignore range arguments for raw dash and visibility channels. Add `rotateBy()` plus live `vertexScale`, `edgeScale`, `heightScale`, `vertexLodPx`, and `dashPeriodPx` geometry controls with matching Embed attributes. Channel values are now snapshotted, topology fit bounds and visual scales consistently use vertices, crossing edge segments clip to positive W, teardown releases retained scene data, and asynchronous pipeline failures are exposed through `pipelineError` and forwarded by `NetworkElement` as a DOM event.
