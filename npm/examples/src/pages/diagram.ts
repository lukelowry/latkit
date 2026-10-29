/**
 * A block diagram on a sheet: blocks with ports, wires routed around them, and groups drawn around
 * their members. Each block kind is a table. Its reference fields name the signal on each port, and
 * an edges mark over the signals draws them as wires. Drag blocks, draw wires from an output to an
 * input, delete with the Delete key, arrange, and undo.
 */
import {
  Data,
  field,
  reference,
  type Id,
  type Mark,
  type Port,
  type Reference,
  type Row,
  type Snapshot,
  type Values,
} from 'latkit';
import { choice, page, toggle } from '../shell/page.js';

/** The block kinds: each one's marker fill and its ports, as name, side, and whether it drives. */
const KINDS = {
  Input: { fill: '#173836', ports: [['out', 'right', true]] },
  Process: {
    fill: '#1c2b3f',
    ports: [
      ['in', 'left', false],
      ['out', 'right', true],
    ],
  },
  Control: {
    fill: '#3a2e18',
    ports: [
      ['in', 'left', false],
      ['feedback', 'bottom', false],
      ['out', 'right', true],
    ],
  },
  Output: { fill: '#29243f', ports: [['in', 'left', false]] },
} as const;
type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];

/** A block: its kind, name, group, and the signal on each of its ports. */
interface Block {
  kind: Kind;
  name: string;
  group?: number;
  plugs: Record<string, number>;
}

/** Writes blocks, the signals that wire them, and the groups around them into a dataset. Blocks
 * have no position, so the layout places them. */
function sheet(blocks: Block[], signals: string[], groups: string[]): Data {
  const data = new Data('sheet').set('Group', { name: groups }).set('Signal', { name: signals });
  for (const kind of kinds) {
    const mine = blocks.filter((b) => b.kind === kind);
    const fields: Record<string, Values | Reference> = {
      name: mine.map((b) => b.name),
      x: mine.map(() => null),
      y: mine.map(() => null),
    };
    for (const [port] of KINDS[kind].ports)
      fields[port] = reference(
        'Signal',
        mine.map((b) => b.plugs[port] ?? null),
      );
    if (kind === 'Process')
      fields.group = reference(
        'Group',
        mine.map((b) => b.group ?? null),
      );
    data.set(kind, fields);
  }
  return data;
}

/** A control loop: a setpoint, a controller with feedback, and a plant of three stages. */
function loop(): Data {
  return sheet(
    [
      { kind: 'Input', name: 'Setpoint', plugs: { out: 0 } },
      { kind: 'Control', name: 'PID', plugs: { in: 0, feedback: 4, out: 1 } },
      { kind: 'Process', name: 'Actuator', group: 0, plugs: { in: 1, out: 2 } },
      { kind: 'Process', name: 'Plant', group: 0, plugs: { in: 2, out: 3 } },
      { kind: 'Process', name: 'Sensor', group: 0, plugs: { in: 3, out: 4 } },
      { kind: 'Output', name: 'Scope', plugs: { in: 3 } },
    ],
    ['setpoint', 'command', 'force', 'output', 'measured'],
    ['Plant'],
  );
}

/** Twenty lines of a production floor, each an input through five stages in its own group. */
function floor(): Data {
  const blocks: Block[] = [];
  const signals: string[] = [];
  const groups: string[] = [];
  for (let line = 0; line < 20; line++) {
    groups.push(`Line ${line + 1}`);
    let signal = signals.push(`feed ${line + 1}`) - 1;
    blocks.push({ kind: 'Input', name: `Feed ${line + 1}`, plugs: { out: signal } });
    for (let stage = 0; stage < 5; stage++) {
      const out = signals.push(`${line + 1}.${stage + 1}`) - 1;
      blocks.push({
        kind: 'Process',
        name: `Stage ${stage + 1}`,
        group: line,
        plugs: { in: signal, out },
      });
      signal = out;
    }
    blocks.push({ kind: 'Output', name: `Bin ${line + 1}`, plugs: { in: signal } });
  }
  return sheet(blocks, signals, groups);
}

export default page({
  title: 'Diagram',
  settings: {
    preset: choice('Diagram', { 'Control loop': 'loop', 'Production floor': 'floor' }),
    layout: choice('Layout', {
      'Left to right': 'right',
      'Top to bottom': 'down',
      Stress: 'stress',
    }),
    route: choice('Wires', { Orthogonal: 'orthogonal', Straight: 'straight' }),
    flow: toggle('Flow', { key: 'f' }),
  },

  async open({ settings, view, actions, detail }) {
    let data = settings.preset === 'loop' ? loop() : floor();
    const shown = await view((s) => ({
      space: { diagram: { grid: { dots: { pitch: 20 } } } },
      layout:
        s.layout === 'stress'
          ? { stress: { gap: 50 } }
          : { layered: { direction: s.layout, gap: 30, rankGap: 70 } },
      theme: { base: 'dark', background: '#101214', diagram: { outline: '#ffffff1f' } },
      controls: { connect: true, delete: true },
      marks: [
        {
          vertices: data.table('Group'),
          contains: [['Process', 'group']],
          label: { text: '$name', size: 11, color: '#7f93a8' },
          shadow: true,
        },
        {
          edges: data.table('Signal'),
          route: s.route,
          arrows: true,
          width: 1.5,
          dash: field('name').is('measured'),
          flow: s.flow ? 40 : 0,
        },
        ...kinds.map((kind): Mark => ({
          vertices: data.table(kind),
          position: ['$x', '$y'],
          marker: kind === 'Input' ? 'rounded' : 'block',
          color: KINDS[kind].fill,
          shadow: true,
          drag: true,
          label: { text: '$name', size: 12 },
          ports: KINDS[kind].ports.map(([name, side, output]): [string, Port] => [
            name,
            { side, output },
          ]),
        })),
      ],
    }));

    // Every edit can be undone. Each edit keeps the version before it, which shares pages with the
    // data, so the history costs only what changed.
    const undo: Snapshot[] = [];
    const redo: Snapshot[] = [];
    const edit = (change: () => void) => {
      undo.push(data.snapshot());
      redo.splice(0).forEach((s) => s.destroy());
      change();
    };
    const step = (from: Snapshot[], to: Snapshot[]) => {
      const back = from.pop();
      if (!back) return;
      to.push(data.snapshot());
      data.restore(back);
      back.destroy();
      count();
    };
    const count = () => {
      const tables = data.describe().tables;
      const rows = (names: string[]) =>
        tables.filter((t) => names.includes(t.name)).reduce((n, t) => n + t.rows, 0);
      detail(
        `${rows(kinds).toLocaleString()} blocks · ${rows(['Signal']).toLocaleString()} signals`,
      );
    };
    count();

    // A drag moves a block at once and is undone as one edit.
    let dragging = false;
    shown.on('drag', ({ phase, patch }) => {
      const move = () => patch && data.apply(patch);
      if (phase === 'start' && !dragging) {
        dragging = true;
        edit(move);
      } else move();
      if (phase === 'end') dragging = false;
    });

    // A wire joins an output to an input on the output's signal, making one if the output has none.
    shown.on('connect', ({ from, to }) => {
      if (!to || !(from.row.table in KINDS) || !(to.row.table in KINDS)) return;
      const port = (row: Row, drives: boolean, named?: string) =>
        KINDS[row.table as Kind].ports.find(
          ([name, , output]) => output === drives && (!named || name === named),
        )?.[0];
      const output = port(from.row, true, from.port) ? from : to;
      const input = output === from ? to : from;
      const out = port(output.row, true, output.port);
      const into = port(input.row, false, input.port);
      if (!out || !into) return;
      edit(() => {
        // A reference field reads as the id of the row it references.
        let signal = data.get(output.row.table, output.row.id, out) as Id | null;
        if (signal === null) {
          signal = Math.max(-1, ...data.query({ of: 'Signal', select: {} }).ids.map(Number)) + 1;
          data.set('Signal', [signal], { name: [`signal ${signal}`] });
          data.set(output.row.table, [output.row.id], { [out]: reference('Signal', [signal]) });
        }
        data.set(input.row.table, [input.row.id], { [into]: reference('Signal', [signal]) });
      });
      count();
    });
    shown.on('delete', ({ rows }) => {
      edit(() => rows.forEach(({ table, ids }) => data.remove(table, ids)));
      count();
    });

    actions('Edit', [
      { label: 'Undo', key: 'z', run: () => step(undo, redo) },
      { label: 'Redo', key: 'y', run: () => step(redo, undo) },
      {
        label: 'Arrange',
        key: 'a',
        // The layout places every block again and writes the places into its x and y fields.
        run: () => {
          void shown
            .arrange('all')
            .then((patches) => edit(() => patches.forEach((p) => data.apply(p))));
        },
      },
      { label: 'Fit', key: 'home', run: () => void shown.fit() },
    ]);

    return {
      change(s, key) {
        if (key !== 'preset') return;
        const old = data;
        data = s.preset === 'loop' ? loop() : floor();
        [...undo.splice(0), ...redo.splice(0)].forEach((snapshot) => snapshot.destroy());
        return () => {
          old.destroy();
          void shown.fit();
          count();
        };
      },
    };
  },
});
