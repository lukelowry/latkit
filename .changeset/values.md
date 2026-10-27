---
'latkit': minor
---

One way to write a value: `'$name'` reads a field, any other string is a CSS color, and `null` is missing, in every option and query.

- Changed: in a scene or a query, a string `'$name'` reads field `name` and any other string is a CSS color, whatever the option; `field(name)` writes `'$name'`. A color option that computes a number or a boolean is an error that says how to map it to colors.
- Changed: an operation is an object with one key naming it: `{ add: [a, b] }`, `{ not: [a] }`, `{ is: ['$name', 'Austin'] }`. `null` is a missing value. One `when` chooses between values and colors alike.
- Changed: `.colormap()` returns `Mapped`, as `.scale()` does.
- Renamed: the layered layout's `flow` to `direction`, so `flow` means only comets.
- Removed: `{ op, args }`, `{ color }`, and `{ missing: true }`; `Paint`, `PaintInput`, `Colormapped`, `Missing`, `color()`, and `missing()`; bare strings as field names. In Rust, `Paint` and `Expr` from a string or a `Name`.
