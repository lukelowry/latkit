# Release process

Latkit uses Changesets for versioning and GitHub Actions for publishing. This page is for maintainers preparing a release candidate.

1. Make the code or documentation change.
2. Add a changeset with `pnpm changeset`.
3. Merge the change to `main`.
4. The release workflow opens or updates a version PR.
5. Merge the version PR to publish changed packages to npm.

The release workflow uses npm Trusted Publishing. Package publishing is tied to `.github/workflows/release.yml` through GitHub OIDC rather than a long-lived npm token.

## Local checks

Before merging a release candidate, run:

```sh
pnpm format:check
pnpm lint
pnpm build
pnpm build:examples
pnpm typecheck
pnpm test:run
pnpm docs:build
pnpm -r --filter "./packages/**" exec npm pack --dry-run
```

`pnpm build:examples` checks the example applications against the package entrypoints produced by
`pnpm build`. `pnpm docs:build` regenerates TypeDoc Markdown before running Sphinx, so a
separate `pnpm docs:api` command is only needed when you want to inspect generated reference
files without building HTML.
