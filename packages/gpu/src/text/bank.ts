import { BufferData } from '../memory/buffer-data.js';
import type { Occupancy } from '../spatial/boxes.js';
import type { Bounds2D } from '../view/camera.js';
import type { Point } from '../view/view.js';
import type { TextAlign, TextBaseline, TextLayout, TextRun } from './text.js';

/** Where a placed text belongs to the view: the slot it names, and its depth. */
export interface TextPlacement {
  readonly slot?: number;
  readonly depth?: number;
}
/** A place to try: a point, and which side and height of the text it names. */
export type TextCandidate = readonly [
  x: number,
  y: number,
  align: TextAlign,
  baseline: TextBaseline,
];

/** Where a layout's origin goes so `at` lands on its `align` side and `baseline`. */
export function textOrigin(
  layout: TextLayout,
  at: Point,
  align: TextAlign = layout.align,
  baseline: TextBaseline = 'top',
): [number, number] {
  const last = layout.baseline + Math.max(0, layout.runs.length - 1) * layout.lineHeight;
  const x = align === 'center' ? layout.width / 2 : align === 'end' ? layout.width : 0;
  const y =
    baseline === 'top'
      ? 0
      : baseline === 'bottom'
        ? layout.height
        : baseline === 'alphabetic'
          ? layout.baseline
          : (layout.baseline - layout.capHeight + last) / 2;
  return [at[0] - x, at[1] - y];
}
/** The box a layout covers with its origin at `origin`, grown by `margin`. */
export function textBox(layout: TextLayout, origin: Point, margin = 0): Bounds2D {
  return [
    origin[0] - margin,
    origin[1] - margin,
    origin[0] + layout.width + margin,
    origin[1] + layout.height + margin,
  ];
}

/** Anchors per page: runs past it start another. */
const PAGE = 1024;
/**
 * One page of a bank: its runs, and an anchor for each placed text, which `latkitAnchor` reads:
 * its origin less the page's, its depth, and its slot plus one, so a zero last lane hides it.
 */
export interface TextBankPage {
  readonly runs: readonly TextRun[];
  readonly anchors: BufferData;
  /** Anchors are relative to it, which keeps float32 positions precise far from zero. */
  readonly origin: readonly [number, number];
  /** What the page's shown text covers. */
  readonly bounds: Bounds2D;
  /** Its largest text size, so a view can skip text too small to read. */
  readonly maxSize: number;
}
interface Page {
  runs: TextRun[];
  published: readonly TextRun[];
  values: Float32Array;
  /** Each anchor's text width and height, for its page's bounds. */
  sizes: number[];
  count: number;
  data: BufferData;
  origin: [number, number];
  maxSize: number;
  bounds: Bounds2D;
  changed: boolean;
}
/**
 * Text a view draws, by key. A key's runs are laid into a page once and keep their identity while
 * its layout does, so its glyphs are prepared once and later frames only move or hide anchors.
 */
export class TextBank {
  private readonly pages: Page[] = [];
  private readonly entries = new Map<unknown, { page: Page; anchor: number; layout: TextLayout }>();
  /** Anchors whose key took another layout: hidden runs that compaction drops. */
  private stale = 0;
  private readonly label: string;
  private readonly local: boolean;
  /**
   * `local` pages keep anchors about the first text placed on them, for views in world units;
   * otherwise anchors are absolute, as for text placed in screen pixels.
   */
  constructor(options: { readonly label: string; readonly local?: boolean }) {
    this.label = options.label;
    this.local = options.local ?? false;
  }
  /** Show `key`'s text with its origin at `origin`. */
  add(key: unknown, layout: TextLayout, origin: Point, placement: TextPlacement = {}): void {
    if (!layout.runs.length) return;
    let entry = this.entries.get(key);
    if (entry?.layout !== layout) {
      if (entry) {
        this.write(entry.page, entry.anchor, 0, 0, 0, 0);
        this.stale++;
      }
      let page = this.pages.at(-1);
      if (!page || page.count >= PAGE) this.pages.push((page = this.page(origin)));
      const anchor = page.count++;
      for (const run of layout.runs) {
        page.runs.push({ ...run, anchor });
        page.maxSize = Math.max(page.maxSize, run.size);
      }
      page.sizes.push(layout.width, layout.height);
      if (page.values.length < page.count * 4) {
        const grown = new Float32Array(Math.min(PAGE, page.count * 2) * 4);
        grown.set(page.values);
        page.values = grown;
      }
      entry = { page, anchor, layout };
      this.entries.set(key, entry);
    }
    const { page, anchor } = entry;
    this.write(
      page,
      anchor,
      origin[0] - page.origin[0],
      origin[1] - page.origin[1],
      placement.depth ?? 0,
      (placement.slot ?? 0) + 1,
    );
  }
  /**
   * Show `key`'s text at the first candidate whose box, grown by `margin`, is free in `occupied`,
   * and claim that box; the origin used, or null when none is free.
   */
  place(
    key: unknown,
    layout: TextLayout,
    candidates: readonly TextCandidate[],
    occupied: Occupancy,
    options: TextPlacement & { readonly margin?: number } = {},
  ): [number, number] | null {
    for (const [x, y, align, baseline] of candidates) {
      const origin = textOrigin(layout, [x, y], align, baseline);
      if (occupied.place(textBox(layout, origin, options.margin ?? 2))) {
        this.add(key, layout, origin, options);
        return origin;
      }
    }
    return null;
  }
  /** Hide every text, as a frame starts placing again. */
  hide(): void {
    for (const page of this.pages)
      for (let anchor = 0; anchor < page.count; anchor++)
        if (page.values[anchor * 4 + 3] !== 0) this.write(page, anchor, 0, 0, 0, 0);
  }
  /** Forget every key and page, as when what the keys name has changed. */
  clear(): void {
    this.pages.length = 0;
    this.entries.clear();
    this.stale = 0;
  }
  /** Every page, its runs and anchors as last placed. */
  flush(): readonly TextBankPage[] {
    if (this.stale > Math.max(PAGE, this.entries.size)) this.compact();
    for (const page of this.pages) {
      if (page.published.length !== page.runs.length) page.published = [...page.runs];
      if (!page.changed) continue;
      page.changed = false;
      // At least one anchor, as an array<vec4f> binding needs.
      page.data.update(page.values.subarray(0, Math.max(1, page.count) * 4));
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let anchor = 0; anchor < page.count; anchor++) {
        const at = anchor * 4;
        if (page.values[at + 3] === 0) continue;
        const x = page.values[at] + page.origin[0],
          y = page.values[at + 1] + page.origin[1];
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x + page.sizes[anchor * 2]);
        b[3] = Math.max(b[3], y + page.sizes[anchor * 2 + 1]);
      }
      page.bounds = b as unknown as Bounds2D;
    }
    return this.pages.map(({ published, data, origin, bounds, maxSize }) => ({
      runs: published,
      anchors: data,
      origin,
      bounds,
      maxSize,
    }));
  }
  /** Lay every live key into fresh pages, where it is and as shown. */
  private compact(): void {
    const live = [...this.entries].map(([key, { page, anchor, layout }]) => {
      const at = anchor * 4,
        v = page.values;
      return {
        key,
        layout,
        origin: [v[at] + page.origin[0], v[at + 1] + page.origin[1]] as const,
        depth: v[at + 2],
        shown: v[at + 3],
      };
    });
    this.clear();
    for (const { key, layout, origin, depth, shown } of live) {
      this.add(key, layout, origin, { slot: Math.max(0, shown - 1), depth });
      if (!shown) {
        const entry = this.entries.get(key)!;
        this.write(entry.page, entry.anchor, 0, 0, 0, 0);
      }
    }
  }
  private page(origin: Point): Page {
    return {
      runs: [],
      published: [],
      values: new Float32Array(64),
      sizes: [],
      count: 0,
      data: new BufferData({ size: 16, label: this.label }),
      origin: this.local ? [origin[0], origin[1]] : [0, 0],
      maxSize: 0,
      bounds: [0, 0, 0, 0],
      changed: true,
    };
  }
  private write(page: Page, anchor: number, x: number, y: number, depth: number, shown: number) {
    const at = anchor * 4,
      v = page.values;
    if (
      v[at] === Math.fround(x) &&
      v[at + 1] === Math.fround(y) &&
      v[at + 2] === Math.fround(depth) &&
      v[at + 3] === shown
    )
      return;
    v[at] = x;
    v[at + 1] = y;
    v[at + 2] = depth;
    v[at + 3] = shown;
    page.changed = true;
  }
}
