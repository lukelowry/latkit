import { arch, platform, release } from 'node:os';

import type { Page, TestInfo } from '@playwright/test';

import type { ConformanceSession } from './conformance.js';
import type { BrowserReport, FixtureApi, FixtureState } from './fixture/src/protocol.js';

interface ChromiumSystemInfo {
  readonly gpu?: {
    readonly devices?: readonly Readonly<Record<string, unknown>>[];
    readonly auxAttributes?: Readonly<Record<string, unknown>>;
    readonly featureStatus?: Readonly<Record<string, string>>;
  };
}

export class PlaywrightSession implements ConformanceSession {
  readonly apiRequired: boolean;
  readonly hardwareEvidence: boolean;
  readonly #page: Page;
  readonly #testInfo: TestInfo;

  constructor(page: Page, testInfo: TestInfo) {
    this.#page = page;
    this.#testInfo = testInfo;
    this.apiRequired = testInfo.project.metadata.api !== 'optional';
    this.hardwareEvidence = testInfo.project.metadata.verification === 'hardware';
  }

  async open(path: string): Promise<void> {
    await this.#page.goto(path);
    await this.#attachRunEvidence();
  }

  async waitForCapabilities(): Promise<void> {
    await this.#page.evaluate(async () => {
      const fixture = (window as unknown as { latkitFixture: FixtureApi }).latkitFixture;
      await fixture.capabilitiesReady;
      try {
        await fixture.ready;
      } catch {
        // A missing Core device is evidence for this scenario, not a probe failure.
      }
    });
  }

  async waitForRenderers(): Promise<void> {
    await this.#page.evaluate(
      () => (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.ready,
    );
  }

  async report(): Promise<BrowserReport> {
    return this.#page.evaluate(() =>
      (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.report(),
    );
  }

  async state(): Promise<FixtureState> {
    return this.#page.evaluate(() =>
      (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.state(),
    );
  }

  async setProjection(mode: 'flat' | 'tilt' | 'globe'): Promise<boolean> {
    return this.#page.evaluate(
      (nextMode) =>
        (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.setProjection(nextMode),
      mode,
    );
  }

  async destroyFirstMonitor(): Promise<void> {
    await this.#page.evaluate(() =>
      (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.destroyFirstMonitor(),
    );
  }

  async remountAfterLoss(): Promise<void> {
    await this.#page.evaluate(() =>
      (window as unknown as { latkitFixture: FixtureApi }).latkitFixture.remountAfterLoss(),
    );
  }

  async click(selector: string, position: Readonly<{ x: number; y: number }>): Promise<void> {
    await this.#page.locator(selector).click({ position });
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    return this.#page.locator(selector).getAttribute(name);
  }

  async screenshot(selector: string): Promise<Buffer> {
    return this.#page.locator(selector).screenshot();
  }

  async attach(name: string, body: Buffer, contentType: string): Promise<void> {
    await this.#testInfo.attach(name, { body, contentType });
  }

  async #attachRunEvidence(): Promise<void> {
    const browser = this.#page.context().browser();
    const verification: unknown = this.#testInfo.project.metadata.verification;
    const scope: unknown = this.#testInfo.project.metadata.scope;
    const run = {
      project: this.#testInfo.project.name,
      verification: typeof verification === 'string' ? verification : null,
      scope: typeof scope === 'string' ? scope : null,
      browserName: this.#testInfo.project.use.browserName ?? null,
      channel: this.#testInfo.project.use.channel ?? null,
      browserVersion: browser?.version() ?? null,
      headless: this.#testInfo.project.use.headless ?? true,
      launchArgs: this.#testInfo.project.use.launchOptions?.args ?? [],
      host: { platform: platform(), release: release(), arch: arch() },
      ci: Boolean(process.env.CI),
      githubSha: process.env.GITHUB_SHA ?? null,
    };
    await this.attach('run.json', Buffer.from(JSON.stringify(run, null, 2)), 'application/json');
    console.log(`[latkit:run] ${JSON.stringify(run)}`);

    if (!browser || this.#testInfo.project.use.browserName !== 'chromium') return;
    const session = await browser.newBrowserCDPSession();
    try {
      const system = (await session.send('SystemInfo.getInfo')) as unknown as ChromiumSystemInfo;
      const gpu = system.gpu;
      const chromiumGpu = {
        devices: gpu?.devices ?? [],
        gpuProcess: {
          displayType: gpu?.auxAttributes?.displayType,
          glRenderer: gpu?.auxAttributes?.glRenderer,
          supportsVulkan: gpu?.auxAttributes?.supportsVulkan,
          vulkanVersion: gpu?.auxAttributes?.vulkanVersion,
          sandboxed: gpu?.auxAttributes?.sandboxed,
        },
        featureStatus: gpu?.featureStatus ?? {},
      };
      await this.attach(
        'chromium-gpu.json',
        Buffer.from(JSON.stringify(chromiumGpu, null, 2)),
        'application/json',
      );
      console.log(`[latkit:chromium-gpu] ${JSON.stringify(chromiumGpu)}`);
    } finally {
      await session.detach();
    }
  }
}
