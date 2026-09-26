---
'@latkit/gpu': patch
'@latkit/monitor': patch
'@latkit/port': patch
---

- Resolve superseded attachments as false even when their device acquisition fails.
- Keep monitor history reads within the read budget on narrow canvases.
- Accept interfaces in object guards while retaining exhaustive field guard checks.
