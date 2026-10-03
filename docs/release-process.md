# Release checks

Use Node.js 24 and pnpm 10.30. Build declarations before linting.

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

Browser checks require Chromium with WebGPU; set `LATKIT_BROWSER` if needed.
The network command opens an interactive fixture. For headless verification,
bundle its fixtures first, then run `node packages/network/tests/browser/run.mjs`.

Run the video example's `/check.html` for real codec checks.
Run `pnpm bench:gate` to check recorded work; see `benchmark/`.
Reports go to `output/`.

## Publish

Add a changeset with `pnpm changeset`. Merge only after CI passes, then review
and merge the generated version PR. The release workflow builds and publishes
with npm Trusted Publishing. Configure each new package's trusted publisher
before its first automated release.

The diagram package now includes a runtime. Include its browser checks before publication.
Keep API-breaking changes and dependent package versions in the release plan.
