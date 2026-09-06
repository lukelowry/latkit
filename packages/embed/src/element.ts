/**
 * The shell both elements share: a shadow canvas that fills the host, a slot for fallback
 * content, a data source (`data` property, `src` attribute, or inline JSON), lazy activation
 * near the viewport, attribute application, and event forwarding. The controller does the rest.
 */

import { describe, quote } from './json.js';

/** Where the element stands with its data source. */
export type State = 'idle' | 'loading' | 'ready' | 'error';

/** The controller surface the shell drives; `Network` and `Monitor` both satisfy it. */
export interface Controller {
  readonly attached: boolean;
  on(event: never, handler: (payload: never) => void): () => void;
  attach(canvas: HTMLCanvasElement): Promise<void>;
  detach(): void;
  pause(): void;
  resume(): void;
}

/** What one element kind gives the shell: how to create, parse, load, and configure. */
export interface ElementSpec<C extends Controller, D> {
  /** ARIA role of the shadow canvas. */
  readonly role: string;
  /** Observed attributes, in the order they are applied after a load. */
  readonly attributes: readonly string[];
  /** Controller events forwarded as DOM events of the same name. */
  readonly events: readonly string[];
  create(host: HTMLElement, warn: Warn): C;
  parse(json: unknown): D;
  validate(data: unknown): D;
  load(context: Context<C, D>): void;
  apply(context: Context<C, D>, name: string, value: string | null): void;
}

/** One element's controller and data as an attribute is applied. */
export interface Context<C, D> {
  readonly host: HTMLElement;
  readonly controller: C;
  readonly data: D | null;
  readonly warn: Warn;
}

export type Warn = (message: string, error?: unknown) => void;

/** Platform seams the shell reaches through; tests replace them. */
export interface ShellDeps {
  fetch(url: URL, init: { readonly signal: AbortSignal }): Promise<Response>;
  observeNear(host: HTMLElement, update: (near: boolean) => void): () => void;
  warn: Warn;
}

/** The public surface every element shares; `NetworkElement` and `MonitorElement` add their controller. */
export interface ShellElement<D> extends HTMLElement {
  /** Direct decoded input. Null returns to `src` or inline JSON. */
  data: D | null;
  /** Settles with the latest data source: resolved once loaded, rejected when it failed. */
  readonly ready: Promise<void>;
  /** Where the element stands with its data source, also reflected as the `state` attribute. */
  readonly state: State;
}

type Source =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'src'; readonly value: string }
  | { readonly kind: 'inline' };

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const STYLE = `
:host { display: block; position: relative; contain: content; }
:host([hidden]) { display: none; }
canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
:host(:not([attached])) canvas { visibility: hidden; }
:host([attached]) ::slotted(*) { display: none !important; }
`;

/** Build one element class against the current HTMLElement realm. */
export function defineShell<C extends Controller, D>(
  Base: typeof HTMLElement,
  spec: ElementSpec<C, D>,
  deps: ShellDeps,
  property: string,
): CustomElementConstructor {
  class Shell extends Base implements ShellElement<D> {
    static readonly observedAttributes = ['src', 'aria-label', ...spec.attributes];

    static {
      // The friendly name (`network`, `monitor`) is the only public route to the controller.
      Object.defineProperty(this.prototype, property, {
        configurable: true,
        enumerable: true,
        get(this: Shell): C {
          return this.#ensureController();
        },
      });
    }

    readonly #canvas: HTMLCanvasElement;
    #controller: C | null = null;
    #directData: D | null = null;
    #data: D | null = null;
    #run: AbortController | null = null;
    #readiness = deferred();
    #readySettled = false;
    #stopNear: (() => void) | null = null;
    #near = false;
    #attaching = false;
    #attachFailed = false;
    readonly #pending = new Set<string>();
    #flushQueued = false;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
      const style = this.ownerDocument.createElement('style');
      style.textContent = STYLE;
      this.#canvas = this.ownerDocument.createElement('canvas');
      this.#canvas.setAttribute('part', 'canvas');
      this.#canvas.setAttribute('role', spec.role);
      root.append(style, this.#canvas, this.ownerDocument.createElement('slot'));
      this.#upgradeDataProperty();
    }

    get data(): D | null {
      return this.#directData;
    }

    set data(value: D | null) {
      this.#directData = value;
      this.#replaceSource();
    }

    get ready(): Promise<void> {
      return this.#readiness.promise;
    }

    get state(): State {
      return (this.getAttribute('state') as State | null) ?? 'idle';
    }

    connectedCallback(): void {
      if (!this.hasAttribute('state')) this.setAttribute('state', 'idle');
      this.#attachFailed = false;
      this.#stopNear?.();
      this.#stopNear = deps.observeNear(this, (near) => this.#setNear(near));
    }

    disconnectedCallback(): void {
      this.#stopNear?.();
      this.#stopNear = null;
      this.#near = false;
      this.#controller?.detach();
    }

    attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
      if (name === 'src') {
        if (previous !== next && this.#directData === null) this.#replaceSource();
        return;
      }
      if (name === 'aria-label') {
        if (next === null) this.#canvas.removeAttribute('aria-label');
        else this.#canvas.setAttribute('aria-label', next);
        return;
      }
      this.#pending.add(name);
      if (this.#flushQueued) return;
      this.#flushQueued = true;
      queueMicrotask(() => this.#flush());
    }

    /** Honor a `data` value a framework assigned before the element was upgraded. */
    #upgradeDataProperty(): void {
      if (!Object.hasOwn(this, 'data')) return;
      const value = (this as unknown as { data: D | null }).data;
      delete (this as unknown as { data?: D | null }).data;
      this.data = value;
    }

    #ensureController(): C {
      if (this.#controller) return this.#controller;
      const controller = spec.create(this, deps.warn);
      this.#controller = controller;
      controller.on(
        'attached' as never,
        ((attached: boolean) => {
          this.toggleAttribute('attached', attached);
          this.#dispatch('attached', attached);
        }) as never,
      );
      for (const event of spec.events) {
        if (event === 'attached') continue;
        controller.on(
          event as never,
          ((payload: unknown) => {
            this.#dispatch(event, payload);
            if (event === 'deviceLost' && !(payload as { recovering: boolean }).recovering) {
              this.#fail(new Error(`@latkit/embed: ${(payload as { message: string }).message}`));
            }
          }) as never,
        );
      }
      this.#applyAll();
      return controller;
    }

    #context(): Context<C, D> {
      return {
        host: this,
        controller: this.#ensureController(),
        data: this.#data,
        warn: deps.warn,
      };
    }

    #flush(): void {
      this.#flushQueued = false;
      const names = [...this.#pending];
      this.#pending.clear();
      if (!this.#controller) return;
      const context = this.#context();
      for (const name of names) this.#applyOne(context, name);
    }

    /** Apply every present attribute in the spec's order. */
    #applyAll(): void {
      const context = this.#context();
      for (const name of spec.attributes) {
        if (this.hasAttribute(name)) this.#applyOne(context, name);
      }
    }

    #applyOne(context: Context<C, D>, name: string): void {
      try {
        spec.apply(context, name, this.getAttribute(name));
      } catch (error) {
        deps.warn(`Could not apply ${name}`, error);
      }
    }

    #setNear(near: boolean): void {
      if (!this.isConnected) return;
      this.#near = near;
      if (!near) {
        this.#controller?.pause();
        return;
      }
      if (!this.#run) this.#activate();
      this.#ensureAttached();
      this.#ensureController().resume();
    }

    #ensureAttached(): void {
      const controller = this.#ensureController();
      if (
        !this.isConnected ||
        !this.#near ||
        controller.attached ||
        this.#attaching ||
        this.#attachFailed
      ) {
        return;
      }
      this.#attaching = true;
      controller.attach(this.#canvas).then(
        () => {
          this.#attaching = false;
        },
        (error: unknown) => {
          this.#attaching = false;
          if (isAbortError(error)) return;
          this.#attachFailed = true;
          this.#fail(error);
        },
      );
    }

    /** Forget the current source; the next approach to the viewport resolves the new one. */
    #replaceSource(): void {
      this.#run?.abort(superseded());
      this.#run = null;
      this.#data = null;
      if (this.isConnected && this.#near) this.#activate();
    }

    #activate(): void {
      const run = new AbortController();
      this.#run = run;
      if (this.#readySettled) {
        this.#readiness = deferred();
        this.#readySettled = false;
      }
      const source = this.#source();
      if (!source) {
        this.#setState('idle');
        return;
      }
      this.#setState('loading');
      this.#resolve(source, run.signal).then(
        (data) => {
          if (run !== this.#run) return;
          this.#data = data;
          try {
            spec.load(this.#context());
            this.#applyAll();
          } catch (error) {
            this.#fail(error);
            return;
          }
          this.#setState('ready');
          this.#readySettled = true;
          this.#readiness.resolve();
          this.#dispatch('load');
        },
        (error: unknown) => {
          if (run !== this.#run || run.signal.aborted) return;
          this.#fail(error);
        },
      );
    }

    #source(): Source | null {
      if (this.#directData !== null) return { kind: 'data', value: this.#directData };
      const src = this.getAttribute('src');
      if (src !== null) return { kind: 'src', value: src };
      if (inlineScript(this)) return { kind: 'inline' };
      return null;
    }

    async #resolve(source: Source, signal: AbortSignal): Promise<D> {
      switch (source.kind) {
        case 'data':
          try {
            return spec.validate(source.value);
          } catch (cause) {
            throw new Error(`@latkit/embed: invalid data property: ${describe(cause)}`, { cause });
          }
        case 'src': {
          let url: URL;
          try {
            url = new URL(source.value, this.baseURI);
          } catch (cause) {
            throw new Error(`@latkit/embed: invalid src URL ${quote(source.value)}`, { cause });
          }
          const response = await deps.fetch(url, { signal });
          if (!response.ok) {
            throw new Error(`@latkit/embed: ${url.href} returned HTTP ${response.status}`);
          }
          const json: unknown = await response.json();
          signal.throwIfAborted();
          return spec.parse(json);
        }
        case 'inline': {
          const script = inlineScript(this)!;
          let json: unknown;
          try {
            json = JSON.parse(script.textContent ?? '');
          } catch (cause) {
            throw new Error('@latkit/embed: inline JSON is invalid', { cause });
          }
          return spec.parse(json);
        }
        default:
          source satisfies never;
          throw new Error('@latkit/embed: unreachable source');
      }
    }

    #fail(error: unknown): void {
      this.#setState('error');
      if (!this.#readySettled) {
        this.#readySettled = true;
        this.#readiness.reject(error);
      }
      deps.warn('activation failed', error);
      this.#dispatch('error', { error });
    }

    #setState(state: State): void {
      if (this.getAttribute('state') !== state) this.setAttribute('state', state);
    }

    #dispatch(type: string, detail?: unknown): void {
      const view = this.ownerDocument.defaultView;
      const event =
        detail === undefined
          ? new (view?.Event ?? Event)(type, { bubbles: true, composed: true })
          : new (view?.CustomEvent ?? CustomEvent)(type, {
              detail,
              bubbles: true,
              composed: true,
            });
      this.dispatchEvent(event);
    }
  }

  return Shell;
}

/** Observe first approach to the viewport and later visibility changes. */
export function observeNear(host: HTMLElement, update: (near: boolean) => void): () => void {
  const Observer = globalThis.IntersectionObserver;
  if (!Observer) {
    let active = true;
    queueMicrotask(() => {
      if (active) update(true);
    });
    return () => {
      active = false;
    };
  }
  const observer = new Observer(
    (entries) => {
      const entry = entries.find((candidate) => candidate.target === host);
      if (entry) update(entry.isIntersecting || entry.intersectionRatio > 0);
    },
    { rootMargin: '200px' },
  );
  observer.observe(host);
  return () => observer.disconnect();
}

/** The one direct `<script type="application/json">` child, if any. */
function inlineScript(host: HTMLElement): Element | null {
  for (const child of host.children) {
    if (child.localName === 'script' && child.getAttribute('type') === 'application/json') {
      return child;
    }
  }
  return null;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody has to await `ready`; an unobserved failure must not become an unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function superseded(): DOMException {
  return new DOMException('The source was replaced.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
