import { bench, describe } from 'vitest';

import { arrangeAll } from '../src/layout/arrange.js';
import { placeNew } from '../src/layout/pack.js';
import { prepare } from '../src/prepare.js';
import { randomNetlist, scale, system } from './fixtures/netlists.js';

const G = 8;

/** About 36k blocks in 13.1k plants of four shapes: the EastWest signal diagram's scale. */
const eastWest = prepare(scale(), G);
/** One 2000-block component: the layered layout itself, with no shape to share. */
const tangle = prepare(randomNetlist(2000, 11), G);
/** A reload that adds 100 plants to 900 arranged ones. */
const grown = prepare(system(1000), G);
const before = arrangeAll(prepare(system(900), G));
const carried = new Float32Array(2 * grown.blockCount).fill(Number.NaN);
carried.set(before);

describe('layout', () => {
  bench('arrangeAll, 36k blocks of four plant shapes', () => {
    arrangeAll(eastWest);
  });

  bench('arrangeAll, one random 2000-block component', () => {
    arrangeAll(tangle);
  });

  bench('placeNew, 100 new plants beside 900', () => {
    const positions = carried.slice();
    placeNew(grown, positions, positions.slice());
  });
});
