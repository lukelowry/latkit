import { itemKey as rowKey, type Data } from '@latkit/model';
import type { Point, Shape } from '@latkit/gpu';
import type { Diagram } from './diagram.js';
export type { Point, Shape };
/** The item a scene vertex or edge draws, with the id its layout and labels key on. */
export interface SceneItem extends Diagram.Row {
  readonly id: string;
}
/** A scene row as a public item, without the id its layout keys on. */
export function rowOf(hit: SceneItem): Diagram.Row {
  return { kind: hit.kind, source: hit.source, index: hit.index, row: hit.row };
}
/** One string per item: its row space and row, then its kind and port; or its group. */
export function itemKey(item: Diagram.Item): string {
  return item.kind === 'group'
    ? JSON.stringify(['group', item.id])
    : rowKey(item, item.kind, item.kind === 'port' ? item.port : '');
}

/** What the renderer draws. */
export interface DiagramData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, Diagram.VertexOptions>>;
  readonly edges?: Readonly<Record<string, Diagram.EdgeOptions>>;
  readonly groups?: Readonly<Record<string, Diagram.GroupOptions>>;
}
/** The drawn records of a config. */
export function diagramData({ source, vertices, edges, groups }: DiagramData): DiagramData {
  return { source, vertices, edges, groups };
}
