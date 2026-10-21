---
'latkit': minor
---

Establish the LATK v1 format and tighten the npm, Rust, and CLI release contracts.

- LATK now has a versioned header, 64-bit absolute sample indexes, explicit stored detail levels, and bounded decoding. Regenerate earlier unversioned files and time tiles from their source data.
- Added `latkit/core` for DOM-free builders and CPU-only Rust expressions, queries, and data loading.
- Fixed video cancellation and output cleanup, arbitrary query field names, URL resolution, and shared GPU device callback ownership.
- Public declarations and API/CLI references now come from checked sources. Packages include consistent MIT licensing and third-party notices.
- Releases verify the installed npm tarball and both Cargo artifacts, and resume missing publications safely before tagging.
