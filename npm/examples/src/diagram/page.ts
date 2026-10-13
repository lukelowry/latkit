import { Data, Patch, reference, type Id, type Layout, type Row, type Scene } from 'latkit';
import type { Stage } from '../ui/stage.js';

type Route = 'orthogonal' | 'straight';

const AREAS = ['Intake', 'Treatment', 'Output'];
/** Each unit's name, area, and whether it drains into the shared drain. */
const UNITS: readonly [string, number, boolean][] = [
  ['Well A', 1, false],
  ['Well B', 1, false],
  ['Screen', 1, false],
  ['Dosing', 2, false],
  ['Mixer', 2, false],
  ['Clarifier', 2, true],
  ['Filter 1', 2, true],
  ['Filter 2', 2, true],
  ['Tank', 3, false],
  ['Pump', 3, false],
  ['Main', 3, false],
];
/** Pipes, from one unit to the next by id. */
const PIPES: readonly [number, number][] = [
  [1, 3],
  [2, 3],
  [3, 5],
  [4, 5],
  [5, 6],
  [6, 7],
  [6, 8],
  [7, 9],
  [8, 9],
  [9, 10],
  [10, 11],
];

/** A water plant as a block diagram: units in areas, piped one to the next, three of them sharing a
 * drain through the ports on their bottoms. Nothing gives a position; the layout places every unit. */
function plant(): Data {
  return new Data('plant').apply(
    new Patch()
      .set('Area', [1, 2, 3], { name: AREAS, folded: [false, false, false] })
      .set('Drain', [1], { name: ['Drain'] })
      .set(
        'Unit',
        UNITS.map((_, i) => i + 1),
        {
          name: UNITS.map(([name]) => name),
          area: reference(
            'Area',
            UNITS.map(([, area]) => area),
          ),
          drain: reference(
            'Drain',
            UNITS.map(([, , drains]) => (drains ? 1 : null)),
          ),
        },
      )
      .set(
        'Pipe',
        PIPES.map((_, i) => i + 1),
        {
          from: reference(
            'Unit',
            PIPES.map(([from]) => from),
          ),
          to: reference(
            'Unit',
            PIPES.map(([, to]) => to),
          ),
        },
      ),
  );
}

export default function page(stage: Stage): void {
  let data = plant();
  let layout: Layout = { layered: { flow: 'right', gap: 24, rankGap: 70 } };
  let route: Route = 'orthogonal';
  const scene = (): Scene => ({
    space: { plane: { grid: 'off' } },
    layout,
    theme: { base: 'dark', background: '#0b0f14', groupPadding: 14 },
    controls: { connect: true, delete: true, selectBox: true },
    marks: [
      {
        vertices: {
          of: ['plant', 'Area'],
          contains: ['Unit', 'area'],
          collapsed: 'folded',
          marker: 'rounded',
          size: [{ units: 60 }, { units: 30 }],
          color: '#18212c',
          label: { text: 'name', size: 11, color: '#7f93a8' },
        },
      },
      {
        edges: {
          of: ['plant', 'Pipe'],
          ends: ['from', 'to'],
          route,
          arrows: true,
          width: 1.5,
          color: '#9fb2c6',
        },
      },
      { edges: { of: ['plant', 'Drain'], route, width: 1.5, dash: true, color: '#4fb0de' } },
      {
        vertices: {
          of: ['plant', 'Unit'],
          size: [{ units: 64 }, { units: 28 }],
          marker: { block: { corner: 4 } },
          color: '#2c3b4d',
          ports: [['drain', 'bottom']],
          label: { text: 'name', size: 11 },
        },
      },
    ],
  });
  const view = stage.view(scene(), {
    label:
      'A water plant: drag from a port or Alt-drag a unit to connect, drag a pipe off its end, Delete removes, right-click for a menu',
  });
  view.setData(data);
  view.fit();
  const update = (patch: Patch) => {
    data = data.apply(patch);
    view.setData(data);
  };
  const layouts: readonly (readonly [string, Layout])[] = [
    ['In ranks, left to right', layout],
    ['In ranks, top to bottom', { layered: { flow: 'down', gap: 24, rankGap: 50 } }],
    ['By graph distance', { stress: { gap: 110 } }],
  ];
  stage.section('Layout').choice(
    'Place units',
    layouts,
    layout,
    (next) => {
      layout = next;
      view.show(scene());
      view.fit();
    },
  );
  stage.section('Pipes').choice(
    'Run',
    [
      ['Around units', 'orthogonal'],
      ['Straight', 'straight'],
    ] as const,
    route,
    (next) => {
      route = next;
      view.show(scene());
    },
  );
  const areas = stage.section('Areas');
  AREAS.forEach((name, i) => {
    areas.toggle(`Fold ${name}`, String(i + 1), false, (folded) =>
      update(new Patch().set('Area', [i + 1], { folded: [folded] })),
    );
  });
  const told = stage.section('Last event');
  const readout = document.createElement('p');
  readout.className = 'series';
  readout.textContent = 'Connect, delete, or right-click.';
  told.element.append(readout);
  const name = (row: Row) => (data.get(row.table, row.id, 'name') as string | null) ?? `${row.table} ${row.id}`;
  let next = PIPES.length + 1;
  view.on('connect', ({ from, to, edge }) => {
    if (!to) return (readout.textContent = `Connection from ${name(from.row)} let go over nothing.`);
    if (edge) {
      const stays = data.get('Pipe', edge.id, 'from') === from.row.id ? 'to' : 'from';
      update(new Patch().set('Pipe', [edge.id as number], { [stays]: reference('Unit', [to.row.id as number]) }));
      readout.textContent = `Pipe ${edge.id} now runs ${stays === 'to' ? 'to' : 'from'} ${name(to.row)}.`;
      return;
    }
    const id = next++;
    update(
      new Patch().set('Pipe', [id], {
        from: reference('Unit', [from.row.id as number]),
        to: reference('Unit', [to.row.id as number]),
      }),
    );
    readout.textContent = `Piped ${name(from.row)} to ${name(to.row)}.`;
  });
  view.on('delete', (rows) => {
    const byTable = new Map<string, Id[]>();
    for (const row of rows) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row.id]);
    const patch = new Patch();
    for (const [table, ids] of byTable) patch.remove(table, ids as number[]);
    update(patch);
    readout.textContent = `Removed ${rows.map(name).join(', ')}.`;
  });
  view.on('menu', ({ hits }) => {
    readout.textContent = hits.length
      ? `Menu for ${hits.map((h) => name(h.row) + (h.port ? ` (${h.port} port)` : '')).join(', ')}.`
      : 'Menu for the background.';
  });
  stage.meter(view);
  stage.detail(`${UNITS.length} units · ${PIPES.length} pipes · ${AREAS.length} areas · 1 drain`);
}
