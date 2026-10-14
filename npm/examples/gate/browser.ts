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

/** Chrome, headless, with WebGPU on and `args` besides. */
export function launch(args: readonly string[] = []): Promise<Browser> {
  return deadline(
    chromium.launch({
      executablePath: chrome(),
      headless: true,
      args: [
        '--enable-unsafe-webgpu',
        '--ignore-gpu-blocklist',
        '--enable-features=WebGPU',
        ...args,
      ],
    }),
    STEP,
    'launch Chrome',
  );
}
