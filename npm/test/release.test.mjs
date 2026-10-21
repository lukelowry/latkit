import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureArtifacts, registry } from '../release.mjs';

test('a partial release resumes only missing artifacts', async () => {
  const published = new Map([
    ['npm', 'a'],
    ['core', 'b'],
  ]);
  const writes = [];
  const artifacts = [
    ['npm', 'a'],
    ['core', 'b'],
    ['cli', 'c'],
  ].map(([name, digest]) => ({
    name,
    digest,
    lookup: async () => published.get(name),
    publish: () => {
      writes.push(name);
      published.set(name, digest);
    },
  }));
  await ensureArtifacts(artifacts);
  await ensureArtifacts(artifacts);
  assert.deepEqual(writes, ['cli']);
  await assert.rejects(ensureArtifacts([{ ...artifacts[0], digest: 'different' }]), /must match/);
});

test('registry failures never masquerade as unpublished versions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await assert.rejects(registry('https://example.test'), /503/);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await registry('https://example.test'), undefined);
});
