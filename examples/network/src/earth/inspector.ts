/** The inspector: what the hovered or selected row holds, read at the playhead. */
import type { Gpu } from '@latkit/gpu';
import { bitAt, rowCount, textAt, type Column, type Item, type ReadScope } from '@latkit/model';
import { element } from './controls.js';

export interface Described {
  readonly id: string;
  readonly fields: readonly (readonly [name: string, value: string])[];
}
const MAX_FIELDS = 24;

function cell(column: Column | undefined, i: number): string {
  if (!column) return '–';
  const at = column.offset + i;
  if (!bitAt(column.validity, at)) return '–';
  if (column.kind === 'numeric') {
    const v = column.values[at]!;
    return Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(4);
  }
  if (column.kind === 'boolean') return bitAt(column.values, at) ? 'true' : 'false';
  if (column.kind === 'text') return textAt(column, i) ?? '–';
  if (column.kind === 'vector') {
    const base = column.values.offset + at * column.size;
    return Array.from(column.values.values.subarray(base, base + Math.min(column.size, 3)), (v) =>
      v.toFixed(4),
    ).join(', ');
  }
  if (column.kind === 'reference') return `row ${column.values[at]}`;
  return '…';
}
/** An item's id and fields, read through a scope, sampled fields at its coordinate. */
async function describe(reader: ReadScope, item: Item): Promise<Described> {
  const definition = item.source.schema.types[item.index.type];
  const names = Object.entries(definition?.fields ?? {})
    .filter(([, d]) => typeof d.type === 'string' || d.type.kind === 'vector' || d.type.kind === 'reference')
    .slice(0, MAX_FIELDS)
    .map(([name]) => name);
  for await (const block of reader.fields({
    source: item.source,
    from: item.index.type,
    rows: { kind: 'indices', index: item.index, values: Uint32Array.of(item.row) },
    fields: Object.fromEntries(names.map((name) => [name, name])),
    ids: true,
  })) {
    if (!rowCount(block.rows)) continue;
    return {
      id: block.ids ? (textAt(block.ids, 0) ?? '') : '',
      fields: names.map((name) => [name, bitAt(block.presence[name], 0) ? cell(block.columns[name], 0) : '–']),
    };
  }
  return { id: '', fields: [] };
}

/** Fields the inspector leaves out: where a row is drawn, which its place on the map shows. */
const HIDDEN = /^(position|points|rings|bends)$/;

/**
 * The panel naming what the pointer is over, or else what is selected: its type, its name or id,
 * and its fields at the playhead.
 */
export class Inspector {
  private hovered: Item | null = null;
  private selected: Item | null = null;
  private serial = 0;
  at = 0;
  constructor(
    private readonly gpu: Gpu,
    private readonly root: HTMLElement,
    private readonly fail: (error: unknown) => void,
  ) {}
  hover(item: Item | null): void {
    this.hovered = item;
    this.show();
  }
  select(items: readonly Item[]): void {
    this.selected = items[0] ?? null;
    this.show();
  }
  clear(): void {
    this.hovered = this.selected = null;
    this.show();
  }
  /** Read the shown row again, as at a new playhead. */
  refresh(): void {
    if (this.hovered ?? this.selected) this.show();
  }
  private show(): void {
    void this.render().catch(this.fail);
  }
  private async render(): Promise<void> {
    const item = this.hovered ?? this.selected,
      mine = ++this.serial;
    if (!item) {
      this.root.hidden = true;
      return;
    }
    const reader = this.gpu.reader.open({ at: this.at });
    try {
      const described = await describe(reader, item);
      if (mine !== this.serial) return;
      const name = described.fields.find(([n]) => /^name$/i.test(n))?.[1];
      this.root.replaceChildren(
        element(
          'header',
          {},
          element('span', { className: 'kind' }, item.index.type),
          element('strong', {}, name && name !== '–' ? name : described.id || `row ${item.row}`),
          this.hovered ? null : element('span', { className: 'type' }, 'selected'),
        ),
        element(
          'dl',
          {},
          ...described.fields
            .filter(([n]) => !HIDDEN.test(n) && !/^name$/i.test(n))
            .flatMap(([n, v]) => [element('dt', {}, n), element('dd', {}, v)]),
        ),
      );
      this.root.hidden = false;
    } finally {
      reader.close();
    }
  }
}
