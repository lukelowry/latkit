/**
 * Netlists and layouts for the text tests: a netlist of many one-port blocks with long labels,
 * to push the glyph count past its cap, random blocks with text on every side, and a layout mirror
 * with blocks in a row.
 */

import type { Netlist } from '@latkit/model';

import type { Prepared } from '../../src/prepare.js';
import { layoutBases, Mirror } from '../../src/webgpu/buffers.js';
import { random } from './netlists.js';

/** What every block and net of a bulk netlist says. */
export interface BulkText {
  readonly title: string;
  readonly label?: string;
  readonly port: string;
  readonly net: string;
  /** Nets: net `n` is port `n` alone. */
  readonly nets: number;
}

/** `blocks` blocks of one labeled `out` port each; the first `nets` ports are each a net. */
export function bulk(blocks: number, text: BulkText): Netlist {
  return {
    blockCount: blocks,
    blockTitle: new Array<string>(blocks).fill(text.title),
    blockLabel: text.label === undefined ? undefined : new Array<string>(blocks).fill(text.label),
    portStart: Uint32Array.from({ length: blocks + 1 }, (_, i) => i),
    portFlow: new Uint8Array(blocks).fill(1),
    portLabel: new Array<string>(blocks).fill(text.port),
    netStart: Uint32Array.from({ length: text.nets + 1 }, (_, i) => i),
    netPorts: Uint32Array.from({ length: text.nets }, (_, i) => i),
    netLabel: new Array<string>(text.nets).fill(text.net),
  };
}

/** Characters random text draws from: narrow, wide, and a combining mark (after a letter). */
const NARROW = 'abcdefghijklmnopqrstuvwxyz_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const WIDE = '漢字한국カナ';

/** A random text of up to `most` columns' worth of graphemes; empty about one time in `blank`. */
function randomText(next: () => number, most: number, blank: number): string {
  if (next() * blank < 1) return '';
  const length = 1 + Math.floor(next() * most);
  let text = '';
  for (let i = 0; i < length; i++) {
    const pick = next();
    if (pick < 0.08) text += WIDE[Math.floor(next() * WIDE.length)]!;
    else if (pick < 0.12) text += 'é';
    else text += NARROW[Math.floor(next() * NARROW.length)]!;
  }
  return text;
}

/**
 * `blocks` random blocks with text everywhere a block has it: a title, a label under it, and zero
 * to twelve ports on random sides, each maybe labeled and maybe alone on a tag net with a label.
 * Texts mix narrow, wide, and combined graphemes; about one in four is empty.
 */
export function randomBlocks(blocks: number, seed = 1): Netlist {
  const next = random(seed);
  const portStart = new Uint32Array(blocks + 1);
  const flow: number[] = [];
  const side: number[] = [];
  const portLabel: string[] = [];
  const blockTitle: string[] = [];
  const blockLabel: string[] = [];
  const tagged: number[] = [];
  const netLabel: string[] = [];
  for (let b = 0; b < blocks; b++) {
    blockTitle.push(randomText(next, 14, 4));
    blockLabel.push(randomText(next, 16, 4));
    const count = Math.floor(next() * 13);
    for (let i = 0; i < count; i++) {
      const port = flow.length;
      flow.push(Math.floor(next() * 3));
      side.push(Math.floor(next() * 4));
      portLabel.push(randomText(next, 10, 4));
      if (next() < 0.3) {
        tagged.push(port);
        netLabel.push(randomText(next, 12, 4));
      }
    }
    portStart[b + 1] = flow.length;
  }
  return {
    blockCount: blocks,
    blockTitle,
    blockLabel,
    portStart,
    portFlow: Uint8Array.from(flow),
    portSide: Uint8Array.from(side),
    portLabel,
    netStart: Uint32Array.from({ length: tagged.length + 1 }, (_, n) => n),
    netPorts: Uint32Array.from(tagged),
    netStyle: new Uint8Array(tagged.length).fill(1),
    netLabel,
  };
}

/**
 * A layout mirror for `prepared`: block `b` at `(spacing * b, 0)`, net `n`'s anchor at
 * `(spacing * n, -20)`, and every group frame from `(-16, -24)` to `(1000, 200)`.
 */
export function rowLayout(prepared: Prepared, spacing = 400): Mirror {
  const bases = layoutBases(prepared);
  const layout = new Mirror('layout', 'storage', bases.words);
  const f32 = layout.f32;
  for (let block = 0; block < prepared.blockCount; block++) {
    f32[2 * block] = spacing * block;
    f32[2 * block + 1] = 0;
  }
  for (let group = 0; group < prepared.groupCount; group++) {
    f32.set([-16, -24, 1000, 200], bases.group + 4 * group);
  }
  for (let net = 0; net < prepared.netCount; net++) {
    f32[bases.anchor + 2 * net] = spacing * net;
    f32[bases.anchor + 2 * net + 1] = -20;
  }
  return layout;
}
