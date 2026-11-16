---
'latkit': minor
---

A field can be read from the row a reference names, and a write costs what it changes through joins, transitions, and typed arrays.

- Added: `field(name).of(reference)`, `{ "field": name, "of": reference }` in JSON, and `Expr::of` in Rust. It reads the field from the row that a reference field of the mark's own table names, such as `field('kv').of('from')` for an edge's first bus. Writing that row changes every row that names it. A row whose reference names no row reads a missing value.
- Changed: a write to a table that a mark reads through `from` or `of` evaluates only the pages of the mark's rows that read the rows written. Before, it evaluated every row of the mark.
- Changed: a join of two tables that list the same ids in the same order costs nothing: its fields read like the mark's own. Any other join is built again only when either table's rows come or go, not when values change.
- Changed: a transition freezes and eases only the pages a write changed. Before, each write eased every row of the mark.
- Changed: `Data.set` and `Data.replace` with typed arrays of numbers, for rows given as a `Uint32Array`, as `{ count }`, or not at all, write the columns directly, without an encoded patch. A whole column written with the ids it already has replaces its pages without a lookup per row.
- Changed: one pass evaluates a batch of rows, whatever the row's width. Before, a batch took one pass per four words of a row, and one more to pack them.
- Fixed: an expression that compares a text with `is` and also uses opaque white drew the wrong color, since the two shared a constant.
