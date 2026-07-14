import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { arch, platform, release } from 'node:os';
import { PNG } from 'pngjs';

interface BrowserReport {
  readonly userAgent: string;
  readonly platform: string;
  readonly adapter: {
    readonly api: boolean;
    readonly coreAdapter: boolean;
    readonly info?: Readonly<Record<string, string>>;
    readonly fallback?: boolean;
    readonly features?: readonly string[];
    readonly limits?: Readonly<Record<string, number>>;
  };
}

interface FixtureState {
  readonly generation: number;
  readonly liveMonitors: number;
  readonly ownerLosses: number;
  readonly borrowerLosses: Readonly<{
    network: number;
    monitor0: number;
    monitor1: number;
  }>;
  readonly uncapturedErrors: number;
  readonly lastUncapturedError: string | null;
  readonly lastOwnerLoss: Readonly<{ reason: string; message: string }> | null;
}

declare global {
  interface Window {
    latkitFixture: {
      readonly ready: Promise<void>;
      destroyFirstMonitor(): Promise<void>;
      remountAfterLoss(): Promise<void>;
      report(): BrowserReport | null;
      state(): FixtureState;
    };
  }
}

interface PixelMetrics {
  readonly colorBuckets: number;
  readonly nonDominantPixels: number;
  readonly totalPixels: number;
}

interface ChromiumSystemInfo {
  readonly gpu?: {
    readonly devices?: readonly Readonly<Record<string, unknown>>[];
    readonly auxAttributes?: Readonly<Record<string, unknown>>;
    readonly featureStatus?: Readonly<Record<string, string>>;
  };
}

function chromiumGpuReport(system: ChromiumSystemInfo): Readonly<Record<string, unknown>> {
  const gpu = system.gpu;
  if (!gpu) return {};
  const aux = gpu.auxAttributes ?? {};
  return {
    devices: gpu.devices ?? [],
    gpuProcess: {
      displayType: aux.displayType,
      glRenderer: aux.glRenderer,
      supportsVulkan: aux.supportsVulkan,
      vulkanVersion: aux.vulkanVersion,
      sandboxed: aux.sandboxed,
    },
    featureStatus: gpu.featureStatus ?? {},
  };
}

async function openFixture(page: Page, testInfo: TestInfo): Promise<BrowserReport> {
  await page.goto('/');
  let failure: Error | undefined;
  try {
    await page.evaluate(() => window.latkitFixture.ready);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const report = await page.evaluate(() => window.latkitFixture.report());
  if (!report) throw failure ?? new Error('adapter report was not produced');
  testInfo.annotations.push({ type: 'gpu-report', description: JSON.stringify(report) });
  console.log(`[latkit:gpu-report] ${JSON.stringify(report)}`);
  await testInfo.attach('gpu-report.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });

  const configuredVerification: unknown = testInfo.project.metadata.verification;
  const verification =
    configuredVerification === 'engine' || configuredVerification === 'hardware'
      ? configuredVerification
      : null;
  const run = {
    project: testInfo.project.name,
    verification,
    channel: testInfo.project.use.channel ?? null,
    headless: testInfo.project.use.headless ?? true,
    launchArgs: testInfo.project.use.launchOptions?.args ?? [],
    ci: Boolean(process.env.CI),
    githubSha: process.env.GITHUB_SHA ?? null,
  };
  console.log(`[latkit:run] ${JSON.stringify(run)}`);
  await testInfo.attach('run.json', {
    body: Buffer.from(JSON.stringify(run, null, 2)),
    contentType: 'application/json',
  });

  const browser = page.context().browser();
  if (browser) {
    const session = await browser.newBrowserCDPSession();
    const system = (await session.send('SystemInfo.getInfo')) as unknown as ChromiumSystemInfo;
    const chromiumGpu = {
      browserVersion: browser.version(),
      host: { platform: platform(), release: release(), arch: arch() },
      ...chromiumGpuReport(system),
    };
    console.log(`[latkit:chromium-gpu] ${JSON.stringify(chromiumGpu)}`);
    await testInfo.attach('chromium-gpu.json', {
      body: Buffer.from(JSON.stringify(chromiumGpu, null, 2)),
      contentType: 'application/json',
    });
    await session.detach();
  }

  if (failure) throw failure;
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready');

  expect(report.adapter.api, 'navigator.gpu must be available').toBe(true);
  expect(report.adapter.coreAdapter, 'a Core WebGPU adapter must be available').toBe(true);
  if (verification === 'hardware') {
    expect(report.adapter.fallback, 'hardware verification cannot use a fallback adapter').toBe(
      false,
    );
    expect(run.launchArgs, 'hardware verification cannot use WebGPU override flags').toEqual([]);
  }
  const vertexStorageBuffers = report.adapter.limits?.maxStorageBuffersInVertexStage;
  if (vertexStorageBuffers !== undefined) expect(vertexStorageBuffers).toBeGreaterThanOrEqual(3);
  return report;
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

async function expectPainted(
  canvas: Locator,
  testInfo: TestInfo,
  name: string,
  minimumPixels = 100,
): Promise<void> {
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => pixelMetrics(await canvas.screenshot()).nonDominantPixels, {
      message: `${name} should contain meaningful non-background pixels`,
      timeout: 20_000,
    })
    .toBeGreaterThan(minimumPixels);

  const screenshot = await canvas.screenshot();
  const metrics = pixelMetrics(screenshot);
  expect(metrics.colorBuckets, `${name} should contain several color buckets`).toBeGreaterThan(4);
  await testInfo.attach(`${name}.png`, { body: screenshot, contentType: 'image/png' });
  await testInfo.attach(`${name}-pixels.json`, {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json',
  });
}

async function fixtureState(page: Page): Promise<FixtureState> {
  return page.evaluate(() => window.latkitFixture.state());
}

test('one native device renders Network and multiple Monitors and survives borrower teardown', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo);

  const network = page.locator('#network');
  const firstMonitor = page.locator('#monitor-0');
  const secondMonitor = page.locator('#monitor-1');
  await expectPainted(network, testInfo, 'network');
  await expectPainted(firstMonitor, testInfo, 'monitor-0', 40);
  await expectPainted(secondMonitor, testInfo, 'monitor-1', 40);

  await network.click({ position: { x: 320, y: 210 } });
  await expect(page.locator('#network')).toHaveAttribute('data-select', 'vertex:0');
  await secondMonitor.click({ position: { x: 320, y: 80 } });
  await expect(page.locator('#monitor-1')).toHaveAttribute('data-pick', 'element:1');

  await page.evaluate(() => window.latkitFixture.destroyFirstMonitor());
  await expect(firstMonitor).toHaveAttribute('data-state', 'destroyed');
  await expectPainted(network, testInfo, 'network-after-monitor-destroy');
  await expectPainted(secondMonitor, testInfo, 'monitor-1-after-sibling-destroy', 40);

  await expect
    .poll(() => fixtureState(page))
    .toMatchObject({
      generation: 1,
      liveMonitors: 1,
      ownerLosses: 0,
      borrowerLosses: { network: 0, monitor0: 0, monitor1: 0 },
      uncapturedErrors: 0,
      lastUncapturedError: null,
    });
});

test('device loss is reported and a fresh device can remount every renderer', async ({
  page,
}, testInfo) => {
  await openFixture(page, testInfo);

  await page.evaluate(() => window.latkitFixture.remountAfterLoss());
  await expect
    .poll(() => fixtureState(page))
    .toMatchObject({
      generation: 2,
      liveMonitors: 2,
      ownerLosses: 1,
      borrowerLosses: { network: 1, monitor0: 1, monitor1: 1 },
      uncapturedErrors: 0,
      lastUncapturedError: null,
      lastOwnerLoss: { reason: 'destroyed' },
    });

  await expectPainted(page.locator('#network'), testInfo, 'network-after-remount');
  await expectPainted(page.locator('#monitor-0'), testInfo, 'monitor-0-after-remount', 40);
  await expectPainted(page.locator('#monitor-1'), testInfo, 'monitor-1-after-remount', 40);
});
