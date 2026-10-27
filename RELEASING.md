# Releasing

npm `latkit`, Cargo `latkit`, and Cargo `latkit-cli` (binary `latkit`) share one version.
Changesets records changes and opens the version PR. `cargo xtask version` copies the npm version
into the Cargo workspace (its package version and its `latkit` dependency) and updates `Cargo.lock`.

1. Merge the version PR and let CI pass on that commit.
2. The release workflow builds the npm tarball with `cargo xtask package` and tests that exact
   tarball with `cargo xtask package-test`, including strict TypeScript consumers and browser
   rendering.
3. `cargo xtask release` verifies the clean commit, the tarball hash, and the test receipt, and
   packages both Cargo crates. It then publishes npm, the core crate, and the CLI, in that order. A
   package already published is verified instead.
4. Tags are created only after every registry artifact matches the build. A retry skips identical
   artifacts and completes any missing publication. Different content at an existing version stops
   the release, and a registry error never counts as a missing artifact. Once a version is tagged,
   later commits at that version publish nothing.

To recover, rerun the failed workflow or dispatch **Release** on `main`. A manual dispatch needs a
successful CI run for the exact commit. Do not bump versions just to recover a partial release.
Rebuild and retest after changing or committing source files.

The workflow needs an npm trusted publisher for repository `lukelowry/latkit` and workflow
`release.yml`, and a `CARGO_REGISTRY_TOKEN` allowed to publish both crates. These are registry and
account settings, not files in this repository. Set up package ownership and authentication before
the first release. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

Users install the CLI with `cargo install latkit-cli`. Adding `--locked` reproduces the dependency
versions a release was tested with. CI and release builds always use it.

latkit's binary format carries no version. A release that changes its layout says in its changeset
that files written before it no longer open, and updates `crates/latkit/tests/fixtures/patch.hex`.
