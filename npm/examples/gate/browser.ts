/**
 * What the gate and the benchmark share: Chrome to drive, and deadlines every wait races.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/** Milliseconds any one step may take before giving up on it. */
export const STEP = 60_000;

/** Rejects after `ms` with what timed out. */
export function deadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${step}`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Chrome to drive: `$LATKIT_CHROME`, or the newest Chromium in Playwright's browser cache. */
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

/** A Chrome being driven, and how it ends. */
export interface Chrome {
  browser: Browser;
  /**
   * Ends Chrome: politely within seconds, else by killing its processes. A page stuck on its GPU
   * never closes politely, and a Chrome left behind keeps the GPU busy under the next one.
   */
  close(): Promise<void>;
}

/**
 * WebGPU on SwiftShader, which draws on the CPU, so no shader can hang the machine's GPU. These
 * override Chrome's own GPU checks, so a real GPU never gets them.
 */
const SOFTWARE = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan,WebGPU',
];

/** Chrome, headless, with `args` besides: on SwiftShader when `software`, as Linux always is. */
export async function launch(
  args: readonly string[] = [],
  software = process.platform === 'linux',
): Promise<Chrome> {
  const server = await deadline(
    chromium.launchServer({
      executablePath: chrome(),
      headless: true,
      args: [...(software ? SOFTWARE : []), ...args],
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
