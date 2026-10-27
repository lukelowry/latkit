/** Diagram: a microgrid controller as blocks in groups, wired port to port, laid out by latkit. */
import { Data, field, reference, when, type Mark, type Marker, type Port } from 'latkit';
import type { Picture } from './render.ts';

/** Block kinds: each kind's marker, fill color, and ports by name. An output drives its signal. */
const KINDS = {
  Source: { marker: 'rounded', color: '#173836', ports: { out: { side: 'right', output: true } } },
  Process: {
    marker: 'block',
    color: '#1c2b3f',
    ports: { in: 'left', out: { side: 'right', output: true } },
  },
  Control: {
    marker: 'block',
    color: '#3a2e18',
    ports: {
      in: 'left',
      feedback: { side: 'bottom', label: 'feedback' },
      out: { side: 'right', output: true },
    },
  },
  Sink: { marker: 'block', color: '#29243f', ports: { in: 'left' } },
} as const satisfies Record<string, { marker: Marker; color: string; ports: Record<string, Port> }>;
type Kind = keyof typeof KINDS;

interface Block {
  kind: Kind;
  id: number;
  name: string;
  group: number | null;
  alarm: boolean;
}

export default function (): Picture {
  // Areas, groups, signals, and blocks share one sequence of ids. Each table is kept as columns.
  let next = 1;
  const areas = { ids: [] as number[], name: [] as string[] };
  const groups = { ids: [] as number[], name: [] as string[], area: [] as (number | null)[] };
  const signals = { ids: [] as number[], name: [] as string[] };
  const blocks: Block[] = [];
  const plugs = new Map<string, number>();
  const area = (name: string) => {
    areas.ids.push(next);
    areas.name.push(name);
    return next++;
  };
  const group = (name: string, inArea: number | null = null) => {
    groups.ids.push(next);
    groups.name.push(name);
    groups.area.push(inArea);
    return next++;
  };
  const block = (kind: Kind, name: string, inGroup: number | null = null, alarm = false) => {
    const b = { kind, id: next++, name, group: inGroup, alarm };
    blocks.push(b);
    return b;
  };
  // Adds a signal driven by the `out` port of each block in `from`. Each block in `to` reads it
  // through its `in` port, or through the port named with it.
  const wire = (name: string, from: Block | Block[], ...to: (Block | [Block, string])[]) => {
    const id = next++;
    signals.ids.push(id);
    signals.name.push(name);
    for (const driver of [from].flat()) plugs.set(`${driver.id} out`, id);
    for (const reader of to) {
      const [b, port] = Array.isArray(reader) ? reader : [reader, 'in'];
      plugs.set(`${b.id} ${port}`, id);
    }
  };

  const microgrid = area('Microgrid');
  const sensing = group('Sensing', microgrid);
  const control = group('Control', microgrid);
  const power = group('Power stage', microgrid);
  const solar = block('Source', 'Solar array');
  const battery = block('Source', 'Battery');
  const tie = block('Source', 'Grid tie');
  const forecast = block('Source', 'Load forecast');
  const pmu = block('Process', 'PMU', sensing);
  const filter = block('Process', 'Filter', sensing);
  const estimator = block('Process', 'State estimator', sensing);
  const dispatch = block('Process', 'Dispatch', control);
  // The controller that closes the loop is in no group, so it sits between the groups it joins.
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

  const plant = new Data('plant')
    .replace('Signal', signals.ids, { name: signals.name })
    .replace('Area', areas.ids, { name: areas.name })
    .replace('Group', groups.ids, { name: groups.name, area: reference('Area', groups.area) });
  const kinds = Object.keys(KINDS) as Kind[];
  for (const kind of kinds) {
    const rows = blocks.filter((b) => b.kind === kind);
    const ids = rows.map((b) => b.id);
    const inGroup = rows.map((b) => b.group);
    // Each port's reference field names the signal on it.
    const ports = Object.keys(KINDS[kind].ports).map((port) => {
      const signal = rows.map((b) => plugs.get(`${b.id} ${port}`) ?? null);
      return [port, reference('Signal', signal)] as const;
    });
    plant.replace(kind, ids, {
      name: rows.map((b) => b.name),
      status: rows.map((b) => (b.alarm ? 1 : 0)),
      group: reference('Group', inGroup),
      ...Object.fromEntries(ports),
    });
  }

  const title = { text: '$name', size: 11, color: '#8ea3b8' };
  return {
    scene: {
      space: { diagram: { grid: { dots: { pitch: 20 } } } },
      layout: { layered: { direction: 'right', gap: 40, rankGap: 52 } },
      ease: 0,
      // The dark theme, with a darker background and labels without halos.
      theme: {
        background: '#0b0f14',
        text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
        grid: '#ffffff0d',
        diagram: { group: '#151c26' },
      },
      marks: [
        { vertices: plant.table('Area'), contains: ['Group', 'area'], label: title, shadow: true },
        {
          vertices: plant.table('Group'),
          contains: ['Process', 'group'],
          label: title,
          color: '#1d2632',
          shadow: true,
        },
        {
          edges: plant.table('Signal'),
          route: 'orthogonal',
          arrows: true,
          width: 1.5,
          color: '#8a9ab0',
        },
        ...kinds.map((kind): Mark => ({
          vertices: plant.table(kind),
          marker: KINDS[kind].marker,
          color: KINDS[kind].color,
          shadow: true,
          ring: when(field('status').gt(0)).then('#ffb000').otherwise(null),
          ports: Object.entries(KINDS[kind].ports),
          label: { text: '$name', size: 12 },
        })),
      ],
    },
  };
}
