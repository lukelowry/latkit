import { describe, expect, it } from 'vitest';

import { validateNetlist, type Netlist } from '../src/index.js';

/** One TwoArea generator unit: TGOV1 drives pmech, IEEET1 drives efd, GENROU's speed feeds both. */
function twoArea(): Netlist {
  return {
    blockCount: 3,
    blockKey: ['Genrou/1_1_genrou', 'Tgov1/1_1_tgov1', 'Ieeet1/1_1_ieeet1'],
    blockTitle: ['GENROU', 'TGOV1', 'IEEET1'],
    portStart: Uint32Array.of(0, 3, 5, 7),
    portFlow: Uint8Array.of(0, 0, 1, /* tgov1 */ 0, 1, /* ieeet1 */ 0, 1),
    portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed', 'efd'],
    netStart: Uint32Array.of(0, 2, 4, 7),
    netPorts: Uint32Array.of(4, 0, /* efd */ 6, 1, /* speed */ 2, 3, 5),
    netLabel: ['1_1_pmech', '1_1_efd', '1_1_speed'],
  };
}

describe('validateNetlist', () => {
  it('accepts the TwoArea unit, with and without every optional column', () => {
    expect(() => validateNetlist(twoArea())).not.toThrow();
    expect(() =>
      validateNetlist({
        ...twoArea(),
        portKind: new Uint8Array(7),
        portSide: Uint8Array.of(0, 0, 1, 0, 1, 0, 3),
        netStyle: Uint8Array.of(0, 0, 1),
        groupCount: 1,
        blockGroup: Uint32Array.of(0, 0, 0xffffffff),
        blockLabel: ['1_1_genrou', '1_1_tgov1', '1_1_ieeet1'],
        groupLabel: ['1_1'],
      }),
    ).not.toThrow();
  });

  it('accepts an empty netlist', () => {
    expect(() =>
      validateNetlist({
        blockCount: 0,
        portStart: Uint32Array.of(0),
        portFlow: new Uint8Array(0),
        netStart: Uint32Array.of(0),
        netPorts: new Uint32Array(0),
      }),
    ).not.toThrow();
  });

  it('accepts unwired ports, empty nets, and undirected nets without a driver', () => {
    expect(() =>
      validateNetlist({
        blockCount: 2,
        portStart: Uint32Array.of(0, 2, 3),
        portFlow: Uint8Array.of(2, 0, 2),
        netStart: Uint32Array.of(0, 0, 2),
        netPorts: Uint32Array.of(0, 2),
      }),
    ).not.toThrow();
  });

  it('names the first invalid field', () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['invalid block count', { blockCount: -1 }],
      ['invalid block count', { blockCount: 1.5 }],
      ['portStart must be Uint32Array', { portStart: [0, 3, 5, 7] }],
      ['invalid portStart length', { portStart: Uint32Array.of(0, 3, 7) }],
      ['portStart must begin at zero', { portStart: Uint32Array.of(1, 3, 5, 7) }],
      ['portStart must be monotonic', { portStart: Uint32Array.of(0, 5, 3, 7) }],
      ['portFlow must be Uint8Array', { portFlow: [0, 0, 1, 0, 1, 0, 1] }],
      ['invalid portFlow length', { portFlow: Uint8Array.of(0, 0, 1) }],
      ['invalid port flow', { portFlow: Uint8Array.of(0, 0, 1, 0, 1, 0, 3) }],
      ['portKind must be Uint8Array', { portKind: new Uint32Array(7) }],
      ['invalid portKind length', { portKind: new Uint8Array(6) }],
      ['portSide must be Uint8Array', { portSide: [0, 0, 1, 0, 1, 0, 1] }],
      ['invalid portSide length', { portSide: new Uint8Array(8) }],
      ['invalid port side', { portSide: Uint8Array.of(0, 0, 1, 0, 1, 0, 4) }],
      ['netPorts must be Uint32Array', { netPorts: [4, 0, 6, 1, 2, 3, 5] }],
      ['netStart must be Uint32Array', { netStart: [0, 2, 4, 7] }],
      ['invalid netStart length', { netStart: new Uint32Array(0) }],
      ['netStart must begin at zero', { netStart: Uint32Array.of(1, 2, 4, 7) }],
      ['netStart must be monotonic', { netStart: Uint32Array.of(0, 4, 2, 7) }],
      ['netStart terminal mismatch', { netStart: Uint32Array.of(0, 2, 4, 6) }],
      ['net port out of range', { netPorts: Uint32Array.of(4, 0, 6, 1, 2, 3, 7) }],
      ['port on more than one net', { netPorts: Uint32Array.of(4, 0, 6, 1, 2, 3, 0) }],
      [
        'net has more than one driver',
        { netStart: Uint32Array.of(0, 4, 4, 7), netPorts: Uint32Array.of(4, 0, 6, 1, 2, 3, 5) },
      ],
      ['net mixes port kinds', { portKind: Uint8Array.of(0, 0, 0, 0, 1, 0, 0) }],
      ['netStyle must be Uint8Array', { netStyle: [0, 0, 1] }],
      ['invalid netStyle length', { netStyle: Uint8Array.of(0, 0) }],
      ['invalid net style', { netStyle: Uint8Array.of(0, 0, 2) }],
      ['invalid group count', { groupCount: -2 }],
      ['blockGroup must be Uint32Array', { groupCount: 1, blockGroup: [0, 0, 0] }],
      ['invalid blockGroup length', { groupCount: 1, blockGroup: Uint32Array.of(0, 0) }],
      ['block group out of range', { groupCount: 1, blockGroup: Uint32Array.of(0, 1, 0) }],
      ['block group out of range', { blockGroup: Uint32Array.of(0, 0, 0) }],
      ['blockKey must be an array of strings', { blockKey: ['a', 'b', 3] }],
      ['invalid blockKey length', { blockKey: ['a', 'b'] }],
      ['duplicate block key', { blockKey: ['a', 'b', 'a'] }],
      ['blockTitle must be an array of strings', { blockTitle: 'GENROU' }],
      ['invalid blockTitle length', { blockTitle: ['GENROU'] }],
      ['invalid blockLabel length', { blockLabel: ['a', 'b', 'c', 'd'] }],
      ['invalid portLabel length', { portLabel: ['pmech'] }],
      ['portLabel must be an array of strings', { portLabel: [1, 2, 3, 4, 5, 6, 7] }],
      ['invalid netLabel length', { netLabel: ['a', 'b'] }],
      ['invalid groupLabel length', { groupLabel: ['1_1'] }],
    ];
    for (const [message, patch] of cases) {
      expect(() => validateNetlist({ ...twoArea(), ...patch } as never), message).toThrow(message);
    }
  });

  it('checks kinds only between ports that share a net', () => {
    // pmech is kind 0, efd kind 1, speed kind 2: each net agrees with itself.
    expect(() =>
      validateNetlist({ ...twoArea(), portKind: Uint8Array.of(0, 1, 2, 2, 0, 2, 1) }),
    ).not.toThrow();
  });
});
