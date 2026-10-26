/**
 * A block diagram on a sheet: blocks with ports, wires routed around them, and groups drawn around
 * their members. You can add, drag, connect, arrange, and undo, open a preset or a saved `.latk`
 * file, and restyle the sheet, its blocks, and its wires.
 */
import {
  Data,
  Snapshot,
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
} from 'latkit';
import { h } from '../../ui/dom.js';
import { each, one } from '../../ui/rows.js';
import type { Stage } from '../../ui/stage.js';
import { theme } from '../../ui/theme.js';

/**
 * The block kinds. Each has a marker, a fill for the dark and the light sheet, and ports given as
 * name, side, and direction. Each port is a reference field naming the signal plugged into it.
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
/** A distinct shape per kind, used when Shapes is on: inputs are ellipses, processes rectangles,
 * controls diamonds, and outputs blocks with deeply rounded corners. */
const SHAPES = {
  Input: 'ellipse',
  Process: 'rectangle',
  Control: { shape: 'diamond' },
  Output: { block: { corner: 18 } },
} as const satisfies Record<Kind, Marker>;

/** A block's port. `port` names the reference field that holds the port's signal. */
interface Plug {
  kind: Kind;
  id: Id;
  port: string;
}

const direction = (kind: Kind, port: string) =>
  KINDS[kind].ports.find(([name]) => name === port)?.[2];

/** Declares a kind's ports for the scene. Outputs drive their signals, and the feedback port gets
 * a label. With dot ports, a plain input is declared by its side alone. With diamond ports, every
 * port also gets a shape and an order on its side. */
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
 * Builds a diagram's rows: blocks of each kind, the signals their ports plug into, groups of
 * Process blocks, and stations that contain groups. Positions (x right, y down) are optional. The
 * layout places blocks without one.
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
  /** Blocks whose status ring is shown. */
  readonly alarms = new Set<number>();
  next = 1;

  block(kind: Kind, name: string, at?: [number, number], group?: number): Plug {
    const id = this.next++;
    const rows = this.blocks.get(kind) ?? [];
    rows.push({ id, name, at, group });
    this.blocks.set(kind, rows);
    return { kind, id, port: 'out' };
  }

  /** Adds a signal driven by the `out` port of each block in `from` and read by each of `to`, on
   * its `in` port or on the port paired with it. */
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

  /** Builds the dataset from the rows. */
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

/** Group colors, for the dark and the light sheet. */
const GROUP_COLORS = {
  slate: ['#1a2230', '#e6ebf2'],
  teal: ['#14302f', '#dcefec'],
  plum: ['#2a1f33', '#efe6f4'],
} as const;

/** A small pipeline written as a JSON document for `Data.read`. Each change is an object keyed by
 * its method, with the method's parameters by name. */
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

/** The presets: a water plant placed in ranks by the layout, four with fixed positions, and one
 * written as a JSON document. */
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
  ['Written as JSON', () => Data.read(PIPELINE)],
];

/**
 * Undo and redo history, kept as snapshots of the data. It keeps up to 100 undo steps and destroys
 * each snapshot once it can no longer be restored.
 */
class History {
  readonly #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];

  /** Records `before`, a snapshot taken before an edit, and clears the redo steps. */
  commit(before: Snapshot): void {
    this.#undo.push(before);
    if (this.#undo.length > 100) this.#undo.shift()!.destroy();
    for (const after of this.#redo) after.destroy();
    this.#redo = [];
  }

  /** Returns the snapshot before `current` and keeps `current` for redo. When there is nothing to
   * undo, it destroys `current` and returns undefined. */
  undo(current: Snapshot): Snapshot | undefined {
    const before = this.#undo.pop();
    if (before) this.#redo.push(current);
    else current.destroy();
    return before;
  }

  redo(current: Snapshot): Snapshot | undefined {
    const after = this.#redo.pop();
    if (after) this.#undo.push(current);
    else current.destroy();
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
  /** Settings for how the sheet, blocks, ports, and wires look, and how the view responds to keys
   * and presses. */
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
    wireSpacing: 4,
    arrow: 7,
    lift: 3,
    textSize: 12,
    dash: 6,
    groups: 'slate' as keyof typeof GROUP_COLORS,
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

  /** The names of the tables the data has now. */
  const held = () => new Set(data.describe().tables.map((t) => t.name));
  /** Every id of `table`. */
  const ids = (table: string) => data.query({ of: table, select: {} }).ids;

  const scene = (): Scene => {
    const tables = held();
    const marks: Mark[] = [];
    // Containers take the theme's group color, tinted by nesting depth. Their titles sit at the
    // top, and they and the blocks inside them cast shadows on the sheet.
    const title = { text: 'name', size: 11, color: light ? '#5b6b7d' : '#7f93a8' };
    if (tables.has('Station')) {
      marks.push({
        vertices: {
          of: ['studio', 'Station'],
          contains: ['Group', 'station'],
          label: title,
          shadow: style.shadows,
        },
      });
    }
    if (tables.has('Group')) {
      marks.push({
        vertices: {
          of: ['studio', 'Group'],
          contains: ['Process', 'group'],
          label: title,
          shadow: style.shadows,
        },
      });
    }
    // With Flow on, comets run from each signal's driver to its readers. A signal named Feedback
    // is dashed.
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
    // One mark per block kind in the data. A mark of a table the data lacks would fail.
    for (const kind of kinds.filter((k) => tables.has(k))) {
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
        dash: style.dash,
        text: { size: style.textSize },
        edge: { spacing: style.wireSpacing, arrow: style.arrow },
        diagram: {
          corner: style.corner,
          outline: style.outline ? (light ? '#00000024' : '#ffffff1f') : null,
          portSize: style.portSize,
          bend: style.bend,
          groupPadding: style.groupPadding,
          group: GROUP_COLORS[style.groups][light ? 1 : 0],
          shadow: { color: light ? '#00000038' : '#00000073', lift: style.lift },
        },
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
  /** An id that no row in the data uses yet. */
  const fresh = () =>
    1 + Math.max(0, ...[...held()].flatMap((t) => ids(t).map((id) => Number(id) || 0)));
  const view = stage.view(scene(), {
    label: 'A diagram: drag blocks, drag from a port to wire it, Delete removes',
  });

  /** Refreshes after a data change. The scene is rebuilt only if the set of tables changed, so each
   * block kind in the data has a mark. The description is always updated. */
  let kindsShown = [...held()].join();
  const changed = () => {
    const kindsHeld = [...held()].join();
    if (kindsHeld !== kindsShown) {
      kindsShown = kindsHeld;
      view.scene = scene();
    }
    describe();
  };
  /** Applies `patch` as one undoable edit and shows `said`. */
  const edit = (patch: Patch, said: string) => {
    history.commit(data.snapshot());
    data.apply(patch);
    changed();
    note(said);
  };
  /** Replaces the diagram with `next`, clears the undo history, and fits the view to it. */
  const open = (next: Data, said: string) => {
    history.clear();
    data.destroy();
    data = next;
    view.sources = [data];
    kindsShown = [...held()].join();
    view.scene = scene();
    changed();
    view.fit();
    note(said);
    const tables = held();
    const blocks = kinds.reduce((n, kind) => n + (tables.has(kind) ? ids(kind).length : 0), 0);
    stage.detail(
      `${blocks.toLocaleString()} blocks · ${ids('Signal').length.toLocaleString()} signals`,
    );
  };
  const load = async (choice: (typeof PRESETS)[number]) => {
    preset = choice;
    open(await choice[1](), 'Drag blocks or connect ports.');
  };

  const name = (row: Row) =>
    (data.get(row.table, row.id, 'name') as string | null) ?? `${row.table} ${row.id}`;
  const isBlock = (table: string): table is Kind => table in KINDS;

  // Dragging moves a block immediately, and the whole drag is recorded as one undoable edit.
  let before: Snapshot | undefined;
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
    data.apply(at);
    changed();
    if (phase === 'end') {
      if (before) history.commit(before);
      before = undefined;
      note(`Moved ${name(hit.row)}.`);
    }
  });

  // Wiring joins an output and an input on the output's signal, creating the signal if the output
  // has none. An input wired elsewhere leaves its old signal. Dropping a plugged port over empty
  // space unplugs it.
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

  /** Removes `rows` as one undoable edit. */
  const remove = (rows: readonly Rows[]) => {
    const patch = new Patch();
    for (const { table, ids } of rows) patch.remove(table, ids);
    edit(patch, `Removed ${each(rows).map(name).join(', ')}.`);
  };
  view.on('delete', ({ rows }) => remove(rows));

  /** Selects `row` and its neighbors, and fits the view to them. */
  const reveal = (row: Row) => {
    const joined = view.neighbors(row);
    const near = [one(row), ...joined];
    view.selection = near;
    view.fit({ rows: near });
    describe();
    note(`${name(row)} and ${each(joined).length} joined to it.`);
  };
  /** Selects `row` and focuses its name for editing. */
  const rename = (row: Row) => {
    view.selection = [one(row)];
    describe();
    input.focus();
    input.select();
  };
  const named = (row: Row) =>
    isBlock(row.table) || row.table === 'Group' || row.table === 'Station';

  // Opening a row renames it. The context menu lists actions for the row under the pointer.
  view.on('open', ({ hit }) => named(hit.row) && rename(hit.row));
  const menu = stage.menu();
  view.on('menu', ({ hits, trigger }) => {
    const row = hits[0]?.row;
    if (row && !view.selection.some((s) => s.table === row.table && s.ids.includes(row.id)))
      view.selection = [one(row)];
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
        const before = history.undo(data.snapshot());
        if (!before) return;
        data.restore(before);
        changed();
        note('Undone.');
      },
    },
    {
      label: 'Redo',
      key: 'y',
      run: () => {
        const after = history.redo(data.snapshot());
        if (!after) return;
        data.restore(after);
        changed();
        note('Redone.');
      },
    },
    {
      label: 'Arrange',
      key: 'a',
      // Clears every block's position so the layout places them all again, then writes the
      // computed places back as positions. One undo reverts the whole arrangement.
      run: () => {
        const patch = new Patch(data.name);
        const tables = held();
        for (const kind of kinds.filter((k) => tables.has(k))) {
          const rows = ids(kind);
          if (rows.length)
            patch.set(kind, rows, { x: rows.map(() => null), y: rows.map(() => null) });
        }
        history.commit(data.snapshot());
        data.apply(patch);
        changed();
        view.fit();
        void view.arrange().then((patches) => {
          // Merges the computed places of every table into one patch.
          const placed = patches
            .filter((p) => p.data === data.name)
            .reduce((all, p) => all.extend(p), new Patch(data.name));
          data.apply(placed);
          changed();
          note('Arranged.');
        });
      },
    },
    { label: 'Fit', key: 'f', run: () => view.fit() },
    { label: 'Zoom in', key: '=', run: () => zoom(0.5) },
    { label: 'Zoom out', key: '-', run: () => zoom(-0.5) },
  ]);
  /** Flies the camera in by `by` zoom levels, where each level doubles the scale. Negative zooms
   * out. */
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
        // New blocks appear at the camera's center, and nothing else moves.
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
    view.scene = scene();
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
      view.scene = scene();
    },
  );
  look.toggle('Flow', 'c', comets, (on) => {
    comets = on;
    view.scene = scene();
  });
  look.toggle('Light', 'l', light, (on) => {
    light = on;
    view.scene = scene();
  });
  const restyle = () => (view.scene = scene());
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

  // Theme settings for blocks, groups, ports, wires, and shadows.
  const sheet = stage.section('Sheet', false);
  const knob = (
    label: string,
    name:
      | 'corner'
      | 'portSize'
      | 'bend'
      | 'groupPadding'
      | 'wireSpacing'
      | 'arrow'
      | 'lift'
      | 'textSize'
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
  knob('Wire spacing', 'wireSpacing', 2, 12);
  knob('Arrowheads', 'arrow', 3, 14);
  knob('Text', 'textSize', 9, 16);
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

  // How the view responds to keys and presses.
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

  // Saves the diagram as a `.latk` file, the patch that builds it in latkit's binary format.
  // Opening the file restores the diagram unchanged.
  const file = stage.section('File', false);
  const picker = h('input', { type: 'file', accept: '.latk', hidden: true });
  file.content.append(picker);
  picker.addEventListener(
    'change',
    () => {
      const chosen = picker.files?.[0];
      picker.value = '';
      if (!chosen) return;
      void Data.read(chosen, { name: 'studio' })
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

  // An editable name field for the selected row.
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
  // A tag labels the selected block at its screen position. It hides when the camera moves.
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
      void view.screenOf(row).then((point) => {
        if (!point || each(view.selection)[0]?.id !== row.id) return;
        tag.textContent = `${row.table} · ${name(row)}`;
        tag.style.translate = `${point[0]}px ${point[1] - 18}px`;
        tag.hidden = false;
      });
    // Row counts per table, from `data.describe()`.
    described.textContent = data
      .describe()
      .tables.map((t) => `${t.name} ${t.rows.toLocaleString()}`)
      .join(' · ');
  };
  view.on('selection', describe);

  stage.meter(view);
  void load(preset).catch(stage.fail);
}
