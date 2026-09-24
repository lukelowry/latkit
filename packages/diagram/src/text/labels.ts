/**
 * Diagram text: every run a prepared netlist draws, placed at most once per load (when text first
 * becomes legible) relative to what it hangs from, and the glyph instances of the runs in view. A
 * glyph instance names its anchor rather than a position, so moving blocks, routing nets and
 * framing groups never touch the glyphs mirror; only the covered window, legibility, or the runs
 * themselves regenerate it.
 */

import { netLabelBox, type Rect } from '../geometry.js';
import {
  BAND_BOTTOM,
  BAND_TOP,
  NONE,
  SIDE_BOTTOM,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDE_TOP,
  STYLE_TAG,
  STYLE_WIRE,
  type Prepared,
} from '../prepare.js';
import {
  ANCHOR_BLOCK,
  ANCHOR_GROUP,
  ANCHOR_NET,
  ANCHOR_PORT,
  GLYPH_WORDS,
  layoutBases,
  ROLE_GROUP,
  ROLE_LABEL,
  ROLE_NET,
  ROLE_PORT,
  ROLE_TAG,
  ROLE_TITLE,
  type Mirror,
} from '../webgpu/buffers.js';
import type { Atlas } from './atlas.js';
import { ADVANCE, isWide, LINE } from './metrics.js';

/**
 * Every text run of a prepared netlist, as columns: what each run hangs from, where its line
 * starts, its em size, its role, and its text, segmented into graphemes once.
 */
export interface Runs {
  /** Number of runs. */
  readonly count: number;
  /** Per run: `ANCHOR_*`, what it hangs from. */
  readonly anchor: Uint8Array;
  /** Per run: the block, port, net, or group it hangs from. */
  readonly index: Uint32Array;
  /** Per run: `ROLE_*`. */
  readonly role: Uint8Array;
  /** Per run: its line's top-left relative to the anchor, 2 floats, in diagram units. */
  readonly offset: Float32Array;
  /** Per run: its em size in diagram units. */
  readonly em: Float32Array;
  /** Per run: its width in diagram units, one advance per column. */
  readonly width: Float32Array;
  /** Per run: its text. */
  readonly text: readonly string[];
  /** Per run: its text's id; runs with the same text share one. */
  readonly textId: Uint32Array;
  /** Text `t` is the graphemes `glyphs[glyphStart[t]]` up to `glyphs[glyphStart[t + 1]]`. */
  readonly glyphStart: Uint32Array;
  /** Grapheme ids, text after text. */
  readonly glyphs: Uint32Array;
  /** Per grapheme id: the grapheme. */
  readonly graphemes: readonly string[];
  /** Per grapheme id: `1` when it is East Asian wide and takes two columns, else `0`. */
  readonly wide: Uint8Array;
}

/** Roles in `ROLE_*` order. */
const ROLES = 6;
/** Smallest em size in CSS px a role gets glyphs at; the glyph pass fades in above it. */
export const LEGIBLE_PX = 4.5;
/** Most glyph instances one update writes. */
export const GLYPH_CAP = 262_144;
/** Roles dropped whole, in order, while the glyphs in the window exceed the cap. */
const DROP = Uint8Array.of(ROLE_NET, ROLE_PORT, ROLE_LABEL, ROLE_TAG, ROLE_GROUP);
/** A grapheme whose atlas cell is not resolved yet. */
const UNRESOLVED = 0x7fffffff;
/** Code units below this are each one grapheme (no combining marks, no surrogates). */
const SIMPLE = 0x300;
/** Carriage return, which joins a following line feed into one grapheme. */
const CR = 0x0d;

let segmenter: Intl.Segmenter | null | undefined;

/** The platform's grapheme segmenter, or null where `Intl.Segmenter` does not exist. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return segmenter;
}

/** Whether every code unit of `text` is a grapheme of its own. */
function simple(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= SIMPLE || code === CR) return false;
  }
  return true;
}

/** Interns texts into grapheme-id sequences, so runs sharing a text share its glyphs. */
class Texts {
  readonly ids = new Map<string, number>();
  /** Per text: its first grapheme in `glyphs`; one more entry than texts. */
  starts: Uint32Array;
  /** Per text: its columns. */
  columns: Uint32Array;
  glyphs = new Uint32Array(1024);
  glyphCount = 0;
  readonly graphemes: string[] = [];
  wide = new Uint8Array(128);
  /** Grapheme id of each simple code unit, or -1. */
  private readonly unit = new Int32Array(SIMPLE).fill(-1);
  private readonly grapheme = new Map<string, number>();

  constructor(capacity: number) {
    this.starts = new Uint32Array(capacity + 1);
    this.columns = new Uint32Array(capacity);
  }

  get count(): number {
    return this.ids.size;
  }

  /** The id of `text`, segmenting it on first sight. */
  intern(text: string): number {
    const known = this.ids.get(text);
    if (known !== undefined) return known;
    const id = this.ids.size;
    this.ids.set(text, id);
    let columns = 0;
    if (simple(text)) {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        let g = this.unit[code]!;
        if (g < 0) g = this.unit[code] = this.add(text[i]!);
        this.push(g);
        columns++;
      }
    } else {
      const segments = graphemeSegmenter();
      if (segments) {
        for (const { segment } of segments.segment(text))
          columns += this.push(this.lookup(segment));
      } else {
        for (const point of text) columns += this.push(this.lookup(point));
      }
    }
    this.columns[id] = columns;
    this.starts[id + 1] = this.glyphCount;
    return id;
  }

  /** Append grapheme `g` to the current text; returns its columns. */
  private push(g: number): number {
    if (this.glyphCount === this.glyphs.length) {
      const grown = new Uint32Array(this.glyphs.length * 2);
      grown.set(this.glyphs);
      this.glyphs = grown;
    }
    this.glyphs[this.glyphCount++] = g;
    return this.wide[g]! + 1;
  }

  /** The id of a grapheme outside the simple range. */
  private lookup(grapheme: string): number {
    const known = this.grapheme.get(grapheme);
    if (known !== undefined) return known;
    const g = this.add(grapheme);
    this.grapheme.set(grapheme, g);
    return g;
  }

  /** A new grapheme id. */
  private add(grapheme: string): number {
    const g = this.graphemes.length;
    this.graphemes.push(grapheme);
    if (g === this.wide.length) {
      const grown = new Uint8Array(g * 2);
      grown.set(this.wide);
      this.wide = grown;
    }
    this.wide[g] = isWide(grapheme.codePointAt(0)!) ? 1 : 0;
    return g;
  }
}

/** A non-empty label, or null. */
function nonEmpty(labels: readonly string[] | undefined, i: number): string | null {
  const text = labels?.[i];
  return text ? text : null;
}

/**
 * Every text run of a prepared netlist: anchor, offset, em size, role, and its text.
 *
 * @remarks
 * Runs come role by role in `ROLE_*` order, placed by the rules `prepare` sized each block by, so
 * no two runs of one block meet: block titles centered across their blocks and centered down their
 * side regions (between the label bands `Prepared.bands` flags); block labels centered under them
 * (below any bottom tags, inside the extent `prepare` reserved); left and right port labels inside
 * the block edge, `inset` from it, centered on their ports; top and bottom port labels centered on
 * their ports, filling their band to its inner edge; a tag's net label in each tag pill; a wired
 * net's label over its anchor; a group's label in its header. Empty labels make no run. A run is
 * never wider than `prepare` measured its text, since a grapheme spans no more columns than its
 * code points do.
 */
export function textRuns(prepared: Prepared): Runs {
  const { netlist, metrics: m, blockCount, portCount, netCount, groupCount } = prepared;
  const { blockTitle, blockLabel, portLabel, netLabel, groupLabel } = netlist;

  let count = 0;
  for (let block = 0; block < blockCount; block++) {
    if (nonEmpty(blockTitle, block)) count++;
    if (nonEmpty(blockLabel, block)) count++;
  }
  for (let port = 0; port < portCount; port++) {
    if (nonEmpty(portLabel, port)) count++;
    const net = prepared.portNet[port]!;
    if (net !== NONE && prepared.netStyle[net] === STYLE_TAG && nonEmpty(netLabel, net)) count++;
  }
  for (let net = 0; net < netCount; net++) {
    if (prepared.netStyle[net] === STYLE_WIRE && nonEmpty(netLabel, net)) count++;
  }
  for (let group = 0; group < groupCount; group++) if (nonEmpty(groupLabel, group)) count++;

  const anchor = new Uint8Array(count);
  const index = new Uint32Array(count);
  const role = new Uint8Array(count);
  const offset = new Float32Array(2 * count);
  const em = new Float32Array(count);
  const width = new Float32Array(count);
  const text: string[] = [];
  const textId = new Uint32Array(count);
  const texts = new Texts(count);

  let at = 0;
  /** Add a run and return its width, so its placement can follow. */
  const add = (a: number, i: number, r: number, size: number, t: string): number => {
    const id = texts.intern(t);
    anchor[at] = a;
    index[at] = i;
    role[at] = r;
    em[at] = size;
    text.push(t);
    textId[at] = id;
    return (width[at] = texts.columns[id]! * ADVANCE * size);
  };
  const place = (x: number, y: number): void => {
    offset[2 * at] = x;
    offset[2 * at + 1] = y;
    at++;
  };

  const { size, bands, portOffset, portSide } = prepared;
  const labelLine = LINE * m.labelEm;

  for (let block = 0; block < blockCount; block++) {
    const t = nonEmpty(blockTitle, block);
    if (!t) continue;
    const top = bands[block]! & BAND_TOP ? m.band : 0;
    const bottom = bands[block]! & BAND_BOTTOM ? m.band : 0;
    const w = add(ANCHOR_BLOCK, block, ROLE_TITLE, m.titleEm, t);
    const middle = size[2 * block + 1]! - top - bottom;
    place((size[2 * block]! - w) / 2, top + (middle - LINE * m.titleEm) / 2);
  }

  for (let block = 0; block < blockCount; block++) {
    const t = nonEmpty(blockLabel, block);
    if (!t) continue;
    // Under the block, and under its bottom tags when it has any, as its extent allows.
    let top = size[2 * block + 1]! + m.labelGap;
    for (let port = netlist.portStart[block]!; port < netlist.portStart[block + 1]!; port++) {
      if (portSide[port] === SIDE_BOTTOM && prepared.tagLength[port]! > 0) {
        top += m.tagHeight + m.tagGap;
        break;
      }
    }
    const w = add(ANCHOR_BLOCK, block, ROLE_LABEL, m.labelEm, t);
    place((size[2 * block]! - w) / 2, top);
  }

  for (let port = 0; port < portCount; port++) {
    const t = nonEmpty(portLabel, port);
    if (!t) continue;
    const block = prepared.portBlock[port]!;
    const px = portOffset[2 * port]!;
    const py = portOffset[2 * port + 1]!;
    const w = add(ANCHOR_BLOCK, block, ROLE_PORT, m.labelEm, t);
    switch (portSide[port]) {
      case SIDE_LEFT:
        place(m.inset, py - labelLine / 2);
        break;
      case SIDE_RIGHT:
        place(size[2 * block]! - m.inset - w, py - labelLine / 2);
        break;
      // A top (bottom) label's line ends at its band's inner edge, as far from the marker as it goes.
      case SIDE_TOP:
        place(px - w / 2, m.band - labelLine);
        break;
      default:
        place(px - w / 2, size[2 * block + 1]! - m.band);
    }
  }

  // Tag text sits one gap plus one pad from the port, inside its pill.
  const tagText = m.tagGap + m.tagPad;
  const tagMiddle = m.tagGap + m.tagHeight / 2;
  for (let port = 0; port < portCount; port++) {
    const net = prepared.portNet[port]!;
    if (net === NONE || prepared.netStyle[net] !== STYLE_TAG) continue;
    const t = nonEmpty(netLabel, net);
    if (!t) continue;
    const w = add(ANCHOR_PORT, port, ROLE_TAG, m.labelEm, t);
    switch (portSide[port]) {
      case SIDE_LEFT:
        place(-tagText - w, -labelLine / 2);
        break;
      case SIDE_RIGHT:
        place(tagText, -labelLine / 2);
        break;
      case SIDE_TOP:
        place(-w / 2, -tagMiddle - labelLine / 2);
        break;
      default:
        place(-w / 2, tagMiddle - labelLine / 2);
    }
  }

  // A wired net's label sits in its `netLabelBox`, where bounds and group frames expect it.
  const netBox = new Float64Array(4);
  for (let net = 0; net < netCount; net++) {
    if (prepared.netStyle[net] !== STYLE_WIRE) continue;
    const t = nonEmpty(netLabel, net);
    if (!t) continue;
    const w = add(ANCHOR_NET, net, ROLE_NET, m.labelEm, t);
    netLabelBox(m, 0, 0, w, netBox);
    place(netBox[0]!, netBox[1]!);
  }

  for (let group = 0; group < groupCount; group++) {
    const t = nonEmpty(groupLabel, group);
    if (!t) continue;
    add(ANCHOR_GROUP, group, ROLE_GROUP, m.groupEm, t);
    place(m.grid, 0.75 * m.grid);
  }

  return {
    count,
    anchor,
    index,
    role,
    offset,
    em,
    width,
    text,
    textId,
    glyphStart: texts.starts.slice(0, texts.count + 1),
    glyphs: texts.glyphs.slice(0, texts.glyphCount),
    graphemes: texts.graphemes,
    wide: texts.wide.slice(0, texts.graphemes.length),
  };
}

/**
 * The glyph instances of the runs in view, rebuilt only when the view leaves their window.
 *
 * @remarks
 * A bound netlist's runs are built by the first update at a zoom where some role is legible, and
 * kept until the next `reset`: a load costs nothing for text while the whole diagram is in view
 * too small to read.
 */
export class Labels {
  private readonly mirror: Mirror;
  private readonly atlas: Atlas;
  private prepared: Prepared | null = null;
  /** The bound netlist's runs, or null until an update first needs them. */
  private runs: Runs | null = null;
  /** Per grapheme id: its atlas cell, or `UNRESOLVED`. */
  private cells = new Uint32Array(0);
  /** The atlas generation `cells` were resolved under. */
  private generation = -1;
  /** Per role: its em size. */
  private readonly roleEm = new Float64Array(ROLES);
  /** Per role: glyphs in the window this update (scratch). */
  private readonly roleGlyphs = new Float64Array(ROLES);
  /** Runs in the window this update (scratch, grown on demand). */
  private eligible = new Uint32Array(0);
  /** The covered window `[x0, y0, x1, y1]`, valid while `covered`. */
  private readonly window = new Float64Array(4);
  private covered = false;
  /** Bit `r` set when role `r` was legible at the last regeneration. */
  private legible = 0;
  private glyphCount = 0;

  constructor(mirror: Mirror, atlas: Atlas) {
    this.mirror = mirror;
    this.atlas = atlas;
  }

  /** Glyph instances in the glyphs mirror: the glyph pass instance count. */
  get count(): number {
    return this.glyphCount;
  }

  /**
   * Bind a prepared netlist, or none; the next update regenerates. Constant time: the runs are
   * built by the first update that has a legible role. With none, the glyphs mirror and the
   * scratch give their memory back.
   */
  reset(prepared: Prepared | null): void {
    this.prepared = prepared;
    this.runs = null;
    this.cells = new Uint32Array(0);
    this.generation = this.atlas.generation;
    if (prepared) {
      const m = prepared.metrics;
      this.roleEm[ROLE_TITLE] = m.titleEm;
      this.roleEm[ROLE_LABEL] = m.labelEm;
      this.roleEm[ROLE_PORT] = m.labelEm;
      this.roleEm[ROLE_TAG] = m.labelEm;
      this.roleEm[ROLE_NET] = m.labelEm;
      this.roleEm[ROLE_GROUP] = m.groupEm;
    } else {
      this.eligible = new Uint32Array(0);
      this.mirror.release();
    }
    this.covered = false;
    this.clear();
  }

  /**
   * Rebuild the glyph instances when the view leaves the covered window (viewport +50% each
   * side), a role crosses its legibility threshold, runs changed, or `force`. Returns the glyph
   * count. Only runs whose anchor is inside the window and whose `em * zoom >= 4.5` CSS px get
   * glyphs; capped at 262144 glyphs (dropping roles NET, PORT, LABEL, TAG, GROUP, TITLE in that
   * order until it fits).
   *
   * @remarks
   * A run is in the window when its line box, placed at its anchor's current position, meets the
   * window; an anchor without a position (NaN) keeps its runs out. Titles are the last role
   * standing: when they alone exceed the cap, the first `GLYPH_CAP` glyphs are kept rather than
   * none. A change of atlas font regenerates too. Blocks moving never do on their own (glyphs
   * follow their anchors on the GPU); pass `force` after a move large enough to bring new runs
   * into the window. The first update with a legible role since `reset` builds the runs.
   *
   * @param view - The visible diagram rectangle.
   * @param zoom - CSS px per diagram unit.
   * @param layout - The layout mirror: effective positions, group bounds, and net anchors.
   * @param labels - Whether text is drawn at all; false empties the glyphs.
   * @param force - Regenerate even when nothing above changed.
   */
  update(view: Rect, zoom: number, layout: Mirror, labels: boolean, force: boolean): number {
    const prepared = this.prepared;
    const [vx0, vy0, vx1, vy1] = view;
    if (!prepared || !labels || !(vx1 >= vx0 && vy1 >= vy0) || !(zoom > 0)) {
      this.covered = false;
      this.clear();
      return 0;
    }
    let legible = 0;
    for (let r = 0; r < ROLES; r++) if (this.roleEm[r]! * zoom >= LEGIBLE_PX) legible |= 1 << r;
    const window = this.window;
    const inside =
      this.covered &&
      vx0 >= window[0]! &&
      vy0 >= window[1]! &&
      vx1 <= window[2]! &&
      vy1 <= window[3]!;
    const regenerate =
      force || !inside || legible !== this.legible || this.atlas.generation !== this.generation;
    if (!regenerate) return this.glyphCount;

    const halfW = (vx1 - vx0) / 2;
    const halfH = (vy1 - vy0) / 2;
    window[0] = vx0 - halfW;
    window[1] = vy0 - halfH;
    window[2] = vx1 + halfW;
    window[3] = vy1 + halfH;
    this.covered = true;
    this.legible = legible;
    if (this.atlas.generation !== this.generation) {
      this.cells.fill(UNRESOLVED);
      this.generation = this.atlas.generation;
    }
    if (legible === 0) {
      this.clear();
      return 0;
    }
    return this.generate(prepared, this.runs ?? this.build(prepared), layout, legible);
  }

  /** Build and keep the bound netlist's runs, every grapheme's cell unresolved. */
  private build(prepared: Prepared): Runs {
    const runs = textRuns(prepared);
    this.runs = runs;
    this.cells = new Uint32Array(runs.graphemes.length).fill(UNRESOLVED);
    return runs;
  }

  /** Write the glyph instances of legible runs in the window. */
  private generate(prepared: Prepared, runs: Runs, layout: Mirror, legible: number): number {
    const bases = layoutBases(prepared);
    const positions = layout.f32;
    const { anchor, index, role, offset, em, width, textId, glyphStart } = runs;
    const [wx0, wy0, wx1, wy1] = this.window;
    const roleGlyphs = this.roleGlyphs;
    roleGlyphs.fill(0);
    if (this.eligible.length < runs.count) this.eligible = new Uint32Array(runs.count);
    const eligible = this.eligible;

    let found = 0;
    for (let run = 0; run < runs.count; run++) {
      const r = role[run]!;
      if ((legible & (1 << r)) === 0) continue;
      const i = index[run]!;
      let ax: number;
      let ay: number;
      switch (anchor[run]) {
        case ANCHOR_BLOCK:
          ax = positions[2 * i]!;
          ay = positions[2 * i + 1]!;
          break;
        case ANCHOR_PORT: {
          const block = prepared.portBlock[i]!;
          ax = positions[2 * block]! + prepared.portOffset[2 * i]!;
          ay = positions[2 * block + 1]! + prepared.portOffset[2 * i + 1]!;
          break;
        }
        case ANCHOR_NET:
          ax = positions[bases.anchor + 2 * i]!;
          ay = positions[bases.anchor + 2 * i + 1]!;
          break;
        default:
          ax = positions[bases.group + 4 * i]!;
          ay = positions[bases.group + 4 * i + 1]!;
      }
      const x0 = ax + offset[2 * run]!;
      const y0 = ay + offset[2 * run + 1]!;
      // Written so a NaN anchor fails every comparison and stays out.
      if (!(x0 <= wx1 && y0 <= wy1 && x0 + width[run]! >= wx0 && y0 + LINE * em[run]! >= wy0)) {
        continue;
      }
      eligible[found++] = run;
      const t = textId[run]!;
      roleGlyphs[r] += glyphStart[t + 1]! - glyphStart[t]!;
    }

    let total = 0;
    for (let r = 0; r < ROLES; r++) total += roleGlyphs[r]!;
    let keep = legible;
    for (let d = 0; d < DROP.length && total > GLYPH_CAP; d++) {
      const r = DROP[d]!;
      if ((keep & (1 << r)) === 0) continue;
      keep &= ~(1 << r);
      total -= roleGlyphs[r]!;
    }
    return this.write(runs, eligible, found, keep, Math.min(total, GLYPH_CAP));
  }

  /** Write the glyphs of the first `found` eligible runs whose role is kept, up to `limit`. */
  private write(
    runs: Runs,
    eligible: Uint32Array,
    found: number,
    keep: number,
    limit: number,
  ): number {
    const mirror = this.mirror;
    mirror.resize(limit * GLYPH_WORDS);
    const { f32, u32 } = mirror;
    const { anchor, index, role, offset, em, textId, glyphStart, glyphs, graphemes, wide } = runs;
    const atlas = this.atlas;
    const cells = this.cells;
    // The rasterizer centers a glyph in its cell (a wide one in two), so a glyph's quad is its
    // advance box grown by the cell margin on each side.
    const cellEm = atlas.cellWidth / atlas.fontPx;
    const cellLineEm = atlas.cellHeight / atlas.fontPx;
    let n = 0;
    outer: for (let k = 0; k < found; k++) {
      const run = eligible[k]!;
      const r = role[run]!;
      if ((keep & (1 << r)) === 0) continue;
      const size = em[run]!;
      const advance = ADVANCE * size;
      const margin = (advance - cellEm * size) / 2;
      const top = offset[2 * run + 1]! + ((LINE - cellLineEm) * size) / 2;
      let x = offset[2 * run]!;
      const t = textId[run]!;
      for (let g = glyphStart[t]!; g < glyphStart[t + 1]!; g++) {
        const id = glyphs[g]!;
        const span = wide[id]! + 1;
        let cell = cells[id]!;
        if (cell === UNRESOLVED) cell = cells[id] = atlas.cell(graphemes[id]!);
        if (cell !== 0) {
          if (n === limit) break outer;
          const at = n * GLYPH_WORDS;
          u32[at] = anchor[run]!;
          u32[at + 1] = index[run]!;
          f32[at + 2] = x + span * margin;
          f32[at + 3] = top;
          f32[at + 4] = size;
          u32[at + 5] = cell;
          u32[at + 6] = r;
          u32[at + 7] = 0;
          n++;
        }
        x += span * advance;
      }
    }
    mirror.resize(n * GLYPH_WORDS);
    mirror.touch(0, n * GLYPH_WORDS);
    this.glyphCount = n;
    return n;
  }

  /** No glyphs. */
  private clear(): void {
    this.glyphCount = 0;
    this.mirror.resize(0);
  }
}
