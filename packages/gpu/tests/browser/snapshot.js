/** Browser fixture renderer using the same explicit snapshot lifecycle as production views. */
export function renderer(prepare, encode, submitted = () => {}) {
  return {
    capture: () => ({
      prepare: async (frame) => {
        await prepare(frame);
        return { encode, submitted: () => submitted(frame), discard() {} };
      },
      release() {},
    }),
    destroy() {},
  };
}
