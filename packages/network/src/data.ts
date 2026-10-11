import { itemKey, type Data } from '@latkit/model';
import type { Network } from './network.js';
/** An item's identity: its kind, row space, and row; appends keep it. */
export function networkKey(item: Network.Item): string {
  return itemKey(item, item.kind);
}
/** What the renderer draws. Positions are longitude/latitude in degrees for geographic data. */
export interface NetworkData {
  readonly source: Data;
  readonly vertices: Readonly<Record<string, Network.VertexOptions>>;
  readonly edges?: Readonly<Record<string, Network.EdgeOptions>>;
}
/** The drawn records of a config. */
export function networkData({ source, vertices, edges }: NetworkData): NetworkData {
  return { source, vertices, edges };
}
