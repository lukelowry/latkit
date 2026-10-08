# Release checks

Use Node.js 24 and pnpm 10.30.

```sh
pnpm install --frozen-lockfile
pnpm quality
pnpm build:examples
pnpm test:coverage
pnpm --filter @latkit/gpu test:browser
pnpm --filter @latkit/monitor test:browser
pnpm --filter @latkit/network test:browser
pnpm --filter @latkit/diagram test:browser
python -m pip install -r docs/requirements.txt
pnpm docs:build
pnpm -r --filter "./packages/**" exec npm pack --dry-run
pnpm changeset status
```

Browser checks run headless Chromium with WebGPU and write reports to `output/`. Set
`LATKIT_BROWSER` to a Chromium executable if they find none. Run the video example's `/check.html`
for real codec checks. Run `pnpm bench:gate` to check recorded work; see
[benchmarks](https://github.com/lukelowry/latkit/blob/main/benchmark/README.md).

## Publish

1. Add a changeset with `pnpm changeset`.
2. Merge only after CI passes. The release workflow then opens a `chore: version packages` PR.
3. Review the version PR, including breaking changes and dependent package versions, then merge it.
   The release workflow builds and publishes with npm Trusted Publishing.

Configure each new package's trusted publisher before its first automated release.
