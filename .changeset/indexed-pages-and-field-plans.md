---
'@latkit/model': minor
'@latkit/gpu': patch
'@latkit/monitor': patch
'@latkit/network': patch
---

Store field pages and sample indexes in persistent balanced collections. Appending shares earlier
storage instead of copying and reindexing the full history. TableData.fields now contains readonly
ColumnPages: use at() or iteration rather than array indexing and construct columns through
createData/appendData. copyBuffers preserves the indexed representation. Add appendedPages,
samplePages, and resolveRows for consistent indexed suffix, window, and row-coverage access.

Compile field bindings in the shared GPU layer independently of Data snapshots. Resolve row
identity without gathering bound values, and cache each point field independently so static
columns and slower sampled fields remain reusable through playback, including reordered IDs.
Index cached reads by their actual dependencies, and reuse network binding records across frames.
Monitor append detection now visits only added pages while preserving cancellation and replacement
semantics. Application view usage is unchanged.
