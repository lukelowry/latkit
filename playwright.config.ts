import { defineConfig } from '@playwright/test';

// Chrome documents these flags for headless WebGPU on Linux. Other platforms
// use their normal backend; forcing ANGLE/Vulkan on Windows can hide D3D12.
const webGpuArgs =
  process.platform === 'linux'
    ? [
        '--use-angle=vulkan',
        '--enable-features=Vulkan',
        '--disable-vulkan-surface',
        '--enable-unsafe-webgpu',
      ]
    : [];

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './output/playwright/results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  captureGitInfo: { commit: true, diff: true },
  retries: 0,
  reporter: [
    [process.env.CI ? 'line' : 'list'],
    ['html', { open: 'never', outputFolder: 'output/playwright/report' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4178',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @latkit/browser-fixture dev',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-engine',
      metadata: { verification: 'engine', scope: 'full', api: 'required' },
      use: {
        browserName: 'chromium',
        // Full Chromium's new headless mode; headless shell does not expose a
        // Core adapter reliably and is not representative of the browser.
        channel: 'chromium',
        launchOptions: { args: webGpuArgs },
      },
    },
    {
      name: 'firefox-engine',
      metadata: { verification: 'engine', scope: 'capabilities', api: 'required' },
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit-engine',
      metadata: {
        verification: 'engine',
        scope: 'capabilities',
        api: process.platform === 'darwin' ? 'required' : 'optional',
      },
      use: { browserName: 'webkit' },
    },
    {
      name: 'chrome-hardware',
      metadata: { verification: 'hardware', scope: 'full', api: 'required' },
      use: { browserName: 'chromium', channel: 'chrome' },
    },
    {
      name: 'edge-hardware',
      metadata: { verification: 'hardware', scope: 'full', api: 'required' },
      use: { browserName: 'chromium', channel: 'msedge' },
    },
  ],
});
