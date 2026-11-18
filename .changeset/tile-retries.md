---
'latkit': patch
---

A tile file that fails to fetch is fetched again on its own, and an aborted fetch is no failure.

- Changed: a file of tiles that fails to fetch (a span, a tile, a base dataset, an index, or an archive directory) is fetched again a second later, then twice as long after each further failure, at most a minute. Before, it stayed failed until `refresh()`.
- Changed: a `fetch` option that rejects with an `AbortError` cancels the file rather than failing it. Nothing is reported, and the file is fetched again when next needed.
- Changed: once a failed file arrives, its views stop reporting the failure.
- Fixed: a time tiles base that failed to fetch was never fetched again, even by `refresh()`.
