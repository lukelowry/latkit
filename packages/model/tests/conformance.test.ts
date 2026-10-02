import { copyBuffers } from '../src/index.js';
import { queryConformance } from './conformance.js';
import { staticData } from './fixture.js';
const query = { kind: 'rows', from: 'Node', select: ['value'] } as const;
for (const copied of [false, true])
  queryConformance(copied ? 'copied application data' : 'shared application data', async () => ({
    source: copied ? copyBuffers(staticData()) : staticData(),
    query,
    expectedRows: [0, 1, 2, 3],
    close: async () => {},
  }));
