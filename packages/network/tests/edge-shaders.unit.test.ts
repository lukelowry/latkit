import { describe, expect, it } from 'vitest';
import edgeSrc from '../src/shaders/passes/edge-segment.wgsl?raw';

describe('edge shader contract', () => {
  it('guards the edge-id storage lookup behind the visibility-channel flag', () => {
    expect(edgeSrc).toContain(
      [
        '  if ((u.item_flags & ITEM_EDGE_VISIBLE) != 0u) {',
        '    if (!edge_visible(segment_edge_id(inst))) { return culled_edge(); }',
        '  }',
        '  let seg = segment_record(inst);',
      ].join('\n'),
    );
    expect(edgeSrc.match(/segment_edge_id\(inst\)/g)).toHaveLength(1);
  });
});
