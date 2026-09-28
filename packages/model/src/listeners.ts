/** The listeners of one event: a series' or a recording's `change`. */
export interface Listeners {
  /** Add a listener; the return removes it. */
  on(listener: () => void): () => void;
  /** Tell every listener in turn; one that throws rethrows on a microtask, and the rest are told. */
  emit(): void;
  /** Remove every listener. */
  clear(): void;
}

/** Listeners of one event, told in the order they were added. */
export function listeners(): Listeners {
  const set = new Set<() => void>();
  return {
    on(listener) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit() {
      for (const listener of [...set]) {
        try {
          listener();
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
    clear: () => set.clear(),
  };
}
