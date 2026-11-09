---
'latkit': patch
---

Large datasets with references take about 40% less WebAssembly memory, which a page never gives back.

- Changed: a reference whose ids arrive as `u32` keeps them as `u32`. Where they name the rows of a table with counted ids, its resolved rows share the ids' pages instead of copying them. An id too large for `u32` widens the reference's ids to `u64`. A grid of a million buses and two million lines takes 30 MiB less once read.
- Changed: a background job's input is written once into room made for all of it, and the lanes job writes each line's ends straight from their pages. Loading that grid peaks 31 MiB lower.
