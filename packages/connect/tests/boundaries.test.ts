import { afterEach, expect, it, vi } from 'vitest';
import { isFailure } from '@latkit/model';
import { connectModel, protocol } from '../src/index.js';
import { defaults, negotiate, peerFailure } from '../src/core.js';
import { batch, schema } from './fixture.js';

afterEach(() => vi.unstubAllGlobals());

it('checks a model before it opens a socket', async () => {
  let opened = 0;
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        opened++;
      }
    },
  );
  const model = {
    name: 'grid',
    schema,
    commands: { step: { parameters: {}, run: 'not a function' } },
  } as unknown as Parameters<typeof connectModel>[0];
  await expect(connectModel(model, { url: 'ws://127.0.0.1:1' })).rejects.toMatchObject({
    code: 'invalid-input',
  });
  await expect(
    connectModel({ name: 'grid', schema }, { url: 'ws://127.0.0.1:1', limits: { streams: 0 } }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(opened).toBe(0);
});

it('reports what a peer sends wrongly as a protocol failure', () => {
  expect(() => negotiate(defaults, { ...defaults, messageBytes: 'many' })).toThrow(
    expect.objectContaining({ code: 'protocol' }) as Error,
  );
  expect(() => negotiate(defaults, null)).toThrow(
    expect.objectContaining({ code: 'protocol' }) as Error,
  );
});

it("keeps a peer's failure codes that latkit knows, and names the rest", () => {
  const busy = peerFailure({ code: 'busy', message: 'Another command is running.' });
  expect(isFailure(busy, 'busy')).toBe(true);
  expect(busy.message).toBe('Another command is running.');
  const custom = peerFailure({ code: 'solver-diverged', message: 'No convergence.' });
  expect(isFailure(custom, 'internal')).toBe(true);
  expect(custom.message).toBe('solver-diverged: No convergence.');
  expect(() => peerFailure({ code: 7, message: 'x' })).toThrow(
    expect.objectContaining({ code: 'protocol' }) as Error,
  );
});

it('forwards a received publication to another stream without encoding it again', () => {
  const sent = protocol.preparePublication(batch(), 3, schema, defaults).encode(1),
    received = protocol.decode(sent, defaults);
  const relayed = protocol.forward(9, received.payload).encode(4),
    frame = protocol.decode(relayed, defaults);
  expect([frame.op, frame.id, frame.sequence]).toEqual([protocol.Op.publication, 9, 4]);
  expect(frame.payload).toEqual(received.payload);
  expect(protocol.decodePublication({ bytes: frame.payload }, schema, defaults)).toEqual(
    protocol.decodePublication({ bytes: received.payload }, schema, defaults),
  );
});
