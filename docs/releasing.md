# Releasing

One version is shared by npm `latkit`, Cargo `latkit`, and Cargo `latkit-cli` (binary `latkit`).
Changesets describes changes and opens the version PR; `cargo xtask version` updates Cargo's
workspace and dependency versions structurally.

1. Merge the version PR and let CI pass on that commit.
2. The release workflow builds `cargo xtask package` and runs `cargo xtask package-test` against
   the exact npm tarball, including strict TypeScript consumers and browser rendering.
3. `cargo xtask release` verifies the clean commit, tarball hash, and test receipt, and packages
   both Cargo crates. It publishes or verifies npm, the core crate, and the CLI in order.
4. Tags are created only after all registry artifacts match the build. A retry skips identical
   artifacts and completes any missing publication. Different content at an existing version
   stops the release; registry errors are never treated as absence.

For recovery, rerun the failed workflow, or dispatch **Release** on `main`; manual recovery
requires a successful CI run for the exact commit. Do not bump versions just to recover a partial
release. Rebuild and retest after changing or committing source files.

The workflow needs an npm trusted publisher for repository `lukelowry/latkit`, workflow
`release.yml`, and a `CARGO_REGISTRY_TOKEN` allowed to publish both crates. These are registry/account
settings, not files in this repository. First-publication ownership and authentication must be
configured before invoking release. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

`cargo install latkit-cli` is the normal user command. `--locked` optionally reproduces the
dependency versions tested for that release; CI and release builds use it for reproducibility.

LATK's format version is separate from package versions. V1 fixtures must remain stable across
compatible releases. A new layout requires a new format version and a migration policy.
