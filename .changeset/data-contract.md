---
'latkit': minor
---

Patches are bytes written in TypeScript, datasets change in place, and types come from latkit's schema both ways.

- Added: `Patch` without WebAssembly (`Patch.to(dataset)`, `fromBytes`, `stream`, `extend`), `Data.read` for latkit bytes and GeoJSON, `data.snapshot()`, queries' `ids`, `total`, and `contains`, `outputs.ts` (events, hits, stats, work, descriptions), and the documentation on Read the Docs.
- Changed: `data.apply(patch)` changes the dataset in place; selections, row fits, `select` and `delete` events, and `neighbors` are row sets `{ data, table, ids }`; `Hit.mark` is the mark's name; picks, locations, and layouts reject with `timeout` past a deadline; `view.arrange()` answers patches that name their datasets; field kinds name geometries (`point`, `path`, `parts`, `polygons`); pictures and videos no longer make the pipelines only input needs.
- Renamed: `put` to `replace`, a query's `where` to `filter`, vertices' `status` to `ring`, `rings` and (off plots) `trace` to `geometry`, `{ colormap: value, map }` to `{ colormap: map, value }`, `{ scale: value, range }` to `{ scale: [low, high], value }`, grid pitches to `{ lines: { pitch } }` and `{ dots: { pitch, snap } }`, the `'earth'` space to `'mercator'`, `forms.ts` to `inputs.ts`, and the error code `load` to `io`.
- Removed: `geojson()` (`Data.read`), `Data.fromBytes`, patch handles and their `destroy()`, `removeTiles` (`removeData`), and bare numbers as row counts (`{ count }`).
