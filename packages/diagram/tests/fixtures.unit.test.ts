import { describe, expect, it } from 'vitest';
import { validateNetlist } from '@latkit/model';

import { empty, plant, randomNetlist, scale, system, twoArea } from './fixtures/netlists.js';

describe('shared netlist fixtures', () => {
  it('are valid netlists', () => {
    for (const netlist of [
      twoArea(),
      empty(),
      plant('steam'),
      plant('steamPss'),
      plant('renewable'),
      plant('classical'),
      system(40),
      randomNetlist(500, 7),
    ]) {
      expect(() => validateNetlist(netlist)).not.toThrow();
    }
  });

  it('builds plants with GridKit port names and one group each', () => {
    const steam = plant('steamPss');
    expect(steam.blockTitle).toEqual(['GENROU', 'TGOV1', 'IEEET1', 'IEEEST']);
    expect(steam.blockKey![0]).toBe('Genrou/1_1_genrou');
    expect(steam.groupCount).toBe(1);
    // pmech, efd, speed, vs, and the bus tag.
    expect(steam.netStart.length - 1).toBe(5);
    expect(steam.netStyle![4]).toBe(1);
  });

  it('reaches the EastWest scale', () => {
    const big = scale();
    expect(() => validateNetlist(big)).not.toThrow();
    expect(big.blockCount).toBeGreaterThan(35_000);
    expect(big.blockCount).toBeLessThan(37_000);
  });
});
