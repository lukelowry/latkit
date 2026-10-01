import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { harness, modes, prepareWorker, until } from './harness.js';
import { verifyRows, verifySamples, inputAt } from '../../../model/tests/scale/verify.js';
import type { ScanResult } from '../../../model/tests/scale/verify.js';
import type { Metrics } from '../../../model/tests/scale/store.js';
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summarize = (scans: ScanResult[]) => ({
  trials: scans,
  medianMs: median(scans.map((s) => s.elapsedMs)),
  minMs: Math.min(...scans.map((s) => s.elapsedMs)),
  maxMs: Math.max(...scans.map((s) => s.elapsedMs)),
  medianFirstBlockMs: median(scans.map((s) => s.firstBlockMs)),
  millionCellsPerSecond: scans[0].cells / median(scans.map((s) => s.elapsedMs)) / 1000,
  blocks: scans[0].blocks,
  maxBlockBytes: Math.max(...scans.map((s) => s.maxBlockBytes)),
  maxBackingBytes: Math.max(...scans.map((s) => s.maxBackingBytes)),
});
const copied = (metrics: Metrics) => metrics.ownedCopiedBytes + metrics.gatherCopiedBytes;
it('measures independently checked scans, monitors and cancellation at scale', async () => {
  const sizes = (process.env.LATKIT_SCALE_ROWS ?? '100000,1000000,4000000').split(',').map(Number);
  const repeats = Number(process.env.LATKIT_SCALE_REPEATS ?? 3);
  assert.ok(sizes.every((n) => Number.isSafeInteger(n) && n >= 10000 && n <= 16000000));
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 20);
  await prepareWorker();
  const results: unknown[] = [];
  for (const rows of sizes)
    for (const mode of modes) {
      global.gc?.();
      const memoryBefore = process.memoryUsage();
      const setupStart = performance.now(),
        run = await harness(mode, rows),
        model = run.model;
      const setupMs = performance.now() - setupStart;
      let peakRss = memoryBefore.rss,
        peakExternal = memoryBefore.external,
        peakArrayBuffers = memoryBefore.arrayBuffers;
      const sample = () => {
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakExternal = Math.max(peakExternal, memory.external);
        peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
      };
      const sampler = setInterval(sample, 5);
      try {
        const cold = await verifyRows(model, rows);
        sample();
        const borrowed: ScanResult[] = [],
          owned: ScanResult[] = [];
        let borrowedNativeCopies = 0,
          ownedNativeCopies = 0;
        for (let i = 0; i < repeats; i++) {
          const before = await run.metrics();
          borrowed.push(await verifyRows(model, rows));
          const between = await run.metrics();
          borrowedNativeCopies += copied(between) - copied(before);
          owned.push(await verifyRows(model, rows, { buffers: 'owned' }));
          const after = await run.metrics();
          ownedNativeCopies += copied(after) - copied(between);
          sample();
        }
        assert.equal(
          borrowedNativeCopies,
          mode === 'message' || mode === 'worker' ? repeats * rows * 8 : 0,
        );
        assert.equal(ownedNativeCopies, repeats * rows * 8);
        const indices = Uint32Array.from({ length: 4096 }, (_, i) => Math.floor((i * rows) / 4096));
        const sparse = await verifyRows(
          model,
          indices.length,
          {},
          {
            kind: 'rows',
            from: 'Node',
            select: ['value'],
            rows: { kind: 'ids', ids: Array.from(indices, (i) => 'n' + i) },
          },
          (i) => indices[i],
        );
        const fields = [{ from: 'Node', select: ['output'] }] as const;
        const recording = await model.monitor(fields),
          mirror = await model.monitor(fields);
        const runStart = performance.now();
        await model.run({ routine: 'simulate', values: { frames: 3, factor: 2 } });
        const commandMs = performance.now() - runStart;
        const observed = await verifySamples(recording, rows, 3, 0, 2, inputAt);
        const captureMetrics = await run.metrics();
        assert.equal(captureMetrics.frameBytes, 3 * (rows * 8 + 8));
        sample();
        const retainStart = performance.now();
        const source = await recording.retain({
          window: { kind: 'frames', offset: 0, count: 1 },
          maxBytes: 1024 * 1024 * 1024,
        });
        const retainMs = performance.now() - retainStart;
        const retainedMetrics = await run.metrics();
        assert.equal(copied(retainedMetrics), copied(captureMetrics));
        assert.equal(retainedMetrics.blocks, captureMetrics.blocks);
        assert.equal(retainedMetrics.frameBytes, captureMetrics.frameBytes);
        await mirror.close();
        await recording.close();
        const iterator = model
          .query({ kind: 'rows', from: 'Node', select: ['value'] })
          [Symbol.asyncIterator]();
        await iterator.next();
        await run.pause(true);
        const pending = iterator.next();
        const rejected = assert.rejects(pending, { code: 'aborted' });
        await until(run, (stats) => stats.waitingReads === 1);
        const cancelStart = performance.now();
        await iterator.return?.();
        await rejected;
        const cancelMs = performance.now() - cancelStart;
        await run.pause(false);
        const retainedSamples = await verifySamples(source, rows, 1, 0, 2, inputAt);
        await source.close();
        const final = await run.metrics();
        assert.equal(final.activeReads, 0);
        assert.equal(final.openedReads, final.releasedReads);
        assert.equal(final.frameBytes, 0);
        assert.equal(final.acquisitions, 0);
        sample();
        const row = {
          mode,
          rows,
          setupMs,
          cold,
          borrowed: summarize(borrowed),
          owned: summarize(owned),
          nativeCopies: {
            borrowedPerScan: borrowedNativeCopies / repeats,
            ownedPerScan: ownedNativeCopies / repeats,
          },
          sparse,
          commandMs,
          samples: observed,
          sharedCaptureBytes: captureMetrics.frameBytes,
          retainMs,
          retainedSamples,
          cancelMs,
          memory: {
            processRssBaseline: memoryBefore.rss,
            sampledProcessPeakRss: peakRss,
            hostPeakExternal: peakExternal,
            hostPeakArrayBuffers: peakArrayBuffers,
          },
          transport: { ...run.socket },
          finalMetrics: final,
        };
        results.push(row);
        console.log(
          JSON.stringify({
            mode,
            rows,
            borrowedMs: +row.borrowed.medianMs.toFixed(2),
            ownedMs: +row.owned.medianMs.toFixed(2),
            firstBlockMs: +row.borrowed.medianFirstBlockMs.toFixed(2),
            commandMs: +commandMs.toFixed(2),
            cancelMs: +cancelMs.toFixed(2),
            retainMs: +retainMs.toFixed(2),
          }),
        );
      } finally {
        clearInterval(sampler);
        await run.close();
      }
    }
  const directory = fileURLToPath(new URL('../../../../output', import.meta.url));
  await mkdir(directory, { recursive: true });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const hash = createHash('sha256');
  for (const directory of [
    'packages/model/src',
    'packages/model/tests/scale',
    'packages/connect/src',
    'packages/connect/tests/scale',
  ]) {
    const paths = (await readdir(root + directory, { recursive: true }))
      .filter((path) => path.endsWith('.ts'))
      .sort();
    for (const path of paths) {
      hash.update(directory + '/' + path);
      hash.update(await readFile(root + directory + '/' + path));
    }
  }
  const report = {
    sourceSha256: hash.digest('hex'),
    generatedAt: new Date().toISOString(),
    node: process.version,
    system: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
    },
    configuration: {
      sizes,
      repeats,
      pageRows: 8192,
      maxBlockBytes: 262144,
      explicitGc: typeof global.gc === 'function',
      modes,
    },
    methodology:
      'Cold scan, then repeated warm borrowed and owned scans. Every cell and canonical block is checked. Native copy counters exclude framing/structured clone/OS copies. RSS is process-wide, including workers; host external/arrayBuffers exclude worker heaps. Peaks sampled at 5 ms and phase boundaries are lower bounds. Two monitors share three native frames. No timing thresholds.',
    results,
  };
  await writeFile(
    directory + '/model-connect-performance.json',
    JSON.stringify(report, null, 2) + '\n',
  );
});
