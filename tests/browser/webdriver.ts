import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Browser, Builder, type WebDriver } from 'selenium-webdriver';
import { Options as FirefoxOptions } from 'selenium-webdriver/firefox.js';

import { conformanceScenarios } from './conformance.js';
import { SeleniumSession } from './selenium-session.js';

type SupportedBrowser = 'firefox' | 'safari';

interface ScenarioResult {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly error?: string;
}

const requestedBrowser = process.argv[2];
if (requestedBrowser !== 'firefox' && requestedBrowser !== 'safari') {
  throw new Error('Expected a browser argument: firefox or safari');
}
const requestedScope = process.argv[3] ?? 'full';
if (requestedScope !== 'full' && requestedScope !== 'capabilities') {
  throw new Error('Expected a scope argument: full or capabilities');
}

const browser = requestedBrowser;
const outputRoot = join('output', 'webdriver', browser, requestedScope);
const driver = await createDriver(browser);
const results: ScenarioResult[] = [];
const scenarios =
  requestedScope === 'capabilities'
    ? conformanceScenarios.filter((scenario) => !scenario.requiresRenderers)
    : conformanceScenarios;

try {
  for (const scenario of scenarios) {
    const outputDirectory = join(outputRoot, slug(scenario.name));
    const session = new SeleniumSession(driver, 'http://127.0.0.1:4178', outputDirectory);
    try {
      await scenario.run(session);
      results.push({ name: scenario.name, status: 'passed' });
      console.log(`[latkit:scenario] passed: ${scenario.name}`);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      results.push({ name: scenario.name, status: 'failed', error: message });
      console.error(`[latkit:scenario] failed: ${scenario.name}\n${message}`);
    }
  }
} finally {
  await driver.quit();
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'summary.json'), JSON.stringify(results, null, 2));
}

const failures = results.filter((result) => result.status === 'failed');
if (failures.length > 0) {
  throw new Error(`${failures.length} browser conformance scenario(s) failed`);
}

async function createDriver(browser: SupportedBrowser): Promise<WebDriver> {
  let builder = new Builder().forBrowser(browser === 'firefox' ? Browser.FIREFOX : Browser.SAFARI);
  if (browser === 'firefox') {
    const options = new FirefoxOptions();
    const binary = process.env.FIREFOX_BINARY;
    if (binary) options.setBinary(binary);
    if (process.env.LATKIT_HEADLESS === 'true') options.addArguments('-headless');
    builder = builder.setFirefoxOptions(options);
  }
  return builder.build();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
