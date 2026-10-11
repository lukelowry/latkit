import { expect, it } from 'vitest';
import { kit, type Gpu } from '@latkit/gpu';
import { checkRecord, DEFAULTS, LINE, resolveStyle } from '../src/options.js';
import { RecordStyles } from '../src/scene/records.js';
import type { Geography } from '../src/geography.js';
const notTiles = () => false;

it('takes comets and sized labels on lines, as a network takes them on edges', () => {
  const line: Geography.LineOptions = {
    flowPx: 12,
    dash: true,
    labels: { field: 'name', fontSizePx: 11, repeatSpacingPx: 240 },
  };
  expect(() => checkRecord('line', 'river', line, notTiles)).not.toThrow();
  expect(() =>
    checkRecord('line', 'river', { labels: { field: 'name', fontSizePx: -1 } }, notTiles),
  ).toThrow('Invalid label fontSizePx');
  expect(() => checkRecord('area', 'lake', { flowPx: 1 } as never, notTiles)).toThrow(
    'Unknown area option: flowPx',
  );
  // A constant speed draws without reading any field; rows without one hold still.
  const records = new RecordStyles({} as Gpu);
  expect(records.constant(records.bind(line, LINE), [1, 1, 1, 1], 1)).toMatchObject({
    flow: 12,
    dash: true,
  });
  expect(records.constant(records.bind({}, LINE), [1, 1, 1, 1], 1).flow).toBe(0);
  const style = resolveStyle({ flowSpacingPx: 48 }, kit.resolveViewStyle({}));
  expect([style.flowSpacingPx, style.flowColor]).toEqual([48, DEFAULTS.flowColor]);
  expect(() => resolveStyle({ flowColor: [2, 0, 0, 1] }, kit.resolveViewStyle({}))).toThrow();
});

it('fits a map looking straight down, and spaces its graticule as asked', () => {
  const view = kit.resolveViewStyle({});
  const style = resolveStyle({}, view);
  expect([style.fitPitch, style.fitBearing, style.labelHaloPx, style.dashPeriodPx]).toEqual([
    0, 0, 2, 8,
  ]);
  expect(resolveStyle({ graticuleSpacingPx: 96, fitBearing: -15 }, view)).toMatchObject({
    graticuleSpacingPx: 96,
    fitBearing: -15,
  });
  expect(() => resolveStyle({ graticuleSpacingPx: 0 }, view)).toThrow();
  expect(() => resolveStyle({ nightFloor: 2 }, view)).toThrow();
});
