import type { Uniforms } from './webgpu/uniforms.js';
import {
  FLAG_FOCUS_ENABLED,
  FLAG_FOCUS_HOVER_ENDPOINTS,
  FLAG_FOCUS_SELECTED_ENDPOINTS,
} from './webgpu/uniforms.js';

/** Four normalized color channels in RGBA order, each expected in [0, 1]. */
export type RGBA = readonly [number, number, number, number];

/** Controls whether edge endpoint underlays are emitted for focus state. */
export type FocusEndpointMode = 'off' | 'selected' | 'hover-selected';

type FocusKind = 'vertex' | 'edge';

/** Visual focus settings encoded into the focus uniform block. */
export interface FocusStyle {
  /** Whether hover and selection highlighting is enabled. */
  enabled: boolean;
  /** Hover underlay color as normalized RGBA. */
  hoverColor: RGBA;
  /** Selection underlay color as normalized RGBA. */
  selectedColor: RGBA;
  /** Extra multiplier applied to the hover color alpha channel. */
  hoverAlpha: number;
  /** Extra multiplier applied to the selected color alpha channel. */
  selectedAlpha: number;
  /** Additional hover radius around focused vertices, in CSS px. */
  vertexHoverPx: number;
  /** Additional selection radius around focused vertices, in CSS px. */
  vertexSelectedPx: number;
  /** Additional hover half-width around focused edges, in CSS px. */
  edgeHoverPx: number;
  /** Additional selection half-width around focused edges, in CSS px. */
  edgeSelectedPx: number;
  /** Endpoint underlay mode for focused edges. */
  endpointMode: FocusEndpointMode;
}

/**
 * Owns hover/selection state and its uniform encoding. Loop-agnostic and
 * callback-free by design: mutators return whether anything changed, and
 * the orchestrator decides what a change means (wake the loop, notify the
 * host). Indices are positions in the current topology; the orchestrator
 * clears both on every load.
 */
export class FocusState {
  private hoverKind: FocusKind | null = null;
  private hoverIndex = -1;
  private selV = -1;
  private selE = -1;
  private style: FocusStyle;

  constructor(
    private readonly u: Uniforms,
    /** Maps an edge index to its two endpoint vertex indices, or [-1, -1]. */
    private readonly edgeEndpoints: (edge: number) => readonly [number, number],
    initialStyle: FocusStyle,
  ) {
    this.style = initialStyle;
    this.writeStyle();
    this.writeEndpoints();
  }

  /** Currently selected vertex index, or -1 when selection is not a vertex. */
  get selectedVertex(): number {
    return this.selV;
  }
  /** Currently selected edge index, or -1 when selection is not an edge. */
  get selectedEdge(): number {
    return this.selE;
  }

  /** Replace the visual style and rewrite all style-dependent uniforms. */
  setStyle(style: FocusStyle): void {
    this.style = style;
    this.writeStyle();
    this.writeEndpoints();
  }

  /** Returns whether the hover actually changed. */
  setHover(kind: FocusKind | null, index = -1): boolean {
    const nextIndex = kind === null ? -1 : index;
    if (kind === this.hoverKind && nextIndex === this.hoverIndex) return false;
    this.hoverKind = kind;
    this.hoverIndex = nextIndex;
    this.u.focus.hoverVertex = kind === 'vertex' ? nextIndex : -1;
    this.u.focus.hoverEdge = kind === 'edge' ? nextIndex : -1;
    this.writeEndpoints();
    return true;
  }

  /** Returns whether the selection actually changed. */
  select(kind: FocusKind | null, index = -1): boolean {
    const nextV = kind === 'vertex' ? index : -1;
    const nextE = kind === 'edge' ? index : -1;
    if (nextV === this.selV && nextE === this.selE) return false;
    this.selV = nextV;
    this.selE = nextE;
    this.u.focus.selectedVertex = nextV;
    this.u.focus.selectedEdge = nextE;
    this.writeEndpoints();
    return true;
  }

  private writeStyle(): void {
    const style = this.style;
    this.u.focus.hoverColor = packRgb(style.hoverColor);
    this.u.focus.selectedColor = packRgb(style.selectedColor);
    this.u.focus.flags = styleFlags(style);
    this.u.focus.hoverAlpha = clamp01(style.hoverAlpha * clamp01(style.hoverColor[3]));
    this.u.focus.selectedAlpha = clamp01(style.selectedAlpha * clamp01(style.selectedColor[3]));
    this.u.focus.vertexHoverUnderlayPx = nonNegative(style.vertexHoverPx);
    this.u.focus.vertexSelectedUnderlayPx = nonNegative(style.vertexSelectedPx);
    this.u.focus.edgeHoverUnderlayPx = nonNegative(style.edgeHoverPx);
    this.u.focus.edgeSelectedUnderlayPx = nonNegative(style.edgeSelectedPx);
  }

  private writeEndpoints(): void {
    const mode = this.style.endpointMode;
    const [hoverA, hoverB] =
      mode === 'hover-selected' && this.hoverKind === 'edge'
        ? this.edgeEndpoints(this.hoverIndex)
        : NO_ENDPOINTS;
    const [selectedA, selectedB] =
      (mode === 'selected' || mode === 'hover-selected') && this.selE >= 0
        ? this.edgeEndpoints(this.selE)
        : NO_ENDPOINTS;
    this.u.focus.setEndpointIds(hoverA, hoverB, selectedA, selectedB);
  }
}

/** Sentinel endpoint tuple used when no edge endpoints should be highlighted. */
const NO_ENDPOINTS: readonly [number, number] = [-1, -1];

/** Clamp finite numbers to [0, 1]; non-finite input becomes 0. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Clamp finite numbers to [0, infinity); non-finite input becomes 0. */
function nonNegative(v: number): number {
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** Pack normalized RGB channels into the little-endian 24-bit shader word. */
function packRgb(color: RGBA): number {
  const r = Math.round(clamp01(color[0]) * 255) & 0xff;
  const g = Math.round(clamp01(color[1]) * 255) & 0xff;
  const b = Math.round(clamp01(color[2]) * 255) & 0xff;
  return r | (g << 8) | (b << 16);
}

/** Convert endpoint style choices into the shader focus flag bitfield. */
function styleFlags(style: FocusStyle): number {
  if (!style.enabled) return 0;
  let flags = FLAG_FOCUS_ENABLED;
  if (style.endpointMode === 'selected' || style.endpointMode === 'hover-selected') {
    flags |= FLAG_FOCUS_SELECTED_ENDPOINTS;
  }
  if (style.endpointMode === 'hover-selected') {
    flags |= FLAG_FOCUS_HOVER_ENDPOINTS;
  }
  return flags;
}
