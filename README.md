# Latkit

Latkit is an early package skeleton for a small TypeScript package family.

## Packages

- `@latkit/colormaps`
- `@latkit/model`
- `@latkit/monitor`
- `@latkit/network`

This repository is intentionally minimal while the public package surface settles.

## About the author

Luke Lowery developed Latkit during his PhD studies at Texas A&M University. You can learn more on his [research page](https://lukelowry.github.io/) or view his publications on [Google Scholar](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en).

Selected related work includes [sgwt](https://pypi.org/project/sgwt/), [esapp](https://pypi.org/project/esapp/), and [ORNL/GridKit](https://github.com/ORNL/GridKit).

## Documentation

The docs live in `docs/` and are written in MyST Markdown for Sphinx and Read the Docs. API reference pages are generated from the public TypeScript package entrypoints:

```sh
pnpm docs:api
pnpm docs:build
```
