import { test } from '@playwright/test';

import { conformanceScenarios } from './conformance.js';
import { PlaywrightSession } from './playwright-session.js';

for (const scenario of conformanceScenarios) {
  test(scenario.name, async ({ page }, testInfo) => {
    const scope: unknown = testInfo.project.metadata.scope;
    test.skip(
      scenario.requiresRenderers && scope === 'capabilities',
      'This engine lane records WebGPU capabilities without making a hardware support claim.',
    );
    await scenario.run(new PlaywrightSession(page, testInfo));
  });
}
