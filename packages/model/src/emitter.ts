/**
 * Creates a minimal typed pub/sub dispatcher over a payload map.
 *
 * Handlers are invoked synchronously for each emission. Handler exceptions are
 * rethrown in a microtask so one bad listener cannot stop later listeners.
 */
type StoredHandler = (payload: unknown) => void;

/** The dispatcher {@link createEmitter} returns. */
export interface Emitter<E extends object> {
  /** Register a handler for one event and return its disposer. */
  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void;
  /** Deliver a payload to a snapshot of the current handlers for an event. */
  emit<K extends keyof E>(event: K, payload: E[K]): void;
  /** Remove all registered handlers for all events. */
  clear(): void;
}

export function createEmitter<E extends object>(): Emitter<E> {
  const listeners = new Map<keyof E, Set<StoredHandler>>();
  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler as StoredHandler);
      return () => {
        set!.delete(handler as StoredHandler);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
