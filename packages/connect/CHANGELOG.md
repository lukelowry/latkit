# @latkit/connect

## 1.0.0

### Major Changes

- 5f19f4e: Replace connect with demand-driven connectLattice and acceptModel endpoints. Registration carries metadata only; bounded binary publications, cumulative credit windows, cancellation, typed command arguments, bounded diagnostics, and encoded forwarding replace snapshots and transaction event plumbing.

  Make model the shared data and command vocabulary: add CommandDescription, Parameters, Arguments, Progress, Diagnostic, validateBatch, validateSelection, and selectBatches. Remove Model, Commands, Routine, DataEvent, transactions, and schema delivery limits. Read limits belong to QueryOptions; connection limits belong to connect. Update GPU/monitor consumers accordingly. This intentionally breaks the previous connection and model contracts.

### Patch Changes

- Updated dependencies [5f19f4e]
- Updated dependencies [5f19f4e]
  - @latkit/model@1.0.0
