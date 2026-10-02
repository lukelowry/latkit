---
'@latkit/model': minor
'@latkit/connect': minor
---

Replace data patch operations with complete construction and sample-only append. `createData`
accepts disjoint `RowBatch` and `SampleBatch` values; `appendData` accepts only new sampled
observations. Static changes require a fresh `Data` value. Overlapping writes, sample corrections,
backfilling, and the `replace` option reject without changing earlier values. Immutable payloads
remain shared, with cached per-field append boundaries and one assembly per changed table.

Remove `DataPatch`, `RowsPatch`, and `SamplesPatch` in favor of `DataBatch`, `RowBatch`, and
`SampleBatch`. Data events now carry `block` instead of `patch`. Connect protocol 4 requires
upgrading both peers together. Transaction assembly remains independent of commands and does
not accumulate history.
