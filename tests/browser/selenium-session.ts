import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';

import { By, type WebDriver } from 'selenium-webdriver';

import type { ConformanceSession } from './conformance.js';
import type { BrowserReport, FixtureState } from './fixture/src/protocol.js';

export class SeleniumSession implements ConformanceSession {
  readonly apiRequired = true;
  readonly hardwareEvidence = true;
  readonly #driver: WebDriver;
  readonly #baseUrl: string;
  readonly #outputDirectory: string;

  constructor(driver: WebDriver, baseUrl: string, outputDirectory: string) {
    this.#driver = driver;
    this.#baseUrl = baseUrl;
    this.#outputDirectory = outputDirectory;
  }

  async open(path: string): Promise<void> {
    await this.#driver.get(new URL(path, this.#baseUrl).toString());
    await this.#driver.wait(
      async () => this.#driver.executeScript<boolean>('return Boolean(window.latkitFixture);'),
      10_000,
      'Latkit browser fixture did not initialize',
    );
    await this.#attachRunEvidence();
  }

  async waitForCapabilities(): Promise<void> {
    await this.#waitForFixturePromise('capabilitiesReady');
    await this.#settleFixturePromise('ready');
  }

  async waitForRenderers(): Promise<void> {
    await this.#waitForFixturePromise('ready');
  }

  async report(): Promise<BrowserReport> {
    return this.#driver.executeScript<BrowserReport>('return window.latkitFixture.report();');
  }

  async state(): Promise<FixtureState> {
    return this.#driver.executeScript<FixtureState>('return window.latkitFixture.state();');
  }

  async setProjection(mode: 'flat' | 'tilt' | 'globe'): Promise<boolean> {
    return this.#invokeFixture<boolean>('setProjection', [mode]);
  }

  async destroyFirstMonitor(): Promise<void> {
    await this.#invokeFixture('destroyFirstMonitor');
  }

  async remountAfterLoss(): Promise<void> {
    await this.#invokeFixture('remountAfterLoss');
  }

  async click(selector: string, position: Readonly<{ x: number; y: number }>): Promise<void> {
    const element = await this.#driver.findElement(By.css(selector));
    const rect = await element.getRect();
    await this.#driver
      .actions({ async: true })
      .move({
        origin: element,
        x: Math.round(position.x - rect.width / 2),
        y: Math.round(position.y - rect.height / 2),
      })
      .click()
      .perform();
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    return this.#driver.findElement(By.css(selector)).then((element) => element.getAttribute(name));
  }

  async screenshot(selector: string): Promise<Buffer> {
    const base64 = await this.#driver
      .findElement(By.css(selector))
      .then((element) => element.takeScreenshot());
    return Buffer.from(base64, 'base64');
  }

  async attach(name: string, body: Buffer, _contentType: string): Promise<void> {
    await mkdir(this.#outputDirectory, { recursive: true });
    await writeFile(join(this.#outputDirectory, name), body);
  }

  async #waitForFixturePromise(name: 'capabilitiesReady' | 'ready'): Promise<void> {
    const error = await this.#driver.executeAsyncScript<string | null>(
      `
        const done = arguments[arguments.length - 1];
        window.latkitFixture[arguments[0]].then(
          () => done(null),
          (error) => done(error instanceof Error ? error.message : String(error)),
        );
      `,
      name,
    );
    if (error !== null) throw new Error(error);
  }

  async #settleFixturePromise(name: 'capabilitiesReady' | 'ready'): Promise<void> {
    await this.#driver.executeAsyncScript<void>(
      `
        const done = arguments[arguments.length - 1];
        window.latkitFixture[arguments[0]].then(() => done(), () => done());
      `,
      name,
    );
  }

  async #invokeFixture<T = void>(method: string, args: readonly unknown[] = []): Promise<T> {
    const result = await this.#driver.executeAsyncScript<
      Readonly<{ value: T | null; error: string | null }>
    >(
      `
        const method = arguments[0];
        const args = arguments[1];
        const done = arguments[arguments.length - 1];
        Promise.resolve(window.latkitFixture[method](...args)).then(
          (value) => done({ value, error: null }),
          (error) => done({
            value: null,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      `,
      method,
      args,
    );
    if (result.error !== null) throw new Error(result.error);
    return result.value as T;
  }

  async #attachRunEvidence(): Promise<void> {
    const capabilities = await this.#driver.getCapabilities();
    const run = {
      verification: 'hardware',
      driver: 'webdriver',
      browserName: capabilities.getBrowserName() ?? null,
      browserVersion: capabilities.getBrowserVersion() ?? null,
      browserPlatform: capabilities.getPlatform() ?? null,
      host: { platform: platform(), release: release(), arch: arch() },
      ci: Boolean(process.env.CI),
      githubSha: process.env.GITHUB_SHA ?? null,
    };
    await this.attach('run.json', Buffer.from(JSON.stringify(run, null, 2)), 'application/json');
    console.log(`[latkit:run] ${JSON.stringify(run)}`);
  }
}
