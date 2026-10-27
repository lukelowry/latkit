/**
 * Helpers shared by the gate and the benchmark: serving a page, launching Chrome, collecting a
 * page's errors, and deadlines for every wait.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
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

/** A launched Chrome. */
export interface Chrome {
  browser: Browser;
  /**
   * Closes Chrome, or kills its processes if it has not closed within 5 s. A page stuck on the GPU
   * never closes normally, and a leftover Chrome would keep the GPU busy during the next one.
   */
  close(): Promise<void>;
}

/**
 * Flags that run WebGPU on SwiftShader, which draws on the CPU, so no shader can hang the machine's
 * GPU. They override Chrome's own GPU checks, so they are never passed with a real GPU. On Linux,
 * ANGLE uses SwiftShader too, as GPU-less CI needs. On Windows that flag leaves WebGPU no adapter.
 */
const SOFTWARE = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  ...(process.platform === 'linux' ? ['--use-angle=swiftshader'] : []),
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan,WebGPU',
];

/**
 * Makes a machine with two GPUs draw on the fast one on every launch. Chrome ignores WebGPU's
 * `powerPreference` on Windows and may pick either GPU elsewhere, so times and limit-bound work
 * would otherwise compare two devices.
 */
const HARDWARE = ['--force_high_performance_gpu'];

/** Launches headless Chrome with the extra `args`. It draws on SwiftShader when `software`, which
 * defaults to true on Linux. */
export async function launch(
  args: readonly string[] = [],
  software = process.platform === 'linux',
): Promise<Chrome> {
  const server = await deadline(
    chromium.launchServer({
      executablePath: chrome(),
      headless: true,
      args: [...(software ? SOFTWARE : HARDWARE), ...args],
    }),
    STEP,
    'launch Chrome',
  );
  // Killing ends the whole process tree, as `taskkill /T /F` does on Windows.
  const kill = () => deadline(server.kill(), 10_000, 'kill Chrome').catch(() => {});
  try {
    const browser = await deadline(
      chromium.connect(server.wsEndpoint()),
      STEP,
      'connect to Chrome',
    );
    const close = () => deadline(server.close(), 5_000, 'close Chrome').catch(kill);
    return { browser, close };
  } catch (error) {
    await kill();
    throw error;
  }
}
