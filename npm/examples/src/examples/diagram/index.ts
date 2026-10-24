/**
 * A block diagram on a sheet: blocks with ports, wires routed around them, and groups drawn around
 * their members. Add, drag, connect, arrange, and undo; open a preset or a JSON file; restyle the
 * sheet, its blocks, and its wires.
 */
import {
  Data,
  Patch,
  color,
  field,
  missing,
  reference,
  when,
  type Grid,
  type Id,
  type Layout,
  type Mark,
  type Port,
  type Row,
  type Rows,
  type Marker,
  type Scene,
  type Side,
} from '../../latkit.js';
import { h } from '../../ui/dom.js';
import { each, one } from '../../ui/rows.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/**
 * Kinds of block: the marker each draws as, its fill on the dark and the light sheet, and its ports,
 * each naming the signal it is plugged into.
 */
const KINDS = {
  Input: { marker: 'rounded', fill: ['#173836', '#e2f3ef'], ports: [['out', 'right', 'out']] },
  Process: {
    marker: 'block',
    fill: ['#1c2b3f', '#ffffff'],
    ports: [
      ['in', 'left', 'in'],
      ['out', 'right', 'out'],
    ],
  },
  Control: {
    marker: 'block',
    fill: ['#3a2e18', '#fbf0da'],
    ports: [
      ['in', 'left', 'in'],
      ['feedback', 'bottom', 'in'],
      ['out', 'right', 'out'],
    ],
  },
  Output: { marker: 'block', fill: ['#29243f', '#ece8fb'], ports: [['in', 'left', 'in']] },
} as const satisfies Record<
  string,
  {
    marker: Marker;
    fill: readonly [string, string];
    ports: readonly (readonly [string, Side, 'in' | 'out'])[];
  }
>;
type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];
/** Each kind as a shape of its own: inputs round, processes square, controls diamonds, outputs a
 * block with deeply rounded corners. */
const SHAPES = {
  Input: 'ellipse',
  Process: 'rectangle',
  Control: { shape: 'diamond' },
  Output: { block: { corner: 18 } },
} as const satisfies Record<Kind, Marker>;

/** A port of a block, by the reference field naming its signal. */
interface Plug {
  kind: Kind;
  id: Id;
  port: string;
}

const direction = (kind: Kind, port: string) =>
  KINDS[kind].ports.find(([name]) => name === port)?.[2];

/** A kind's ports as the scene declares them: outputs drive their signals, and a feedback port is
 * named. As dots, a plain input is its side alone; as diamonds, each port is ordered on its side. */
const ports = (kind: Kind, diamonds: boolean): [string, Port][] =>
  KINDS[kind].ports.map(([name, side, way], order): [string, Port] => [
    name,
    !diamonds && way === 'in' && name !== 'feedback'
      ? side
      : {
          side,
          output: way === 'out',
          ...(name === 'feedback' ? { label: 'feedback' } : {}),
          ...(diamonds ? { shape: 'diamond', order } : {}),
        },
  ]);

/**
 * A diagram drawn up as rows: blocks of each kind, the signals their ports plug into, and the groups
 * holding Process blocks, themselves held by stations. Positions, x right and y down, are optional:
 * blocks without one are placed by the layout.
 */
class Sketch {
  readonly blocks = new Map<
    Kind,
    { id: number; name: string; at?: [number, number]; group?: number }[]
  >();
  readonly plugs = new Map<string, number>();
  readonly signals: { id: number; name: string }[] = [];
  readonly groups: { id: number; name: string; station?: number }[] = [];
  readonly stations: { id: number; name: string }[] = [];
  /** Blocks whose status ring shows. */
  readonly alarms = new Set<number>();
  next = 1;

  block(kind: Kind, name: string, at?: [number, number], group?: number): Plug {
    const id = this.next++;
    const rows = this.blocks.get(kind) ?? [];
    rows.push({ id, name, at, group });
    this.blocks.set(kind, rows);
    return { kind, id, port: 'out' };
  }

  /** A signal driven by `from`'s output (or the port it names) and read by each of `to`'s inputs. */
  wire(name: string, from: Plug | Plug[], ...to: (Plug | [Plug, string])[]): void {
    const id = this.next++;
    this.signals.push({ id, name });
    for (const driver of [from].flat()) this.plugs.set(`${driver.kind} ${driver.id} out`, id);
    for (const reader of to) {
      const [plug, port] = Array.isArray(reader) ? reader : [reader, 'in'];
      this.plugs.set(`${plug.kind} ${plug.id} ${port}`, id);
    }
  }

  group(name: string, station?: number): number {
    const id = this.next++;
    this.groups.push({ id, name, station });
    return id;
  }

  station(name: string): number {
    const id = this.next++;
    this.stations.push({ id, name });
    return id;
  }

  /** The dataset. */
  data(): Data {
    const patch = new Patch().set(
      'Signal',
      this.signals.map((s) => s.id),
      { name: this.signals.map((s) => s.name) },
    );
    if (this.stations.length) {
      patch.set(
        'Station',
        this.stations.map((s) => s.id),
        { name: this.stations.map((s) => s.name) },
      );
    }
    if (this.groups.length) {
      const stations = this.groups.map((g) => g.station ?? null);
      patch.set(
        'Group',
        this.groups.map((g) => g.id),
        {
          name: this.groups.map((g) => g.name),
          ...(this.stations.length ? { station: reference('Station', stations) } : {}),
        },
      );
    }
    for (const [kind, rows] of this.blocks) {
      const plugged = Object.fromEntries(
        KINDS[kind].ports.map(([port]) => [
          port,
          reference(
            'Signal',
            rows.map((row) => this.plugs.get(`${kind} ${row.id} ${port}`) ?? null),
          ),
        ]),
      );
      const grouped = kind === 'Process' && this.groups.length;
      patch.set(
        kind,
        rows.map((row) => row.id),
        {
          name: rows.map((row) => row.name),
          x: rows.map((row) => row.at?.[0] ?? null),
          y: rows.map((row) => row.at?.[1] ?? null),
          status: rows.map((row) => (this.alarms.has(row.id) ? 1 : 0)),
          ...plugged,
          ...(grouped
            ? {
                group: reference(
                  'Group',
                  rows.map((row) => row.group ?? null),
                ),
              }
            : {}),
        },
      );
    }
    return new Data('studio').apply(patch);
  }
}

/** The surfaces groups may take, on the dark and the light sheet. */
const SURFACES = {
  slate: ['#1a2230', '#e6ebf2'],
  teal: ['#14302f', '#dcefec'],
  plum: ['#2a1f33', '#efe6f4'],
} as const;

/** A pipeline written as a JSON document, as `Data.load` reads one: a change per method, with its
 * parameters by name. */
const PIPELINE = {
  name: 'studio',
  patch: [
    { set: { table: 'Signal', ids: [10, 11, 12], fields: { name: ['Raw', 'Cleaned', 'Report'] } } },
    {
      set: {
        table: 'Input',
        ids: [1],
        fields: {
          name: ['Sensor feed'],
          x: [0],
          y: [0],
          status: [0],
          out: { reference: 'Signal', ids: [10] },
        },
      },
    },
    {
      set: {
        table: 'Process',
        ids: [2],
        fields: {
          name: ['Filter'],
          x: [260],
          y: [0],
          status: [0],
          in: { reference: 'Signal', ids: [10] },
          out: { reference: 'Signal', ids: [11] },
        },
      },
    },
    {
      set: {
        table: 'Output',
        ids: [3],
        fields: {
          name: ['Dashboard'],
          x: [520],
          y: [0],
          status: [0],
          in: { reference: 'Signal', ids: [11] },
        },
      },
    },
  ],
};

/** The presets: a water plant laid out in ranks, then four drawn where they stand, and one written
 * as a JSON document. */
const PRESETS: readonly (readonly [string, () => Data | Promise<Data>])[] = [
  [
    'Water plant',
    () => {
      const s = new Sketch();
      const [intake, treatment, output] = ['Intake', 'Treatment', 'Output'].map((name) =>
        s.group(name),
      );
      const wellA = s.block('Input', 'Well A');
      const wellB = s.block('Input', 'Well B');
      const screen = s.block('Process', 'Screen', undefined, intake);
      const dosing = s.block('Input', 'Dosing');
      const mixer = s.block('Process', 'Mixer', undefined, treatment);
      const clarifier = s.block('Process', 'Clarifier', undefined, treatment);
      const filters = [1, 2].map((n) => s.block('Process', `Filter ${n}`, undefined, treatment));
      const tank = s.block('Process', 'Tank', undefined, output);
      const pump = s.block('Process', 'Pump', undefined, output);
      const main = s.block('Output', 'Main');
      s.wire('Raw water', [wellA, wellB], screen);
      s.wire('To mixer', [screen, dosing], mixer);
      s.wire('Mixed', mixer, clarifier);
      s.wire('Clarified', clarifier, ...filters);
      s.wire('Filtered', filters, tank);
      s.wire('Stored', tank, pump);
      s.wire('Pumped', pump, main);
      return s.data();
    },
  ],
  [
    'Control loop',
    () => {
      const s = new Sketch();
      const reference = s.block('Input', 'Reference', [0, 0]);
      const controller = s.block('Control', 'Controller', [240, 0]);
      const actuator = s.block('Process', 'Actuator', [500, 0]);
      const plant = s.block('Process', 'Plant', [500, 240]);
      const sensor = s.block('Process', 'Sensor', [240, 240]);
      const response = s.block('Output', 'Response', [740, 240]);
      s.wire('Set point', reference, controller);
      s.wire('Command', controller, actuator);
      s.wire('Drive', actuator, plant);
      s.wire('Measured', plant, response, sensor);
      s.wire('Feedback', sensor, [controller, 'feedback']);
      s.alarms.add(plant.id as number);
      return s.data();
    },
  ],
  [
    'Nested groups',
    () => {
      const s = new Sketch();
      const station = s.station('Generating station');
      const dispatch = s.block('Input', 'Dispatch', [0, 210]);
      const plants: Plug[] = [];
      const controls: Plug[] = [];
      for (let i = 0; i < 3; i++) {
        const unit = s.group(`Unit ${i + 1}`, station);
        controls.push(s.block('Process', `Controller ${i + 1}`, [320, i * 210], unit));
        plants.push(s.block('Process', `Plant ${i + 1}`, [620, i * 210], unit));
        s.wire(`Drive ${i + 1}`, controls[i]!, plants[i]!);
      }
      const meter = s.block('Output', 'Metering', [950, 210]);
      s.wire('Dispatch', dispatch, ...controls);
      // The meter reads one signal, so the plants share it.
      s.wire('Power', plants, meter);
      return s.data();
    },
  ],
  [
    'Shape atlas',
    () => {
      const s = new Sketch();
      const input = s.block('Input', 'Input', [0, 0]);
      const process = s.block('Process', 'Process', [300, 0]);
      const decision = s.block('Control', 'Decision', [300, 250]);
      const result = s.block('Output', 'Result', [640, 250]);
      s.wire('Source', input, process);
      s.wire('Evaluate', process, decision);
      s.wire('Accept', decision, result);
      return s.data();
    },
  ],
  [
    'Scale study: 1,024 blocks',
    () => {
      const s = new Sketch();
      let before: Plug | undefined;
      for (let row = 0; row < 32; row++) {
        for (let col = 0; col < 32; col++) {
          const block = s.block('Process', `Block ${row * 32 + col + 1}`, [col * 240, row * 150]);
          if (col && before) s.wire('', before, block);
          before = block;
        }
      }
      return s.data();
    },
  ],
  ['Written as JSON', () => Data.load(JSON.stringify(PIPELINE))],
];

/**
 * Earlier versions of the data, to step back to and forward again: snapshots, each held here or
 * live, never both, and freed once forgotten.
 */
class History {
  readonly #undo: Data[] = [];
  #redo: Data[] = [];

  /** Remembers `before`, a snapshot of the version an edit started from. */
  commit(before: Data): void {
    this.#undo.push(before);
    if (this.#undo.length > 100) this.#undo.shift()!.destroy();
    for (const after of this.#redo) after.destroy();
    this.#redo = [];
  }

  /** The version before `current`, which redo then steps forward to. */
  undo(current: Data): Data | undefined {
    const before = this.#undo.pop();
    if (before) this.#redo.push(current);
    return before;
  }

  redo(current: Data): Data | undefined {
    const after = this.#redo.pop();
    if (after) this.#undo.push(current);
    return after;
  }

  clear(): void {
    for (const version of [...this.#undo, ...this.#redo]) version.destroy();
    this.#undo.length = 0;
    this.#redo = [];
  }
}

export default function page(stage: Stage): void {
  let preset = PRESETS[0]!;
  let data = new Data('studio');
  let layout: Layout = { layered: { flow: 'right', gap: 30, rankGap: 80 } };
  let route: 'orthogonal' | 'straight' = 'orthogonal';
  let comets = false;
  type Sheet = 'dots' | 'snap' | 'lines' | 'off';
  let grid: Sheet = 'dots';
  let light = false;
  /** How the sheet, its blocks, ports, and wires look, and how the view answers keys and presses. */
  const style = {
    shapes: false,
    diamonds: false,
    names: false,
    shadows: true,
    corner: 6,
    outline: true,
    portSize: 7,
    bend: 6,
    groupPadding: 16,
    edgeSpacing: 4,
    arrow: 7,
    lift: 3,
    fontSize: 12,
    dash: 6,
    groups: 'slate' as keyof typeof SURFACES,
    keyboard: true,
    cycle: false,
    press: 0.5,
  };
  const history = new History();
  const GRIDS: Record<Sheet, Grid> = {
    dots: { dots: { pitch: 20 } },
    snap: { dots: { pitch: 20, snap: true } },
    lines: { lines: { pitch: 20 } },
    off: 'off',
  };

  const scene = (): Scene => {
    const marks: Mark[] = [];
    // Containers take the theme's surface, tinted by how deep they sit; their titles head them, and
    // they and the blocks they hold lift off the sheet.
    const title = { text: 'name', size: 11, color: light ? '#5b6b7d' : '#7f93a8' };
    if (data.tables.includes('Station')) {
      marks.push({
        vertices: {
          of: ['studio', 'Station'],
          contains: ['Group', 'station'],
          label: title,
          shadow: style.shadows,
        },
      });
    }
    if (data.tables.includes('Group')) {
      marks.push({
        vertices: {
          of: ['studio', 'Group'],
          contains: ['Process', 'group'],
          label: title,
          shadow: style.shadows,
        },
      });
    }
    // Comets run from each signal's driver to its readers; a feedback signal is dashed.
    marks.push({
      edges: {
        of: ['studio', 'Signal'],
        route,
        arrows: true,
        width: 1.5,
        dash: field('name').is('Feedback'),
        ...(comets ? { flow: 40 } : {}),
        ...(style.names
          ? { label: { text: 'name', size: 10, color: light ? '#5b6b7d' : '#7f93a8' } }
          : {}),
      },
    });
    // A mark for each kind of block the data holds; a table the data lacks would fail.
    for (const kind of kinds.filter((k) => data.tables.includes(k))) {
      // Without a size, a block fits its label and ports.
      marks.push({
        vertices: {
          of: ['studio', kind],
          position: ['x', 'y'],
          marker: style.shapes ? SHAPES[kind] : KINDS[kind].marker,
          color: KINDS[kind].fill[light ? 1 : 0],
          shadow: style.shadows,
          ring: when(field('status').gt(0)).then(color('#ff8c42')).otherwise(missing()),
          ports: ports(kind, style.diamonds),
          drag: true,
          label: { text: 'name', size: 12 },
        },
      });
    }
    return {
      space: { diagram: { grid: GRIDS[grid] } },
      layout,
      theme: {
        ...(light ? { base: 'light', background: '#f4f6f9' } : theme),
        corner: style.corner,
        outline: style.outline ? (light ? '#00000024' : '#ffffff1f') : null,
        portSize: style.portSize,
        bend: style.bend,
        groupPadding: style.groupPadding,
        edgeSpacing: style.edgeSpacing,
        arrow: style.arrow,
        fontSize: style.fontSize,
        dash: style.dash,
        shadow: { color: light ? '#00000038' : '#00000073', lift: style.lift },
        // Groups take the theme's surface.
        surface: SURFACES[style.groups][light ? 1 : 0],
      },
      controls: {
        connect: true,
        delete: true,
        selectBox: true,
        keyboard: style.keyboard,
        cycle: style.cycle,
        press: style.press,
      },
      marks,
    };
  };
  /** An id no row of the data has yet. */
  const fresh = () =>
    1 + Math.max(0, ...data.tables.flatMap((t) => data.ids(t).map((id) => Number(id) || 0)));
  const view = stage.view(scene(), {
    label: 'A diagram: drag blocks, drag from a port to wire it, Delete removes',
  });

  /** Shows the current version: `next`, or the data as it is now, and a mark for each kind it holds. */
  let kindsShown = data.tables.join();
  const show = (next = data) => {
    data = next;
    view.setData(data);
    if (data.tables.join() !== kindsShown) {
      kindsShown = data.tables.join();
      view.show(scene());
    }
    describe();
  };
  /** Applies `patch` as one edit that undo steps back over. */
  const edit = (patch: Patch, said: string) => {
    history.commit(data.snapshot());
    show(data.apply(patch));
    note(said);
  };
  /** Shows `next`, a diagram of its own: nothing to undo back to. */
  const open = (next: Data, said: string) => {
    history.clear();
    data.destroy();
    data = next;
    view.show(scene());
    show(next);
    view.fit();
    note(said);
    const blocks = kinds.reduce(
      (n, kind) => n + (data.tables.includes(kind) ? data.ids(kind).length : 0),
      0,
    );
    stage.detail(
      `${blocks.toLocaleString()} blocks · ${data.ids('Signal').length.toLocaleString()} signals`,
    );
  };
  const load = async (choice: (typeof PRESETS)[number]) => {
    preset = choice;
    open(await choice[1](), 'Drag blocks or connect ports.');
  };

  const name = (row: Row) =>
    (data.get(row.table, row.id, 'name') as string | null) ?? `${row.table} ${row.id}`;
  const isBlock = (table: string): table is Kind => table in KINDS;

  // Moving: a block goes where the drag says, moves at once, and lands as one edit.
  let before: Data | undefined;
  view.on('drag', ({ phase, hit, position }) => {
    if (!isBlock(hit.row.table)) return;
    if (phase === 'start') {
      before = data.snapshot();
      return;
    }
    const at = new Patch().set(hit.row.table, [hit.row.id as number], {
      x: [position[0]],
      y: [position[1]],
    });
    if (phase === 'end') {
      if (before) history.commit(before);
      before = undefined;
      show(data.apply(at));
      note(`Moved ${name(hit.row)}.`);
    } else show(data.apply(at));
  });

  // Wiring: an output and an input join on the output's signal, made when it has none; an input
  // wired elsewhere leaves the signal it was on. A plugged port let go over nothing is unplugged.
  view.on('connect', ({ from, to }) => {
    if (!to) {
      const plugged =
        isBlock(from.row.table) && from.port && data.get(from.row.table, from.row.id, from.port);
      if (!plugged) return note('Let go over nothing.');
      const patch = new Patch().set(from.row.table, [from.row.id as number], {
        [from.port!]: reference('Signal', [null]),
      });
      return edit(patch, `Unplugged ${name(from.row)}'s ${from.port}.`);
    }
    if (!isBlock(from.row.table) || !isBlock(to.row.table)) return note('Wire blocks to blocks.');
    const a: Plug = { kind: from.row.table, id: from.row.id, port: from.port ?? 'out' };
    if (!direction(a.kind, a.port)) a.port = KINDS[a.kind].ports[0]![0];
    const wants = direction(a.kind, a.port) === 'out' ? 'in' : 'out';
    const port = to.port ?? KINDS[to.row.table].ports.find(([, , d]) => d === wants)?.[0];
    if (!port) return note(`${name(to.row)} has no ${wants === 'in' ? 'input' : 'output'}.`);
    const b: Plug = { kind: to.row.table, id: to.row.id, port };
    if (direction(b.kind, b.port) !== wants) return note('Wire an output to an input.');
    const [driver, reader] = wants === 'in' ? [a, b] : [b, a];
    const plugged = data.get(driver.kind, driver.id, driver.port) as Row | null;
    const patch = new Patch();
    let signal = plugged?.id;
    if (signal === undefined) {
      signal = fresh();
      patch.set('Signal', [signal], { name: [`Signal ${signal}`] });
      patch.set(driver.kind, [driver.id as number], {
        [driver.port]: reference('Signal', [signal as number]),
      });
    }
    patch.set(reader.kind, [reader.id as number], {
      [reader.port]: reference('Signal', [signal as number]),
    });
    edit(patch, `Wired ${name(from.row)} and ${name(to.row)}.`);
  });

  /** Removes `rows` as one edit. */
  const remove = (rows: readonly Rows[]) => {
    const patch = new Patch();
    for (const { table, ids } of rows) patch.remove(table, ids);
    edit(patch, `Removed ${each(rows).map(name).join(', ')}.`);
  };
  view.on('delete', ({ rows }) => remove(rows));

  /** Selects `row` and what it joins, and frames them. */
  const reveal = (row: Row) => {
    const joined = view.neighbors(row);
    const near = [one(row), ...joined];
    view.select(near);
    view.fit({ rows: near });
    describe();
    note(`${name(row)} and ${each(joined).length} joined to it.`);
  };
  /** Selects `row` and puts its name up for editing. */
  const rename = (row: Row) => {
    view.select([one(row)]);
    describe();
    input.focus();
    input.select();
  };
  const named = (row: Row) =>
    isBlock(row.table) || row.table === 'Group' || row.table === 'Station';

  // Opening a row renames it; the menu names what can be done with the row under it.
  view.on('open', ({ hit }) => named(hit.row) && rename(hit.row));
  const menu = stage.menu();
  view.on('menu', ({ hits, trigger }) => {
    const row = hits[0]?.row;
    if (row && !view.selection.some((s) => s.table === row.table && s.ids.includes(row.id)))
      view.select([one(row)]);
    describe();
    const rows = view.selection;
    const count = each(rows).length;
    menu.open(view, trigger.point, [
      { label: 'Rename', run: () => row && rename(row), disabled: !row || !named(row) },
      { label: 'Reveal neighbors', run: () => row && reveal(row), disabled: !row },
      {
        label: count > 1 ? `Delete ${count} rows` : 'Delete',
        run: () => remove(rows),
        disabled: !count,
      },
      { label: 'Fit everything', run: () => view.fit() },
    ]);
  });

  const studio = stage.section('Diagram');
  studio.choice(
    'Preset',
    PRESETS.map((p) => [p[0], p] as const),
    preset,
    (choice) => void load(choice).catch(stage.fail),
  );
  studio.actions([
    {
      label: 'Undo',
      key: 'z',
      run: () => {
        const before = history.undo(data);
        if (!before) return;
        show(before);
        note('Undone.');
      },
    },
    {
      label: 'Redo',
      key: 'y',
      run: () => {
        const after = history.redo(data);
        if (!after) return;
        show(after);
        note('Redone.');
      },
    },
    {
      label: 'Arrange',
      key: 'a',
      // Every block lets go of its position, the layout places them all again, and the places it
      // answers become the blocks' positions: one edit undo steps back over.
      run: () => {
        const patch = Patch.to(data.name);
        for (const kind of kinds.filter((k) => data.tables.includes(k))) {
          const ids = data.ids(kind);
          if (ids.length) patch.set(kind, ids, { x: ids.map(() => null), y: ids.map(() => null) });
        }
        history.commit(data.snapshot());
        show(data.apply(patch));
        view.fit();
        void view.arrange().then((patches) => {
          // The places of every table, written as one change.
          const placed = patches
            .filter((p) => p.data === data.name)
            .reduce((all, p) => all.extend(p), Patch.to(data.name));
          show(data.apply(placed));
          note('Arranged.');
        });
      },
    },
    { label: 'Fit', key: 'f', run: () => view.fit() },
    { label: 'Zoom in', key: '=', run: () => zoom(0.5) },
    { label: 'Zoom out', key: '-', run: () => zoom(-0.5) },
  ]);
  /** Eases the camera in by `by` steps of doubling. */
  const zoom = (by: number) => {
    const camera = view.camera;
    if ('center' in camera) view.fly({ ...camera, zoom: camera.zoom + by });
  };
  const add = stage.section('Add');
  add.actions(
    kinds.map((kind, i) => ({
      label: kind,
      key: String(i + 1),
      run: () => {
        // New blocks land where the camera looks; nothing else moves.
        const camera = view.camera;
        const [x, y] = 'center' in camera ? camera.center : [0, 0];
        const id = fresh();
        const plugged = Object.fromEntries(
          KINDS[kind].ports.map(([port]) => [port, reference('Signal', [null])]),
        );
        edit(
          new Patch().set(kind, [id], {
            name: [`New ${kind.toLowerCase()}`],
            x: [x],
            y: [y],
            status: [0],
            ...plugged,
          }),
          `Added a ${kind.toLowerCase()} block.`,
        );
      },
    })),
  );

  const look = stage.section('Display');
  const layouts: readonly (readonly [string, Layout])[] = [
    ['Left to right', layout],
    ['Top to bottom', { layered: { flow: 'down', gap: 30, rankGap: 60 } }],
    ['Right to left', { layered: { flow: 'left', gap: 30, rankGap: 80 } }],
    ['Bottom to top', { layered: { flow: 'up', gap: 30, rankGap: 60 } }],
    ['Force layout', { stress: { gap: 140 } }],
  ];
  look.choice('Layout', layouts, layout, (next) => {
    layout = next;
    view.show(scene());
    view.fit();
  });
  look.choice(
    'Routing',
    [
      ['Around blocks', 'orthogonal'],
      ['Straight', 'straight'],
    ] as const,
    route,
    (next) => {
      route = next;
      view.show(scene());
    },
  );
  look.toggle('Flow', 'c', comets, (on) => {
    comets = on;
    view.show(scene());
  });
  look.toggle('Light', 'l', light, (on) => {
    light = on;
    view.show(scene());
  });
  const restyle = () => view.show(scene());
  look.toggle('Shapes', 'h', style.shapes, (on) => ((style.shapes = on), restyle()));
  look.toggle(
    'Diamond ports',
    undefined,
    style.diamonds,
    (on) => ((style.diamonds = on), restyle()),
  );
  look.toggle('Signal names', undefined, style.names, (on) => ((style.names = on), restyle()));
  look.choice(
    'Grid',
    [
      ['Dots', 'dots'],
      ['Dots that snap', 'snap'],
      ['Lines', 'lines'],
      ['Off', 'off'],
    ] as const,
    grid,
    (next) => ((grid = next), restyle()),
  );

  // The sheet's theme: how blocks, groups, ports, wires, and shadows look.
  const sheet = stage.section('Sheet', false);
  const knob = (
    label: string,
    name:
      | 'corner'
      | 'portSize'
      | 'bend'
      | 'groupPadding'
      | 'edgeSpacing'
      | 'arrow'
      | 'lift'
      | 'fontSize'
      | 'dash',
    min: number,
    max: number,
    step = 1,
  ) =>
    sheet.range(
      label,
      { min, max, step, value: style[name], format: (v) => `${v} units` },
      (value) => {
        style[name] = value;
        restyle();
      },
    );
  knob('Corners', 'corner', 0, 16);
  knob('Ports', 'portSize', 4, 14);
  knob('Wire bends', 'bend', 0, 16);
  knob('Group padding', 'groupPadding', 6, 32, 2);
  knob('Wire spacing', 'edgeSpacing', 2, 12);
  knob('Arrowheads', 'arrow', 3, 14);
  knob('Text', 'fontSize', 9, 16);
  knob('Dashes', 'dash', 2, 14);
  knob('Shadow lift', 'lift', 0, 10);
  sheet.choice(
    'Groups',
    [
      ['Slate', 'slate'],
      ['Teal', 'teal'],
      ['Plum', 'plum'],
    ] as const,
    style.groups,
    (groups) => ((style.groups = groups), restyle()),
  );
  sheet.toggle('Shadows', undefined, style.shadows, (on) => ((style.shadows = on), restyle()));
  sheet.toggle('Outlines', undefined, style.outline, (on) => ((style.outline = on), restyle()));

  // How the view answers keys and presses.
  const answers = stage.section('Interaction', false);
  answers.toggle('Keys', undefined, style.keyboard, (on) => ((style.keyboard = on), restyle()));
  answers.toggle('Cycle picks', undefined, style.cycle, (on) => ((style.cycle = on), restyle()));
  answers.choice(
    'Long press',
    [
      ['Half a second', 0.5],
      ['A second', 1],
      ['Never', 0],
    ] as const,
    style.press,
    (press) => ((style.press = press), restyle()),
  );
  answers.note('Keys: Tab steps through blocks, Enter renames, Space selects, Delete removes.');

  // The diagram as a file: latkit's bytes, the patch that builds it, read back as they were.
  const file = stage.section('File', false);
  const picker = h('input', { type: 'file', accept: '.latk', hidden: true });
  file.content.append(picker);
  picker.addEventListener(
    'change',
    () => {
      const chosen = picker.files?.[0];
      picker.value = '';
      if (!chosen) return;
      void chosen
        .arrayBuffer()
        .then((bytes) => Data.read(new Uint8Array(bytes), 'studio'))
        .then((read) => open(read, `Opened ${chosen.name}.`))
        .catch((error: unknown) => note(`Could not open ${chosen.name}: ${String(error)}`));
    },
    { signal: stage.signal },
  );
  file.actions([
    {
      label: 'Save',
      key: 's',
      run: () => {
        const url = URL.createObjectURL(
          new Blob([data.toBytes().slice()], { type: 'application/octet-stream' }),
        );
        h('a', { href: url, download: 'diagram.latk' }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        note('Saved diagram.latk.');
      },
    },
    { label: 'Open', key: 'o', run: () => picker.click() },
  ]);
  const described = file.note();

  // The selected block's name, editable.
  const selected = stage.section('Selection');
  const input = selected.text('Name', (value) => {
    const [row] = each(view.selection);
    if (row)
      edit(
        new Patch().set(row.table, [row.id as number], { name: [value] }),
        `Renamed to ${value}.`,
      );
  });
  input.placeholder = 'Select a block';
  input.disabled = true;
  const told = selected.note();
  const note = (text: string) => (told.textContent = text);
  // The selected block wears a tag where the view located it; it goes when the camera moves.
  const tag = h('p', { class: 'callout', hidden: true });
  stage.regions.main.append(tag);
  view.on('camera', () => (tag.hidden = true));
  const describe = () => {
    const [row] = each(view.selection);
    const editable = !!row && named(row);
    input.disabled = !editable;
    input.value = editable ? name(row) : '';
    tag.hidden = true;
    if (row && isBlock(row.table))
      void view.locate(row).then((point) => {
        if (!point || each(view.selection)[0]?.id !== row.id) return;
        tag.textContent = `${row.table} · ${name(row)}`;
        tag.style.translate = `${point[0]}px ${point[1] - 18}px`;
        tag.hidden = false;
      });
    // What the data holds, as it describes itself.
    described.textContent = data
      .describe()
      .tables.map((t) => `${t.name} ${t.rows.toLocaleString()}`)
      .join(' · ');
  };
  view.on('select', describe);

  stage.meter(view);
  void load(preset).catch(stage.fail);
}
