import {
  Data,
  Patch,
  color,
  field,
  missing,
  reference,
  when,
  type Id,
  type Layout,
  type Mark,
  type Row,
  type Scene,
  type Shape,
  type Side,
} from 'latkit';
import type { Stage } from '../ui/stage.js';

/** Kinds of block: the shape each draws as, and its ports, each naming the signal it is plugged into. */
const KINDS = {
  Input: { shape: 'ellipse', ports: [['out', 'right', 'out']] },
  Process: {
    shape: 'rounded',
    ports: [
      ['in', 'left', 'in'],
      ['out', 'right', 'out'],
    ],
  },
  Control: {
    shape: 'diamond',
    ports: [
      ['in', 'left', 'in'],
      ['feedback', 'bottom', 'in'],
      ['out', 'right', 'out'],
    ],
  },
  Output: { shape: 'rectangle', ports: [['in', 'left', 'in']] },
} as const satisfies Record<
  string,
  { shape: Shape; ports: readonly (readonly [string, Side, 'in' | 'out'])[] }
>;
type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];

/** A port of a block, by the reference field naming its signal. */
interface Plug {
  kind: Kind;
  id: Id;
  port: string;
}

const direction = (kind: Kind, port: string) =>
  KINDS[kind].ports.find(([name]) => name === port)?.[2];

/**
 * A diagram drawn up as rows: blocks of each kind, the signals their ports plug into, and the groups
 * holding Process blocks, themselves held by stations. Positions are optional: blocks without one
 * are placed by the layout.
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
    rows.push({ id, name, at: at && [at[0], -at[1]], group });
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
        { name: this.stations.map((s) => s.name), folded: this.stations.map(() => false) },
      );
    }
    if (this.groups.length) {
      const stations = this.groups.map((g) => g.station ?? null);
      patch.set(
        'Group',
        this.groups.map((g) => g.id),
        {
          name: this.groups.map((g) => g.name),
          folded: this.groups.map(() => false),
          ...(this.stations.length ? { station: reference('Station', stations) } : {}),
        },
      );
    }
    for (const [kind, rows] of this.blocks) {
      const ports = Object.fromEntries(
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
          ...ports,
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

/** The presets: a water plant laid out in ranks, then the old studio's four. */
const PRESETS: readonly (readonly [string, () => Sketch])[] = [
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
      return s;
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
      return s;
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
      return s;
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
      return s;
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
      return s;
    },
  ],
];

/** Earlier versions of the data, to step back to and forward again. */
class History {
  readonly #undo: Data[] = [];
  #redo: Data[] = [];

  /** Remembers `before`, the version an edit started from. */
  commit(before: Data): void {
    this.#undo.push(before);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
  }

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
    this.#undo.length = 0;
    this.#redo = [];
  }
}

export default function page(stage: Stage): void {
  let preset = PRESETS[0]!;
  let sketch = preset[1]();
  let data = sketch.data();
  let layout: Layout = { layered: { flow: 'right', gap: 30, rankGap: 80 } };
  let route: 'orthogonal' | 'straight' = 'orthogonal';
  const history = new History();

  const scene = (): Scene => {
    const marks: Mark[] = [];
    const label = { text: 'name', size: 11, color: '#7f93a8' };
    if (sketch.stations.length) {
      marks.push({
        vertices: {
          of: ['studio', 'Station'],
          contains: ['Group', 'station'],
          collapsed: 'folded',
          marker: 'rounded',
          size: [{ units: 120 }, { units: 50 }],
          color: '#121922',
          label,
        },
      });
    }
    if (sketch.groups.length) {
      marks.push({
        vertices: {
          of: ['studio', 'Group'],
          contains: ['Process', 'group'],
          collapsed: 'folded',
          marker: 'rounded',
          size: [{ units: 110 }, { units: 46 }],
          color: '#18212c',
          label,
        },
      });
    }
    marks.push({ edges: { of: ['studio', 'Signal'], route, width: 1.5, color: '#9fb2c6' } });
    for (const kind of kinds) {
      marks.push({
        vertices: {
          of: ['studio', kind],
          position: ['x', 'y'],
          size: [{ units: 120 }, { units: 44 }],
          marker: KINDS[kind].shape,
          color: '#2c3b4d',
          status: when(field('status').gt(0)).then(color('#ff8c42')).otherwise(missing()),
          ports: KINDS[kind].ports.map(([port, side]) => [port, side] as [string, Side]),
          drag: true,
          label: { text: 'name', size: 11 },
        },
      });
    }
    return {
      space: { plane: { grid: { dots: 20 } } },
      layout,
      theme: { base: 'dark', background: '#0b0f14', groupPadding: 14 },
      controls: { connect: true, delete: true, selectBox: true },
      marks,
    };
  };
  const view = stage.view(scene(), {
    label:
      'A diagram: drag blocks, drag from a port to wire it, Delete removes, double-click a group to fold it',
  });

  /** Shows `next` as the current version. */
  const show = (next: Data) => {
    data = next;
    view.setData(data);
    describe();
  };
  /** Applies `patch` as one edit that undo steps back over. */
  const edit = (patch: Patch, said: string) => {
    history.commit(data);
    show(data.apply(patch));
    note(said);
  };
  const load = (choice: (typeof PRESETS)[number]) => {
    preset = choice;
    sketch = choice[1]();
    history.clear();
    view.show(scene());
    show(sketch.data());
    view.fit();
    note(`${choice[0]}: drag, wire, rename, fold, delete, undo.`);
    const blocks = kinds.reduce((n, kind) => n + (sketch.blocks.get(kind)?.length ?? 0), 0);
    stage.detail(
      `${blocks.toLocaleString()} blocks · ${sketch.signals.length.toLocaleString()} signals`,
    );
  };

  const name = (row: Row) =>
    (data.get(row.table, row.id, 'name') as string | null) ?? `${row.table} ${row.id}`;
  const isBlock = (table: string): table is Kind => table in KINDS;

  // Moving: the drag shows as it goes, and lands as one edit.
  let dragged: Data | undefined;
  view.on('drag', ({ phase, hit, position }) => {
    if (!isBlock(hit.row.table)) return;
    if (phase === 'start') dragged = data;
    const at = new Patch().set(hit.row.table, [hit.row.id as number], {
      x: [position[0]],
      y: [position[1]],
    });
    if (phase === 'end') {
      if (dragged) history.commit(dragged);
      dragged = undefined;
      show(data.apply(at));
      note(`Moved ${name(hit.row)}.`);
    } else show(data.apply(at));
  });

  // Wiring: an output and an input join on the output's signal, made when it has none.
  view.on('connect', ({ from, to }) => {
    if (!to) return note('Let go over nothing.');
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
      signal = sketch.next++;
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

  view.on('delete', (rows) => {
    const byTable = new Map<string, Id[]>();
    for (const row of rows) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row.id]);
    const patch = new Patch();
    for (const [table, ids] of byTable) patch.remove(table, ids as number[]);
    edit(patch, `Removed ${rows.map(name).join(', ')}.`);
  });

  // A double click folds or unfolds a group.
  view.on('open', ({ row }) => {
    if (row.table !== 'Group' && row.table !== 'Station') return;
    const folded = data.get(row.table, row.id, 'folded') === true;
    edit(
      new Patch().set(row.table, [row.id as number], { folded: [!folded] }),
      `${folded ? 'Opened' : 'Folded'} ${name(row)}.`,
    );
  });

  const studio = stage.section('Diagram');
  studio.choice(
    'Preset',
    PRESETS.map((p) => [p[0], p] as const),
    preset,
    load,
  );
  studio.actions([
    {
      label: 'Undo',
      key: 'z',
      run: () => {
        const before = history.undo(data);
        if (before) (show(before), note('Undone.'));
      },
    },
    {
      label: 'Redo',
      key: 'y',
      run: () => {
        const after = history.redo(data);
        if (after) (show(after), note('Redone.'));
      },
    },
    {
      label: 'Arrange',
      key: 'a',
      // Blocks without positions are the layout's to place.
      run: () => {
        const patch = new Patch();
        for (const kind of kinds) {
          const ids = sketch.blocks.get(kind)?.map((b) => b.id) ?? [];
          const all = ids.filter((id) => data.get(kind, id, 'name') !== null);
          if (all.length) patch.set(kind, all, { x: all.map(() => null), y: all.map(() => null) });
        }
        edit(patch, 'Arranged.');
        view.fit();
      },
    },
  ]);
  const add = stage.section('Add');
  add.actions(
    kinds.map((kind, i) => ({
      label: kind,
      key: String(i + 1),
      run: () => {
        // New blocks land where the camera looks.
        const camera = view.camera;
        const [x, y] = 'center' in camera ? camera.center : [0, 0];
        const id = sketch.next++;
        sketch.blocks.set(kind, [
          ...(sketch.blocks.get(kind) ?? []),
          { id, name: `New ${kind.toLowerCase()}` },
        ]);
        const ports = Object.fromEntries(
          KINDS[kind].ports.map(([port]) => [port, reference('Signal', [null])]),
        );
        edit(
          new Patch().set(kind, [id], {
            name: [`New ${kind.toLowerCase()}`],
            x: [x],
            y: [y],
            status: [0],
            ...ports,
          }),
          `Added a ${kind.toLowerCase()} block.`,
        );
      },
    })),
  );

  const look = stage.section('Look');
  const layouts: readonly (readonly [string, Layout])[] = [
    ['In ranks, left to right', layout],
    ['In ranks, top to bottom', { layered: { flow: 'down', gap: 30, rankGap: 60 } }],
    ['By graph distance', { stress: { gap: 140 } }],
  ];
  look.choice('Place blocks without positions', layouts, layout, (next) => {
    layout = next;
    view.show(scene());
    view.fit();
  });
  look.choice(
    'Wires run',
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

  // The selected block's name, editable.
  const selected = stage.section('Selected');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Select a block to rename it';
  input.disabled = true;
  input.setAttribute('aria-label', 'Name');
  const told = document.createElement('p');
  told.className = 'series';
  selected.element.append(input, told);
  const note = (text: string) => (told.textContent = text);
  const describe = () => {
    const [row] = view.selection;
    const named = row && (isBlock(row.table) || row.table === 'Group' || row.table === 'Station');
    input.disabled = !named;
    input.value = named ? name(row) : '';
  };
  input.addEventListener(
    'change',
    () => {
      const [row] = view.selection;
      if (row)
        edit(
          new Patch().set(row.table, [row.id as number], { name: [input.value] }),
          `Renamed to ${input.value}.`,
        );
    },
    { signal: stage.signal },
  );
  view.on('select', describe);

  stage.meter(view);
  load(preset);
}
