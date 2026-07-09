import { describe, expect, it } from 'vitest';
import { FocusState, type FocusStyle } from '../src/focus-state.js';
import { createUniforms } from '../src/webgpu/uniforms.js';

const W_HOVER_ENDPOINT_A = 68;
const W_HOVER_ENDPOINT_B = 69;
const W_SELECTED_ENDPOINT_A = 70;
const W_SELECTED_ENDPOINT_B = 71;

const STYLE: FocusStyle = {
  enabled: true,
  hoverColor: [1, 0, 0, 1],
  selectedColor: [0, 1, 0, 1],
  hoverAlpha: 0.5,
  selectedAlpha: 0.8,
  vertexHoverPx: 6,
  vertexSelectedPx: 7,
  edgeHoverPx: 3.5,
  edgeSelectedPx: 5,
  endpointMode: 'selected',
};

function make(style: Partial<FocusStyle> = {}) {
  const uniforms = createUniforms();
  // Edge 7 runs between vertices 3 and 4; everything else is unknown.
  const focus = new FocusState(uniforms, (edge) => (edge === 7 ? [3, 4] : [-1, -1]), {
    ...STYLE,
    ...style,
  });
  return { uniforms, focus };
}

describe('FocusState', () => {
  it('encodes the style into the focus uniforms at construction', () => {
    const { uniforms } = make();
    expect(uniforms.focus.hoverColor).toBe(0x0000ff); // red packed low byte
    expect(uniforms.focus.selectedColor).toBe(0x00ff00);
    expect(uniforms.focus.hoverAlpha).toBeCloseTo(0.5);
    expect(uniforms.focus.edgeSelectedUnderlayPx).toBe(5);
  });

  it('reports hover changes and writes the hovered ids', () => {
    const { uniforms, focus } = make();
    expect(focus.setHover('vertex', 12)).toBe(true);
    expect(uniforms.focus.hoverVertex).toBe(12);
    expect(uniforms.focus.hoverEdge).toBe(-1);

    expect(focus.setHover('vertex', 12)).toBe(false); // same target
    expect(focus.setHover(null)).toBe(true);
    expect(uniforms.focus.hoverVertex).toBe(-1);
  });

  it('writes selected-edge endpoints in selected mode and clears them on deselect', () => {
    const { uniforms, focus } = make();
    expect(focus.select('edge', 7)).toBe(true);
    const i32 = uniforms.rawI32;
    expect([i32[W_SELECTED_ENDPOINT_A], i32[W_SELECTED_ENDPOINT_B]]).toEqual([3, 4]);

    expect(focus.select(null)).toBe(true);
    expect([i32[W_SELECTED_ENDPOINT_A], i32[W_SELECTED_ENDPOINT_B]]).toEqual([-1, -1]);
    expect(focus.select(null)).toBe(false);
  });

  it('hover endpoints appear only in hover-selected mode', () => {
    const { uniforms, focus } = make({ endpointMode: 'hover-selected' });
    focus.setHover('edge', 7);
    const i32 = uniforms.rawI32;
    expect([i32[W_HOVER_ENDPOINT_A], i32[W_HOVER_ENDPOINT_B]]).toEqual([3, 4]);

    focus.setStyle({ ...STYLE, endpointMode: 'selected' });
    expect([i32[W_HOVER_ENDPOINT_A], i32[W_HOVER_ENDPOINT_B]]).toEqual([-1, -1]);
  });

  it('disabled style zeroes the focus flags', () => {
    const { uniforms } = make({ enabled: false });
    expect(uniforms.focus.flags).toBe(0);
  });
});
