/** One retryable release: verify or publish each artifact, then create the Changesets tags. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const hash = (file, algorithm, encoding = 'hex') =>
  createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

/** Only an explicit 404 means absent. Authentication, rate limits, and network failures stop release. */
export async function registry(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'latkit-release (github.com/lukelowry/latkit)' },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Successful registry responses must contain a digest, never count as absent. */
async function digest(url, select) {
  const metadata = await registry(url);
  if (metadata === undefined) return undefined;
  const value = select(metadata);
  assert.ok(typeof value === 'string' && value.length > 0, `${url}: missing artifact digest`);
  return value;
}

/** Existing versions must contain the expected artifact; retries resume after the last completed publish. */
export async function ensureArtifacts(artifacts) {
  for (const artifact of artifacts) {
    let seen = await artifact.lookup();
    if (seen === undefined) {
      await artifact.publish();
      for (let attempt = 0; attempt < 60; attempt++) {
        seen = await artifact.lookup();
        if (seen !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    assert.equal(
      seen,
      artifact.digest,
      `${artifact.name}: published content must match the verified build`,
    );
    console.log(`${artifact.name}: verified`);
  }
}

async function release() {
  const report = read('target/npm/package.json');
  const { name, version } = read('npm/package.json');
  const git = (args) => run('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
  // Tags follow a complete release, so later commits at the same version have nothing to publish.
  if (git(['tag', '--list', `${name}@${version}`]) !== '') {
    console.log(`${name}@${version}: released`);
    return;
  }
  assert.equal(git(['status', '--porcelain']), '', 'release requires a clean, committed tree');
  assert.equal(
    report.commit,
    git(['rev-parse', 'HEAD']),
    'rebuild and test packages from the release commit',
  );
  assert.equal(report.dirty, false, 'rebuild packages after committing changes');
  assert.equal(report.version, version);
  assert.equal(hash(report.tarball, 'sha256'), report.sha256);
  const validation = read('target/npm/verified.json');
  assert.equal(
    validation.sha256,
    report.sha256,
    'test this exact tarball with cargo xtask package-test',
  );
  // Cargo verifies both crates together, resolving the unpublished core for the CLI locally.
  run('cargo', ['package', '--locked', '-p', 'latkit', '-p', 'latkit-cli']);
  const npm = {
    name: `${name}@${version}`,
    digest: `sha512-${hash(report.tarball, 'sha512', 'base64')}`,
    lookup: () =>
      digest(
        `https://registry.npmjs.org/${name}/${version}`,
        (metadata) => metadata.dist?.integrity,
      ),
    publish: () =>
      run(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['publish', report.tarball, '--provenance', '--access', 'public'],
        { shell: process.platform === 'win32' },
      ),
  };
  const crates = ['latkit', 'latkit-cli'].map((name) => ({
    name: `${name}@${version}`,
    digest: hash(path.join(root, `target/package/${name}-${version}.crate`), 'sha256'),
    lookup: () =>
      digest(
        `https://crates.io/api/v1/crates/${name}/${version}`,
        (metadata) => metadata.version?.checksum,
      ),
    publish: () => run('cargo', ['publish', '--locked', '-p', name]),
  }));
  await ensureArtifacts([npm, ...crates]);
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('@changesets/cli/package.json')), 'bin.js');
  run(process.execPath, [cli, 'tag']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await release();
