/** Diagram: a microgrid's controller as blocks in groups, wired port to port and laid out by latkit. */
import { Patch, reference, type Marker, type Mark, type Port, type Side } from 'latkit';
import { THEME, type Piece } from './look.ts';

/** Kinds of block: the marker each draws as, its fill, and its ports. */
const KINDS = {
  Source: { marker: 'rounded', color: '#173836', ports: [['out', 'right', true]] },
  Process: {
    marker: 'block',
    color: '#1c2b3f',
    ports: [
      ['in', 'left', false],
      ['out', 'right', true],
    ],
  },
  Control: {
    marker: 'block',
    color: '#3a2e18',
    ports: [
      ['in', 'left', false],
      ['feedback', 'bottom', false],
      ['out', 'right', true],
    ],
  },
  Sink: { marker: 'block', color: '#29243f', ports: [['in', 'left', false]] },
} as const satisfies Record<
  string,
  { marker: Marker; color: string; ports: readonly (readonly [string, Side, boolean])[] }
>;
type Kind = keyof typeof KINDS;

interface Block {
  kind: Kind;
  id: number;
  name: string;
  group?: number;
  alarm?: boolean;
}

export default function diagram(): Piece {
  let next = 1;
  const blocks: Block[] = [];
  const groups: { id: number; name: string; area?: number }[] = [];
  const areas: { id: number; name: string }[] = [];
  const signals: { id: number; name: string }[] = [];
  const plugs = new Map<string, number>();
  const area = (name: string) => (areas.push({ id: next, name }), next++);
  const group = (name: string, inArea?: number) => (
    groups.push({ id: next, name, area: inArea }),
    next++
  );
  const block = (kind: Kind, name: string, inGroup?: number, alarm = false): Block => {
    const b = { kind, id: next++, name, group: inGroup, alarm };
    blocks.push(b);
    return b;
  };
  // A signal driven by `from`'s output and read by each of `to`, through its input or the port named.
  const wire = (name: string, from: Block | Block[], ...to: (Block | [Block, string])[]) => {
    const id = next++;
    signals.push({ id, name });
    for (const driver of [from].flat()) plugs.set(`${driver.id} out`, id);
    for (const reader of to) {
      const [b, port] = Array.isArray(reader) ? reader : [reader, 'in'];
      plugs.set(`${b.id} ${port}`, id);
    }
  };

  const plant = area('Microgrid');
  const sensing = group('Sensing', plant);
  const control = group('Control', plant);
  const power = group('Power stage', plant);
  const solar = block('Source', 'Solar array');
  const battery = block('Source', 'Battery');
  const tie = block('Source', 'Grid tie');
  const forecast = block('Source', 'Load forecast');
  const pmu = block('Process', 'PMU', sensing);
  const filter = block('Process', 'Filter', sensing);
  const estimator = block('Process', 'State estimator', sensing);
  const dispatch = block('Process', 'Dispatch', control);
  // The controller closing the loop sits between the groups it joins.
  const droop = block('Control', 'Droop');
  const limiter = block('Process', 'Limiter', control);
  const inverter = block('Process', 'Inverter', power, true);
  const breaker = block('Process', 'Breaker', power);
  const bus = block('Sink', 'Feeder');
  const log = block('Sink', 'Historian');
  wire('Measurements', [solar, battery, tie], pmu);
  wire('Phasors', pmu, filter);
  wire('Filtered', filter, estimator);
  wire('State', estimator, dispatch, log);
  wire('Forecast', forecast, dispatch);
  wire('Set points', dispatch, droop);
  wire('Command', droop, limiter);
  wire('Limited', limiter, inverter);
  wire('Output', inverter, breaker);
  wire('Power', breaker, bus, [droop, 'feedback']);

  const patch = new Patch('plant')
    .replace(
      'Signal',
      signals.map((s) => s.id),
      { name: signals.map((s) => s.name) },
    )
    .replace(
      'Area',
      areas.map((a) => a.id),
      { name: areas.map((a) => a.name) },
    )
    .replace(
      'Group',
      groups.map((g) => g.id),
      {
        name: groups.map((g) => g.name),
        area: reference(
          'Area',
          groups.map((g) => g.area ?? null),
        ),
      },
    );
  const kinds = Object.keys(KINDS) as Kind[];
  for (const kind of kinds) {
    const rows = blocks.filter((b) => b.kind === kind);
    const plugged = Object.fromEntries(
      KINDS[kind].ports.map(([port]) => [
        port,
        reference(
          'Signal',
          rows.map((b) => plugs.get(`${b.id} ${port}`) ?? null),
        ),
      ]),
    );
    patch.replace(
      kind,
      rows.map((b) => b.id),
      {
        name: rows.map((b) => b.name),
        status: rows.map((b) => (b.alarm ? 1 : 0)),
        group: reference(
          'Group',
          rows.map((b) => b.group ?? null),
        ),
        ...plugged,
      },
    );
  }
  const title = { text: 'name', size: 11, color: '#8ea3b8' };
  const marks: Mark[] = [
    {
      vertices: { of: ['plant', 'Area'], contains: ['Group', 'area'], label: title, shadow: true },
    },
    {
      vertices: {
        of: ['plant', 'Group'],
        contains: ['Process', 'group'],
        label: title,
        color: '#1d2632',
        shadow: true,
      },
    },
    {
      edges: {
        of: ['plant', 'Signal'],
        route: 'orthogonal',
        arrows: true,
        width: 1.5,
        color: '#8a9ab0',
      },
    },
    ...kinds.map((kind): Mark => ({
      vertices: {
        of: ['plant', kind],
        marker: KINDS[kind].marker,
        color: KINDS[kind].color,
        shadow: true,
        ring: {
          when: [[{ op: 'gt', args: ['status', 0] }, { color: '#ffb000' }]],
          otherwise: { missing: true },
        },
        ports: KINDS[kind].ports.map(([name, side, output]): [string, Port] => [
          name,
          { side, output, ...(name === 'feedback' ? { label: 'feedback' } : {}) },
        ]),
        label: { text: 'name', size: 12 },
      },
    })),
  ];
  return {
    name: 'diagram',
    alt: 'A microgrid controller as blocks in nested groups, wired port to port with routed wires and a feedback loop',
    data: [patch],
    scene: {
      space: { diagram: { grid: { dots: { pitch: 20 } } } },
      layout: { layered: { flow: 'right', gap: 40, rankGap: 52 } },
      ease: 0,
      theme: { ...THEME, grid: '#ffffff0d', diagram: { group: '#151c26' } },
      marks,
    },
  };
}
