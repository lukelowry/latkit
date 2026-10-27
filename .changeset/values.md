---
'latkit': minor
---

One way to write a value in every option and query: `'$name'` reads a field, any other string is a CSS color, and `null` is missing.

- Changed: in a scene or a query, a string `'$name'` reads field `name` and any other string is a CSS color, whatever the option. `field(name)` writes `'$name'`.
- Changed: a color option that computes a number or a boolean is an error, and the error says how to map it to colors.
- Changed: an operation is an object with one key, its name: `{ add: [a, b] }`, `{ not: [a] }`, `{ is: ['$name', 'Austin'] }`.
- Changed: `null` is a missing value.
- Changed: one `when` chooses between values and colors alike.
- Changed: `.colormap()` returns `Mapped`, like `.scale()`.
- Changed: the layered layout's `flow` is renamed `direction`, so `flow` means only comets.
- Removed: `{ op, args }`, `{ color }`, and `{ missing: true }`.
- Removed: `Paint`, `PaintInput`, `Colormapped`, `Missing`, `color()`, and `missing()`.
- Removed: bare strings as field names.
- Removed: in Rust, converting a string or a `Name` into `Paint` or `Expr`.
