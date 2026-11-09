/**
 * Helpers shared by the gate and the benchmark: serving a page, launching Chrome, collecting a
 * page's errors, and deadlines for every wait.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

/** Milliseconds any one step may take before giving up on it. */
export const STEP = 60_000;

/** Races `work` against a timer that rejects after `ms` with an error naming `step`. */
export function deadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${step}`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A Vite dev server, and the address it serves at. */
export interface Served {
  readonly url: string;
  /** Stops the server, waiting at most 10 s. */
  close(): Promise<void>;
}

/** Serves the Vite project in `root` with its `vite.config.ts`, at `port` or the next free port.
 * `what` names it in errors. */
export async function serve(root: string, port: number, what: string): Promise<Served> {
  const server = await deadline(
    createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      logLevel: 'error',
      server: { port, strictPort: false },
    }),
    STEP,
    `configure ${what}`,
  );
  const close = () => deadline(server.close(), 10_000, `stop serving ${what}`).catch(() => {});
  try {
    await deadline(server.listen(), STEP, `serve ${what}`);
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error(`${what} has no address`);
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Collects `page`'s uncaught errors and console errors as they happen, each cut to 300
 * characters. */
export function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message.slice(0, 300)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`);
  });
  return errors;
}

/** Returns the path of the Chrome to drive: `$LATKIT_CHROME`, or else the newest Chromium in
 * Playwright's browser cache. Throws if there is none. */
export function chrome(): string {
  const given = process.env.LATKIT_CHROME;
  if (given) return given;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'));
  const builds = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  const executables = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const build of builds) {
    for (const executable of executables) {
      const found = path.join(cache, build, executable);
      if (fs.existsSync(found)) return found;
    }
  }
  throw new Error(
    `no Chrome found in ${cache}: set LATKIT_CHROME, or run \`pnpm --dir npm/examples exec playwright-core install chromium\``,
  );
}

/** A launched test browser: Chrome unless launched as another engine. */
export interface Chrome {
  browser: Browser;
  /**
   * Closes the browser, or kills its processes if it has not closed within 5 s. A page stuck on
   * the GPU never closes normally, and a leftover browser would keep the GPU busy during the next one.
   */
  close(): Promise<void>;
}

/** Software WebGL2 for GPU-less CI. Hardware runs never override the driver's blocklist. */
const SOFTWARE = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** Selects the high-performance GPU consistently for comparable measurements, and the backend
 * Chrome draws WebGL2 with when `LATKIT_ANGLE` names one: `d3d11`, `vulkan`, `gl`, or `metal`.
 * Each backend reports its own renderer, so the benchmark keeps its times apart. */
function hardware(): string[] {
  const angle = process.env.LATKIT_ANGLE;
  return ['--force_high_performance_gpu', ...(angle ? [`--use-angle=${angle}`] : [])];
}

/** A browser the gate and the benchmark can drive. */
export type Engine = 'chromium' | 'firefox' | 'webkit';

/** The engine a script's `--firefox` or `--webkit` flag names. Defaults to Chrome. */
export function engineOf(argv: readonly string[]): Engine {
  return argv.includes('--firefox') ? 'firefox' : argv.includes('--webkit') ? 'webkit' : 'chromium';
}

/** Launches the headless browser `engine` (Chrome by default) with the extra `args`. Chrome draws
 * on SwiftShader when `software`, which defaults to true on Linux. Firefox and WebKit use their
 * default renderers and take no Chrome flags. */
export async function launch(
  args: readonly string[] = [],
  software = process.platform === 'linux',
  engine: Engine = 'chromium',
): Promise<Chrome> {
  const driver = { chromium, firefox, webkit }[engine];
  const server = await deadline(
    driver.launchServer({
      headless: true,
      ...(engine === 'chromium'
        ? { executablePath: chrome(), args: [...(software ? SOFTWARE : hardware()), ...args] }
        : {}),
      // Headless Firefox blocks WebGL2 on its GPU blocklist unless forced.
      ...(engine === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true } } : {}),
    }),
    STEP,
    `launch ${engine}`,
  );
  // Killing ends the whole process tree, as `taskkill /T /F` does on Windows.
  const kill = () => deadline(server.kill(), 10_000, `kill ${engine}`).catch(() => {});
  try {
    const browser = await deadline(
      driver.connect(server.wsEndpoint()),
      STEP,
      `connect to ${engine}`,
    );
    const close = () => deadline(server.close(), 5_000, `close ${engine}`).catch(kill);
    return { browser, close };
  } catch (error) {
    await kill();
    throw error;
  }
}
