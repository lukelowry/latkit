# Latkit

Latkit is an early package skeleton for a small TypeScript package family.

## Packages

- `@latkit/colormaps`
- `@latkit/model`
- `@latkit/monitor`
- `@latkit/network`

This repository is intentionally minimal while the public package surface settles.

## Documentation

The docs live in `docs/` and are written in MyST Markdown for Sphinx and Read the Docs. API reference pages are generated from the public TypeScript package entrypoints:

```sh
pnpm docs:api
pnpm docs:build
```
