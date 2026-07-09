# API reference

The API reference is generated from the published package entrypoints with TypeDoc.

Run this command after changing exported symbols:

```sh
pnpm docs:api
```

```{toctree}
:maxdepth: 2

reference/README
```

```{toctree}
:hidden:
:glob:

reference/@latkit/*/README
reference/@latkit/*/functions/*
reference/@latkit/*/interfaces/*
reference/@latkit/*/type-aliases/*
reference/@latkit/*/variables/*
```
