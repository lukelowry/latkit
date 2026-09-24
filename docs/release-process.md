# Release process

Latkit uses Changesets for versioning and GitHub Actions for publishing. This page is for maintainers preparing a release candidate.

1. Make the code or documentation change.
2. Add a changeset with `pnpm changeset`.
3. Merge the change to `main`.
4. The release workflow opens or updates a version PR.
5. Merge the version PR to publish changed packages to npm.

The release workflow uses npm Trusted Publishing. Package publishing is tied to `.github/workflows/release.yml` through GitHub OIDC rather than a long-lived npm token.

## Refresh a release branch

Before merging, update the branch from `main` and run `pnpm changeset status`.
Keep the versions and changelogs already released on `main`, and do not restore
changesets that its version PR has consumed. Only unreleased changes should remain
in `.changeset`. Changesets also bumps dependent packages when their internal
dependency versions change. Leave versioning to the generated version PR.

## First publication of a new package

Complete npm setup before merging the version PR. An existing package's trusted
publisher does not authorize a new package in the same scope.

1. Sign in with `npm login` using an account permitted to create packages under
   `@latkit`, and complete npm's authentication prompts.
2. Create the new package with an authenticated initial publication. If the real
   release depends on other unpublished workspace versions, publish a separate
   bootstrap package first: a minimal manifest with the intended package name,
   version `0.0.0-bootstrap.0`, repository and license metadata, a README clearly
   marking it as a placeholder, and the license file. Give it no runtime code or
   dependencies. Publish its directory with
   `npm publish --access public --tag bootstrap`, keeping it off the `latest` tag.
   Do not publish the unversioned workspace package directly with npm: its
   `workspace:*` dependencies need pnpm's publishing transformation.
3. In the new package's npm settings, add a GitHub Actions trusted publisher:
   user `lukelowry`, repository `latkit`, workflow filename `release.yml`, and no
   environment name. Enable direct `npm publish` permission, as the release
   workflow does not use staged publishing. No GitHub npm token secret is needed.
4. Merge the feature PR after both CI jobs pass. Review the generated version PR
   for package versions and dependency updates, then merge it to publish the
   first real release. Confirm the Release workflow succeeds and npm's `latest`
   tag points to the real release.

See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [trust setup prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Local checks

Before merging a release candidate, run:

```sh
pnpm format:check
pnpm build
pnpm lint
pnpm build:examples
pnpm typecheck
pnpm test:run
pnpm docs:build
pnpm -r --filter "./packages/**" exec npm pack --dry-run
```

`pnpm build` precedes type-aware linting because workspace packages resolve one another
through their generated public declarations. The combined `pnpm quality` command preserves
this order.

`pnpm build:examples` checks the example applications against the package entrypoints produced by
`pnpm build`. `pnpm docs:build` regenerates TypeDoc Markdown before running Sphinx, so a
separate `pnpm docs:api` command is only needed when you want to inspect generated reference
files without building HTML.
