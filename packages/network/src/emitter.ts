/**
 * Creates a minimal typed pub/sub dispatcher.
 *
 * Handlers are invoked synchronously for each emission. Handler exceptions are
 * rethrown in a microtask so one bad listener cannot stop later listeners.
 */
type StoredHandler = (...args: unknown[]) => void;

export function createEmitter<E extends { [Key in keyof E]: (...args: never[]) => unknown }>() {
  const listeners = new Map<keyof E, Set<StoredHandler>>();
  return {
    /** Register a handler for one event and return its disposer. */
    on<K extends keyof E>(event: K, handler: E[K]): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler as unknown as StoredHandler);
      return () => {
        set!.delete(handler as unknown as StoredHandler);
      };
    },
    /** Deliver a payload to a snapshot of the current handlers for an event. */
    emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          (handler as unknown as (...values: Parameters<E[K]>) => unknown)(...args);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
    /** Remove all registered handlers for all events. */
    clear(): void {
      listeners.clear();
    },
  };
}
