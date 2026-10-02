import type { kit } from '@latkit/gpu';

export function renderer(
  prepare: (frame: kit.Preparation) => void | Promise<void>,
  encode: (frame: kit.Encoding) => void = () => {},
  submitted: () => void = () => {},
  discard: () => void = () => {},
): kit.Renderer {
  return {
    capture: () => ({
      prepare: async (frame) => {
        await prepare(frame);
        return { encode, submitted, discard };
      },
      release() {},
    }),
    destroy() {},
  };
}
