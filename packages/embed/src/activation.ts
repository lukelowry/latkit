import type { Network } from '@latkit/network';

import type { NetworkData } from './data/types.js';
import type { InputRevision } from './source.js';
import type { ViewState } from './view/state.js';

/** One cancellable attempt to make an input revision live. */
export class Activation {
  readonly abort = new AbortController();
  readonly ready: Promise<void>;

  data: NetworkData | null = null;
  network: Network | null = null;
  view: ViewState | null = null;
  constructionResolved = false;
  paused: boolean | null = null;
  borderRevision = 0;
  borderAbort: AbortController | null = null;
  borderRequestKey: string | object | null = null;
  naturalBordersApplied = false;
  readonly warnings = new Set<string>();

  #resolve!: () => void;
  #reject!: (error: unknown) => void;
  #started = false;
  #settled = false;
  #closed = false;
  #cleanups: Array<() => void> = [];

  constructor(readonly input: InputRevision) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.ready.catch(() => undefined);
  }

  /** Whether the activation has released its resources. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether this activation has completed every readiness step. */
  get live(): boolean {
    return this.#settled && !this.#closed;
  }

  /** Begin the activation at most once. */
  begin(): boolean {
    if (this.#closed || this.#started) return false;
    this.#started = true;
    return true;
  }

  /** Register reverse-order cleanup, running it immediately after cancellation. */
  own(cleanup: () => void): void {
    if (this.#closed) cleanup();
    else this.#cleanups.push(cleanup);
  }

  /** Resolve this activation's readiness without releasing its live resources. */
  succeed(): void {
    if (this.#closed || this.#settled) return;
    this.#settled = true;
    this.#resolve();
  }

  /** Permanently fail this activation and release everything it owns. */
  fail(error: unknown): void {
    if (!this.#closed) this.abort.abort(error);
    this.#close(error);
  }

  /** Supersede this activation without surfacing a component error. */
  cancel(): void {
    if (this.#closed) return;
    const error = abortError();
    this.abort.abort(error);
    this.#close(error);
  }

  #close(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    }
    for (let i = this.#cleanups.length - 1; i >= 0; i--) {
      try {
        this.#cleanups[i]!();
      } catch {
        // Cleanup is best-effort so one resource cannot strand the remainder.
      }
    }
    this.#cleanups.length = 0;
    this.data = null;
    this.network = null;
    this.view = null;
    this.paused = null;
    this.borderAbort?.abort(error);
    this.borderAbort = null;
    this.borderRequestKey = null;
    this.naturalBordersApplied = false;
    this.borderRevision++;
    this.warnings.clear();
  }
}

/** Create the conventional cancellation error used for superseded readiness. */
export function abortError(): DOMException {
  return new DOMException('Activation superseded', 'AbortError');
}
