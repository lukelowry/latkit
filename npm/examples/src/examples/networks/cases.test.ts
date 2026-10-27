import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { readCase } from './cases.js';
import { inflate } from './format.js';

const CASES = ['wecc240', 'activsg2000', 'activsg10k', 'activsg25k', 'activsg70k'] as const;

/** Reads case `id` from the file the page fetches. */
async function read(id: string) {
  return readCase(id, await inflate(readFileSync(`npm/examples/public/grids/${id}.bin`)));
}

describe('grid cases', () => {
  test.each(CASES)(
    '%s reads into buses, lines, and machines positioned on the earth',
    async (id) => {
      const found = await read(id);
      const rows = Object.fromEntries(
        found.data.describe().tables.map((table) => [table.name, table.rows]),
      );
      expect(rows).toMatchObject({ Bus: found.buses, Line: found.lines, Machine: found.machines });
      expect(found.buses).toBeGreaterThan(200);
      for (let i = 0; i < found.positions.length; i += 2) {
        expect(Math.abs(found.positions[i]!)).toBeLessThanOrEqual(180);
        expect(Math.abs(found.positions[i + 1]!)).toBeLessThanOrEqual(90);
      }
      // Every line's `from` and `to` reference a bus of the case, and every machine's bus row exists.
      const lines = found.data.query({ of: 'Line', select: { from: 'from', to: 'to' } });
      const ends = lines.fields as Record<string, { ids: (number | string | null)[] }>;
      expect(ends.from!.ids.every((id) => id !== null)).toBe(true);
      expect(ends.to!.ids.every((id) => id !== null)).toBe(true);
      expect(found.machineBus.every((bus) => bus < found.buses)).toBe(true);
    },
  );

  test('a simulated case faults at a second, and its machines swing after', async () => {
    const { simulation, machines } = await read('wecc240');
    expect(simulation?.fault?.on).toBeCloseTo(1, 1);
    const frame = Math.round(3 / simulation!.dt);
    const speeds = simulation!.speeds.subarray(frame * machines, (frame + 1) * machines);
    expect(speeds.some((mhz) => Math.abs(mhz) > 0)).toBe(true);
  });

  test('bytes that are not a grid case are rejected', () => {
    expect(() => readCase('nothing', new ArrayBuffer(16))).toThrow('not a grid case');
  });
});
