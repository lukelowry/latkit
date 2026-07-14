import assert from 'node:assert/strict';

import { PNG } from 'pngjs';

import type { BrowserReport, FixtureState } from './fixture/src/protocol.js';

export interface ConformanceSession {
  readonly apiRequired: boolean;
  readonly hardwareEvidence: boolean;
  open(path: string): Promise<void>;
  waitForCapabilities(): Promise<void>;
  waitForRenderers(): Promise<void>;
  report(): Promise<BrowserReport>;
  state(): Promise<FixtureState>;
  setProjection(mode: 'flat' | 'tilt' | 'globe'): Promise<boolean>;
  destroyFirstMonitor(): Promise<void>;
  remountAfterLoss(): Promise<void>;
  click(selector: string, position: Readonly<{ x: number; y: number }>): Promise<void>;
  attribute(selector: string, name: string): Promise<string | null>;
  screenshot(selector: string): Promise<Buffer>;
  attach(name: string, body: Buffer, contentType: string): Promise<void>;
}

export interface ConformanceScenario {
  readonly name: string;
  readonly requiresRenderers: boolean;
  run(session: ConformanceSession): Promise<void>;
}

interface PixelMetrics {
  readonly colorBuckets: number;
  readonly nonDominantPixels: number;
  readonly totalPixels: number;
}

export interface CompatibilityAssessment {
  readonly mode: 'confirmed' | 'core-fallback' | 'unavailable' | 'failed';
  readonly compatibilityBackendPrerequisitesPassed: boolean;
  readonly renderProbe: 'not-run' | 'passed' | 'failed';
  readonly currentRenderer: {
    readonly network: boolean;
    readonly monitor: boolean;
  };
  readonly blockers: readonly string[];
}

const CURRENT_VERTEX_STORAGE_REQUIREMENTS = {
  network: 3,
  monitor: 2,
} as const;

export const conformanceScenarios: readonly ConformanceScenario[] = [
  {
    name: 'reports Core and Compatibility Mode readiness',
    requiresRenderers: false,
    run: verifyCapabilities,
  },
  {
    name: 'renders every projection with 1x MSAA',
    requiresRenderers: true,
    run: (session) => verifyProjectionRendering(session, 1),
  },
  {
    name: 'renders every projection with 4x MSAA',
    requiresRenderers: true,
    run: (session) => verifyProjectionRendering(session, 4),
  },
  {
    name: 'shares one device and survives borrower teardown',
    requiresRenderers: true,
    run: verifyBorrowerTeardown,
  },
  {
    name: 'reports device loss and remounts every renderer',
    requiresRenderers: true,
    run: verifyDeviceRecovery,
  },
] as const;

export function assessCompatibility(report: BrowserReport): CompatibilityAssessment {
  const probe = report.webgpu.compatibility;
  const vertexStorageBuffers = probe.limits.maxStorageBuffersInVertexStage ?? 0;
  const blockers: string[] = [];

  let mode: CompatibilityAssessment['mode'];
  if (!probe.adapterAvailable) {
    mode = 'unavailable';
    blockers.push('No adapter was returned for a Compatibility Mode request.');
  } else if (!probe.deviceAvailable || probe.renderProbe === 'failed') {
    mode = 'failed';
    blockers.push(probe.error ?? 'The Compatibility Mode device or render probe failed.');
  } else if (probe.effectiveFeatureLevel === 'core') {
    mode = 'core-fallback';
    blockers.push('The browser treated the Compatibility Mode request as Core WebGPU.');
  } else if (probe.renderProbe === 'passed') {
    mode = 'confirmed';
  } else {
    mode = 'failed';
    blockers.push('The Compatibility Mode render probe did not run.');
  }

  const currentRenderer = {
    network: vertexStorageBuffers >= CURRENT_VERTEX_STORAGE_REQUIREMENTS.network,
    monitor: vertexStorageBuffers >= CURRENT_VERTEX_STORAGE_REQUIREMENTS.monitor,
  };
  if (!currentRenderer.network) {
    blockers.push(
      `Network requires ${CURRENT_VERTEX_STORAGE_REQUIREMENTS.network} vertex-stage storage buffers; the adapter reports ${vertexStorageBuffers}.`,
    );
  }
  if (!currentRenderer.monitor) {
    blockers.push(
      `Monitor requires ${CURRENT_VERTEX_STORAGE_REQUIREMENTS.monitor} vertex-stage storage buffers; the adapter reports ${vertexStorageBuffers}.`,
    );
  }

  return {
    mode,
    compatibilityBackendPrerequisitesPassed: mode === 'confirmed' && probe.renderProbe === 'passed',
    renderProbe: probe.renderProbe,
    currentRenderer,
    blockers,
  };
}

async function verifyCapabilities(session: ConformanceSession): Promise<void> {
  await session.open('/?msaa=1');
  await session.waitForCapabilities();
  const report = await session.report();
  const assessment = assessCompatibility(report);
  await attachJson(session, 'gpu-report.json', report);
  await attachJson(session, 'compatibility-assessment.json', assessment);
  console.log(`[latkit:gpu-report] ${JSON.stringify(report)}`);
  console.log(`[latkit:compatibility] ${JSON.stringify(assessment)}`);

  if (session.apiRequired) {
    assert.equal(report.webgpu.apiAvailable, true, 'navigator.gpu must be available');
  }
  const compatibility = report.webgpu.compatibility;
  if (compatibility.deviceAvailable) {
    assert.equal(compatibility.adapterAvailable, true);
    assert.equal(
      compatibility.renderProbe,
      'passed',
      compatibility.error ?? 'Compatibility render probe failed',
    );
  }
}

async function verifyProjectionRendering(session: ConformanceSession, msaa: 1 | 4): Promise<void> {
  await openRenderers(session, `/?msaa=${msaa}`);
  assert.equal(await session.attribute('#network', 'data-msaa'), String(msaa));

  await expectPainted(session, '#monitor-0', `monitor-0-${msaa}x`, 40);
  await expectPainted(session, '#monitor-1', `monitor-1-${msaa}x`, 40);
  for (const projection of ['flat', 'tilt', 'globe'] as const) {
    assert.equal(
      await session.setProjection(projection),
      true,
      `${projection} projection must be available`,
    );
    assert.equal(await session.attribute('#network', 'data-projection'), projection);
    await expectPainted(session, '#network', `network-${projection}-${msaa}x`);
  }
  await expectCleanState(session);
}

async function verifyBorrowerTeardown(session: ConformanceSession): Promise<void> {
  await openRenderers(session, '/?msaa=1');

  await expectPainted(session, '#network', 'network');
  await expectPainted(session, '#monitor-0', 'monitor-0', 40);
  await expectPainted(session, '#monitor-1', 'monitor-1', 40);

  await session.click('#network', { x: 320, y: 210 });
  assert.equal(await session.attribute('#network', 'data-select'), 'vertex:0');
  await session.click('#monitor-1', { x: 320, y: 80 });
  assert.equal(await session.attribute('#monitor-1', 'data-pick'), 'element:1');

  await session.destroyFirstMonitor();
  assert.equal(await session.attribute('#monitor-0', 'data-state'), 'destroyed');
  await expectPainted(session, '#network', 'network-after-monitor-destroy');
  await expectPainted(session, '#monitor-1', 'monitor-1-after-sibling-destroy', 40);

  const state = await session.state();
  assert.equal(state.generation, 1);
  assert.equal(state.liveMonitors, 1);
  assert.equal(state.ownerLosses, 0);
  assert.deepEqual(state.borrowerLosses, { network: 0, monitor0: 0, monitor1: 0 });
  assert.equal(state.uncapturedErrors, 0);
  assert.equal(state.lastUncapturedError, null);
}

async function verifyDeviceRecovery(session: ConformanceSession): Promise<void> {
  await openRenderers(session, '/?msaa=1');
  await session.remountAfterLoss();

  const state = await session.state();
  assert.equal(state.generation, 2);
  assert.equal(state.liveMonitors, 2);
  assert.equal(state.ownerLosses, 1);
  assert.deepEqual(state.borrowerLosses, { network: 1, monitor0: 1, monitor1: 1 });
  assert.equal(state.uncapturedErrors, 0);
  assert.equal(state.lastUncapturedError, null);
  assert.equal(state.lastOwnerLoss?.reason, 'destroyed');

  await expectPainted(session, '#network', 'network-after-remount');
  await expectPainted(session, '#monitor-0', 'monitor-0-after-remount', 40);
  await expectPainted(session, '#monitor-1', 'monitor-1-after-remount', 40);
}

async function openRenderers(session: ConformanceSession, path: string): Promise<void> {
  await session.open(path);
  await session.waitForRenderers();
  const report = await session.report();
  await attachJson(session, 'gpu-report.json', report);
  await attachJson(session, 'compatibility-assessment.json', assessCompatibility(report));

  const core = report.webgpu.core;
  assert.equal(core.deviceAvailable, true, core.error ?? 'Core WebGPU device is unavailable');
  assert.equal(core.effectiveFeatureLevel, 'core');
  assert.ok(
    (core.limits.maxStorageBuffersInVertexStage ?? 0) >=
      CURRENT_VERTEX_STORAGE_REQUIREMENTS.network,
  );
  if (session.hardwareEvidence) {
    assert.equal(core.fallback, false, 'hardware evidence cannot use a fallback adapter');
  }
}

async function expectCleanState(session: ConformanceSession): Promise<void> {
  const state = await session.state();
  assert.equal(state.uncapturedErrors, 0);
  assert.equal(state.lastUncapturedError, null);
}

async function expectPainted(
  session: ConformanceSession,
  selector: string,
  name: string,
  minimumPixels = 100,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let screenshot = await session.screenshot(selector);
  let metrics = pixelMetrics(screenshot);
  while (
    (metrics.nonDominantPixels <= minimumPixels || metrics.colorBuckets <= 4) &&
    Date.now() < deadline
  ) {
    await delay(100);
    screenshot = await session.screenshot(selector);
    metrics = pixelMetrics(screenshot);
  }

  await session.attach(`${name}.png`, screenshot, 'image/png');
  await attachJson(session, `${name}-pixels.json`, metrics);
  assert.ok(
    metrics.nonDominantPixels > minimumPixels,
    `${name} should contain meaningful non-background pixels`,
  );
  assert.ok(metrics.colorBuckets > 4, `${name} should contain several color buckets`);
}

function pixelMetrics(image: Buffer): PixelMetrics {
  const png = PNG.sync.read(image);
  const buckets = new Map<number, number>();
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const key =
      ((png.data[offset]! >> 4) << 8) |
      ((png.data[offset + 1]! >> 4) << 4) |
      (png.data[offset + 2]! >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const totalPixels = png.width * png.height;
  const dominantPixels = Math.max(...buckets.values());
  return {
    colorBuckets: buckets.size,
    nonDominantPixels: totalPixels - dominantPixels,
    totalPixels,
  };
}

async function attachJson(
  session: ConformanceSession,
  name: string,
  value: unknown,
): Promise<void> {
  await session.attach(name, Buffer.from(JSON.stringify(value, null, 2)), 'application/json');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
