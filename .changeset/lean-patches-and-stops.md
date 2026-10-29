---
'latkit': patch
---

An empty table with a priority draws, `Patch` bundles without WebAssembly, and nothing runs after an internal error.

- Changed: `Patch.read()` of JSON needs `await load()` first, and rejects with an `unloaded` error before then. A bundle that only builds patches and reads their bytes leaves out the WebAssembly bindings, about 72 KB.
- Changed: once latkit stops after an internal error, pending waits reject with the `stopped` error at once instead of timing out.
- Fixed: an empty table with a `priority` no longer stops latkit.
- Fixed: resizing a canvas after latkit stopped no longer causes a second internal error.
