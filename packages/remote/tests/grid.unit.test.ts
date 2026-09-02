import { describe, expect, it, vi } from 'vitest';

import { createGrid, type Grid } from '@latkit/model';
import { connect, protocol } from '@latkit/port';
import { loopback, type LoopbackPort, settle } from '@latkit/port/testing';

import { connectGrid, type GridHeader, type RemoteGrid, serveGrid } from '../src/index.js';

function grid(
  labels: readonly string[],
  values: readonly number[],
): { grid: Grid; header: GridHeader } {
  const columns = [
    { kind: 'number' as const, id: 'value', label: 'Value', values: Float64Array.from(values) },
  ];
  return {
    grid: createGrid(labels, columns),
    header: { rowCount: labels.length, columns: [{ id: 'value', label: 'Value' }] },
  };
}

/** Collect every binding the client receives, awaiting the initial describe. */
async function follow(client: LoopbackPort) {
  const grids: (RemoteGrid | null)[] = [];
  const stop = connectGrid(client, 'case', (remote) => grids.push(remote));
  await settle();
  return { grids, stop, latest: () => grids[grids.length - 1] ?? null };
}

describe('grid service', () => {
  it('describes the served grid on connect and windows it', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    const { grid: g, header } = grid(['Alpha', 'Bravo', 'Cash'], [0, 10, 20]);
    served.set(g, header);

    const { grids, latest } = await follow(client);
    expect(grids).toHaveLength(1);
    expect(latest()).toMatchObject({ rowCount: 3, columns: [{ id: 'value', label: 'Value' }] });
    const window = await latest()!.window('', { column: 'value', dir: 'desc' }, 0, 2);
    expect(window.total).toBe(3);
    expect(window.rows.map((row) => [row.label, ...row.cells])).toEqual([
      ['Cash', '20'],
      ['Bravo', '10'],
    ]);
  });

  it('publishes null when nothing is served and answers empty windows meanwhile', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    const { grids } = await follow(client);
    expect(grids).toEqual([null]);
    served.set(null);
    await settle();
    expect(grids).toEqual([null, null]);
  });

  it('set rebinds the client to the new grid as a fresh binding', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    const first = grid(['Alpha', 'Bravo'], [0, 10]);
    served.set(first.grid, first.header);
    const { grids, latest } = await follow(client);

    const next = grid(['Alpha', 'Bravo'], [7, 3]);
    served.set(next.grid, next.header);
    await settle();
    expect(grids).toHaveLength(2);
    expect(latest()).not.toBe(grids[0]);
    const rows = await latest()!.window('', { column: 'value', dir: 'asc' }, 0, 2);
    expect(rows.rows.map((row) => row.label)).toEqual(['Bravo', 'Alpha']);
  });

  it('locates a row through the port under the caller-owned sort and filter', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    const { grid: g, header } = grid(['Alpha', 'Bravo', 'Cash'], [0, 10, 20]);
    served.set(g, header);
    const { latest } = await follow(client);
    const binding = latest()!;
    expect(await binding.locate(0, '', { column: 'value', dir: 'desc' })).toBe(2);
    expect(await binding.locate(0, 'zzz', null)).toBeNull();
    served.set(null); // a stale binding asking after its grid is gone hears "no position"
    await settle();
    expect(await binding.locate(0, '', null)).toBeNull();
  });

  it('rejects a malformed request without ending the service', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    const { grid: g, header } = grid(['Alpha'], [1]);
    served.set(g, header);
    const raw = connect(client, protocol<unknown, unknown>('grid:case'));
    await expect(
      raw.call({ op: 'window', query: 1, sort: null, offset: 0, limit: 5 }),
    ).rejects.toThrow(/malformed/);
    await expect(
      raw.call({ op: 'window', query: '', sort: null, offset: 0, limit: 1e9 }),
    ).rejects.toThrow(/malformed/);
    await expect(raw.call({ op: 'locate', index: -1, query: '', sort: null })).rejects.toThrow(
      /malformed/,
    );
    await expect(
      raw.call({ op: 'locate', index: 0, query: '', sort: { column: 'value', dir: 'up' } }),
    ).rejects.toThrow(/malformed/);
    await expect(raw.call({ op: 'nope' })).rejects.toThrow(/malformed/);
    expect(await raw.call({ op: 'describe' })).toMatchObject({ header: { rowCount: 1 } });
  });

  /** A grid whose requests stay open until it is disposed (as an engine mid-pass would). */
  function slowGrid(): Grid {
    const rejecters: ((error: Error) => void)[] = [];
    const pending = () => new Promise<never>((_, fail) => rejecters.push(fail));
    return {
      window: pending,
      locate: pending,
      dispose: () =>
        rejecters.splice(0).forEach((fail) => fail(new DOMException('cancelled', 'AbortError'))),
    };
  }

  it('answers a request abandoned by a replacement grid as empty, not as an error', async () => {
    const [server, client] = loopback();
    const served = serveGrid(server, 'case');
    served.set(slowGrid(), { rowCount: 1, columns: [] });
    const { latest } = await follow(client);
    const inFlight = latest()!.window('', null, 0, 5);
    const lookup = latest()!.locate(0, '', null);
    await settle();
    const only = grid(['Only'], [1]);
    served.set(only.grid, only.header);
    expect(await inFlight).toEqual({ rows: [], total: 0 });
    expect(await lookup).toBeNull();
    expect((await latest()!.window('', null, 0, 5)).rows.map((row) => row.label)).toEqual(['Only']);
  });

  it('disposes the previous grid on set and everything on close', async () => {
    const [server, client] = loopback();
    const { grid: g, header } = grid(['Alpha'], [1]);
    const dispose = vi.spyOn(g, 'dispose');
    const served = serveGrid(server, 'case');
    served.set(g, header);
    const { stop } = await follow(client);
    served.set(null);
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => served.set(g)).toThrow(/needs a header/);
    served.close();
    stop();
  });
});
