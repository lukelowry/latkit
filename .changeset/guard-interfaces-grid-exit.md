---
'@latkit/model': patch
'@latkit/port': patch
---

Fix two released helpers.

- Fixed: `object` in `@latkit/port/guard` accepts an interface, still requiring a guard for every field.
- Fixed: a `createGrid` query no longer keeps a Node process from exiting.
