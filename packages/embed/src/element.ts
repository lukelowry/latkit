import type { Colormap } from '@latkit/colormaps';
import { GpuUnavailableError } from '@latkit/gpu';
import {
  PROJECTION_MODES,
  channelNormalizes,
  createNetwork,
  validateBorders,
  validateOption,
  type Borders,
  type CameraPose,
  type Channel,
  type ChannelRange,
  type Item,
  type Network,
  type Options,
  type PoseOptions,
  type ProjectionFamily,
  type ProjectionMode,
  type RGBA,
  type RevealOptions,
} from '@latkit/network';

import { Activation, abortError } from './activation.js';
import { loadNaturalEarthBorders } from './borders.js';
import type { NetworkData } from './data/types.js';
import { devices, type DeviceLease } from './device-pool.js';
import {
  createInputRevision,
  resolveInput,
  selectSource,
  type InputRevision,
  type NetworkSource,
} from './source.js';
import { applyView } from './view/apply.js';
import {
  CHANNEL_BY_ATTRIBUTE,
  OPTION_ATTRIBUTES,
  OPTION_BY_ATTRIBUTE,
  VIEW_ATTRIBUTES,
  assertFloat32Array,
  assertProjectionMode,
  channelAttribute,
  checkedRange,
  parseOptionAttribute,
  serializeOption,
  serializeRange,
  type ViewWarning,
} from './view/attributes.js';
import { createChrome, type Chrome } from './view/chrome.js';
import { fieldsFor } from './view/fields.js';
import { createShell, type Shell } from './view/shell.js';
import {
  resolveOptionState,
  resolveView,
  validateDirectChannelLengths,
  type AttributeValues,
  type ElementConfiguration,
  type InteractionState,
  type ViewState,
} from './view/state.js';

const TAG = 'latkit-network';
const ROOT_MARGIN = '200px';
const DEVICE_RECOVERIES = 2;

const UNAVAILABLE_PROJECTIONS = Object.freeze(
  Object.fromEntries(PROJECTION_MODES.map((mode) => [mode, false])),
) as Network['projections'];

/** Item identity carried by hover and selection DOM events. */
export interface NetworkItemEventDetail {
  readonly kind: 'vertex' | 'edge' | null;
  readonly index: number | null;
}

/** Fit-state payload carried by the Network `zoom` DOM event. */
export interface NetworkZoomEventDetail {
  readonly atFitView: boolean;
}

/** Recovery payload carried by the Network `deviceLost` DOM event. */
export interface NetworkDeviceLostEventDetail {
  readonly reason: string;
  readonly message: string;
  readonly recovering: boolean;
}

/** Failure payload carried by the Network `pipelineError` DOM event. */
export interface NetworkPipelineErrorEventDetail {
  readonly pipeline: ProjectionFamily;
  readonly cause: unknown;
}

/** Public DOM events emitted by {@link NetworkElement}. */
export interface NetworkElementEventMap {
  load: Event;
  error: CustomEvent<{ readonly error: unknown }>;
  hover: CustomEvent<NetworkItemEventDetail>;
  select: CustomEvent<NetworkItemEventDetail>;
  zoom: CustomEvent<NetworkZoomEventDetail>;
  deviceLost: CustomEvent<NetworkDeviceLostEventDetail>;
  pipelineError: CustomEvent<NetworkPipelineErrorEventDetail>;
}

/** Public declarative Network element surface; construction remains owned by {@link register}. */
type ForwardedNetworkApi = Pick<
  Network,
  | 'setOptions'
  | 'setBorders'
  | 'setColormap'
  | 'setBaseColor'
  | 'setChannel'
  | 'clearChannel'
  | 'setChannelRange'
  | 'setProjection'
  | 'fit'
  | 'reveal'
  | 'select'
  | 'clearSelection'
  | 'panBy'
  | 'rotateBy'
  | 'getPose'
  | 'setPose'
  | 'zoomBy'
  | 'fadeIn'
  | 'pause'
  | 'resume'
>;

export interface NetworkElement extends HTMLElement, ForwardedNetworkApi {
  /** Direct decoded input. Null returns to src or inline source resolution. */
  data: NetworkData | null;
  /** Promise for the current activation becoming live. */
  readonly ready: Promise<void>;
  /** Projection availability for the current live topology. */
  readonly projections: Network['projections'];

  addEventListener<Key extends keyof NetworkElementEventMap>(
    type: Key,
    listener: ((this: NetworkElement, event: NetworkElementEventMap[Key]) => unknown) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<Key extends keyof NetworkElementEventMap>(
    type: Key,
    listener: ((this: NetworkElement, event: NetworkElementEventMap[Key]) => unknown) | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** Internal collaborators injected into lifecycle tests. */
export interface ElementDependencies {
  resolveInput(input: InputRevision, host: HTMLElement, signal: AbortSignal): Promise<NetworkData>;
  acquireDevice(): Promise<DeviceLease>;
  createNetwork: typeof createNetwork;
  loadNaturalEarthBorders(signal?: AbortSignal): Promise<Borders>;
  observeNear(host: HTMLElement, update: (near: boolean) => void): () => void;
  warn(message: string, error?: unknown): void;
}

interface BorderRequest {
  readonly controller: AbortController;
  readonly revision: number;
  release(): void;
}

const DEFAULT_DEPENDENCIES: ElementDependencies = {
  resolveInput,
  acquireDevice: () => devices.acquire(),
  createNetwork,
  loadNaturalEarthBorders,
  observeNear,
  warn: (message, error) => {
    if (error === undefined) console.warn(`@latkit/embed: ${message}`);
    else console.warn(`@latkit/embed: ${message}`, error);
  },
};

/** Define latkit-network in the current browser realm. */
export function register(): void {
  const registry = globalThis.customElements;
  const Base = globalThis.HTMLElement;
  if (!registry || !Base) throw new Error('@latkit/embed: register() requires a browser DOM');
  if (registry.get(TAG)) return;
  registry.define(TAG, createNetworkElementClass(Base, DEFAULT_DEPENDENCIES));
}

/** Build the private implementation class against the current HTMLElement realm. */
export function createNetworkElementClass(
  Base: typeof HTMLElement,
  dependencies: ElementDependencies,
): CustomElementConstructor {
  const NetworkElementClass = class LatkitNetworkElement extends Base {
    static readonly observedAttributes = ['src', ...VIEW_ATTRIBUTES];

    #directData: NetworkData | null = null;
    #input = createInputRevision({ kind: 'inline' });
    #activation = new Activation(this.#input);
    #configuration: ElementConfiguration = {
      customColormap: null,
      customColormapRevision: 0,
      customBorders: undefined,
      customBordersRevision: 0,
      consumerPaused: false,
      lastProjection: 'flat',
    };
    #interaction: InteractionState = {
      hover: null,
      selected: null,
      atFitView: true,
    };
    #projections: Network['projections'] = UNAVAILABLE_PROJECTIONS;
    #shell: Shell;
    #chrome: Chrome;
    #stopObserving: (() => void) | null = null;
    #observationRevision = 0;
    #near = false;
    #hasConnected = false;
    #recoveries = 0;
    #transactionDepth = 0;
    #pendingViewUpdate = false;
    #pendingActivationReplacement = false;

    constructor() {
      super();
      this.#shell = createShell(this);
      this.#chrome = createChrome(this, this.#shell);
      this.#upgradeDataProperty();
    }

    get data(): NetworkData | null {
      return this.#directData;
    }

    set data(value: NetworkData | null) {
      this.#directData = value;
      this.#replaceInput(selectSource(this, value));
    }

    get ready(): Promise<void> {
      return this.#activation.ready;
    }

    get projections(): Network['projections'] {
      return this.#projections;
    }

    connectedCallback(): void {
      if (this.#hasConnected) {
        this.#recoveries = 0;
        this.#replaceActivation();
      } else {
        this.#hasConnected = true;
      }
      this.#stopObserving?.();
      const observation = ++this.#observationRevision;
      this.#stopObserving = dependencies.observeNear(this, (near) => {
        if (observation === this.#observationRevision && this.isConnected) this.#setNear(near);
      });
    }

    disconnectedCallback(): void {
      this.#observationRevision++;
      this.#stopObserving?.();
      this.#stopObserving = null;
      this.#near = false;
      this.#activation.cancel();
      this.#projections = UNAVAILABLE_PROJECTIONS;
      this.#shell.showFallback();
      this.#chrome.reset();
    }

    attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
      const channel = CHANNEL_BY_ATTRIBUTE.get(name);
      const reassertsDirectValue =
        channel !== undefined || name === 'colormap' || name === 'border-source';

      if (channel) delete this.#input.directChannels[channel.key];
      if (name === 'colormap') this.#configuration.customColormap = null;
      if (name === 'border-source') this.#configuration.customBorders = undefined;

      if (previous === next && !reassertsDirectValue) return;
      if (name === 'src') {
        if (previous !== next && this.#directData === null) {
          this.#replaceInput(selectSource(this, null));
        }
        return;
      }

      const option = OPTION_BY_ATTRIBUTE.get(name);
      if (
        option?.definition.lifecycle === 'construction' &&
        this.#activation.constructionResolved
      ) {
        const before = parseOptionAttribute(option, previous, []);
        const after = parseOptionAttribute(option, next, []);
        if (!Object.is(before, after)) {
          this.#requestActivationReplacement();
          return;
        }
      }
      this.#requestViewUpdate();
    }

    setOptions(options: Options): void {
      if (options === null || typeof options !== 'object') {
        throw new TypeError('options must be an object');
      }

      const reflected: Array<readonly [string, string]> = [];
      for (const entry of OPTION_ATTRIBUTES) {
        if (!Object.hasOwn(options, entry.option)) continue;
        const value = options[entry.option];
        if (value === undefined) continue;
        reflected.push([entry.attribute, serializeOption(entry, value)]);
      }

      let customColormap: Colormap | undefined;
      if (Object.hasOwn(options, 'colormap') && options.colormap !== undefined) {
        validateOption('colormap', options.colormap);
        customColormap = options.colormap;
      }

      if (reflected.length === 0 && customColormap === undefined) return;

      this.#transaction(() => {
        for (const [attribute, value] of reflected) this.setAttribute(attribute, value);
        if (customColormap) {
          this.#configuration.customColormap = customColormap;
          this.#configuration.customColormapRevision++;
        }
        this.#requestViewUpdate();
      });
    }

    setBorders(borders: Borders | null): void {
      if (borders !== null) validateBorders(borders);
      this.#configuration.customBorders = borders;
      this.#configuration.customBordersRevision++;
      this.#requestViewUpdate();
    }

    setColormap(next: Colormap): void {
      validateOption('colormap', next);
      this.#configuration.customColormap = next;
      this.#configuration.customColormapRevision++;
      this.#requestViewUpdate();
    }

    setBaseColor(color: RGBA): void {
      this.setOptions({ baseColor: color });
    }

    setChannel(
      channel: Channel,
      values: Float32Array,
      domain?: ChannelRange | null,
      range?: ChannelRange,
    ): void {
      const definition = channelAttribute(channel);
      const normalizes = channelNormalizes(definition);
      assertFloat32Array(values, `${channel} values`);
      const checkedDomain =
        !normalizes || domain === undefined
          ? undefined
          : domain === null
            ? null
            : checkedRange(domain, 'domain');
      const checkedOutput =
        definition.map !== 'height' || range === undefined
          ? undefined
          : checkedRange(range, 'range');
      this.#validateKnownChannelLength(definition.scope, channel, values);

      this.#transaction(() => {
        this.setAttribute(definition.attribute, '');
        if (definition.domainAttribute) this.removeAttribute(definition.domainAttribute);
        if (definition.rangeAttribute) this.removeAttribute(definition.rangeAttribute);
        this.#input.directChannels[channel] = {
          values,
          ...(normalizes && checkedDomain !== undefined ? { baseDomain: checkedDomain } : {}),
          ...(definition.map === 'height' && checkedOutput ? { outputRange: checkedOutput } : {}),
        };
        this.#requestViewUpdate();
      });
    }

    clearChannel(channel: Channel): void {
      const definition = channelAttribute(channel);
      this.#transaction(() => {
        delete this.#input.directChannels[channel];
        this.setAttribute(definition.attribute, '');
        if (definition.domainAttribute) this.removeAttribute(definition.domainAttribute);
        if (definition.rangeAttribute) this.removeAttribute(definition.rangeAttribute);
        this.#requestViewUpdate();
      });
    }

    setChannelRange(channel: Channel, range: ChannelRange | null): void {
      const definition = channelAttribute(channel);
      if (!channelNormalizes(definition) || !definition.domainAttribute) return;
      if (range === null) this.removeAttribute(definition.domainAttribute);
      else this.setAttribute(definition.domainAttribute, serializeRange(range, `${channel} range`));
    }

    setProjection(mode: ProjectionMode): boolean {
      assertProjectionMode(mode);
      this.setAttribute('projection', mode);
      return this.#projections[mode];
    }

    fit(animate?: boolean): void;
    fit(items: readonly Item[], animate?: boolean): void;
    fit(itemsOrAnimate: readonly Item[] | boolean = false, animate = false): void {
      const network = this.#liveNetwork();
      if (!network) return;
      if (typeof itemsOrAnimate === 'boolean') network.fit(itemsOrAnimate);
      else network.fit(itemsOrAnimate, animate);
    }

    reveal(item: Item, options?: RevealOptions): boolean {
      return this.#liveNetwork()?.reveal(item, options) ?? false;
    }

    select(kind: 'vertex' | 'edge', index: number): void {
      const run = this.#activation;
      const network = this.#liveNetwork();
      if (!network || !run.data || !run.view) return;
      this.#validateSelection(run.data, kind, index);
      network.select(kind, index);
      const next = [kind, index] as const;
      const changed = !sameItem(this.#interaction.selected, next);
      run.input.selected = next;
      this.#interaction = { ...this.#interaction, selected: next };
      this.#updateChrome(run, changed);
    }

    clearSelection(): void {
      const run = this.#activation;
      const network = this.#liveNetwork();
      if (!network || !run.data || !run.view) return;
      network.clearSelection();
      const changed = this.#interaction.selected !== null;
      run.input.selected = null;
      this.#interaction = { ...this.#interaction, selected: null };
      this.#updateChrome(run, changed);
    }

    panBy(dx: number, dy: number): void {
      this.#liveNetwork()?.panBy(dx, dy);
    }

    rotateBy(dx: number, dy: number): void {
      this.#liveNetwork()?.rotateBy(dx, dy);
    }

    getPose(): CameraPose | null {
      return this.#liveNetwork()?.getPose() ?? null;
    }

    setPose(pose: Partial<CameraPose>, options?: PoseOptions): boolean {
      return this.#liveNetwork()?.setPose(pose, options) ?? false;
    }

    zoomBy(factor: number): void {
      this.#liveNetwork()?.zoomBy(factor);
    }

    fadeIn(ms?: number): void {
      this.#liveNetwork()?.fadeIn(ms);
    }

    pause(): void {
      if (this.#configuration.consumerPaused) return;
      this.#configuration.consumerPaused = true;
      this.#syncPause(this.#activation);
    }

    resume(): void {
      if (!this.#configuration.consumerPaused) return;
      this.#configuration.consumerPaused = false;
      this.#syncPause(this.#activation);
    }

    #upgradeDataProperty(): void {
      if (!Object.hasOwn(this, 'data')) return;
      const value = (this as unknown as { data: NetworkData | null }).data;
      delete (this as unknown as { data?: NetworkData | null }).data;
      this.data = value;
    }

    #replaceInput(source: NetworkSource): void {
      if (sameSource(this.#input.source, source)) return;
      this.#input = createInputRevision(source);
      this.#recoveries = 0;
      this.#interaction = { hover: null, selected: null, atFitView: true };
      this.#replaceActivation();
    }

    #installActivation(): Activation {
      const previous = this.#activation;
      const next = new Activation(this.#input);
      this.#activation = next;
      previous.cancel();
      this.#projections = UNAVAILABLE_PROJECTIONS;
      this.#interaction = {
        hover: null,
        selected: this.#input.selected,
        atFitView: true,
      };
      this.#shell.showFallback();
      this.#chrome.reset();
      return next;
    }

    #replaceActivation(): Activation {
      const next = this.#installActivation();
      if (this.isConnected && this.#near) void this.#activate(next);
      return next;
    }

    #requestActivationReplacement(): void {
      if (this.#transactionDepth > 0) {
        this.#pendingActivationReplacement = true;
        return;
      }
      this.#replaceActivation();
    }

    #setNear(near: boolean): void {
      this.#near = near;
      const run = this.#activation;
      if (!near) this.#cancelBorderRequest(run);
      if (near && !run.network) void this.#activate(run);
      else {
        this.#syncPause(run);
        if (near) this.#ensureNaturalBorders(run);
      }
    }

    async #activate(run: Activation): Promise<void> {
      if (!run.begin()) return;

      try {
        const data = await dependencies.resolveInput(run.input, this, run.abort.signal);
        this.#assertCurrent(run);
        validateDirectChannelLengths(data, run.input);
        run.data = data;

        const construction = resolveOptionState(this.#attributeValues(), this.#configuration);
        run.constructionResolved = true;
        this.#reportWarnings(run, construction.warnings);

        const lease = await dependencies.acquireDevice();
        run.own(() => lease.release());
        this.#assertCurrent(run);

        const options: Options = { ...construction.options, msaa: construction.msaa };
        const network = await dependencies.createNetwork(lease.device, this.#shell.canvas, options);
        run.own(() => network.destroy());
        this.#assertCurrent(run);
        run.network = network;
        network.pause();
        run.paused = true;

        network.load(data.topology);
        this.#projections = network.projections;
        this.#subscribeNetworkEvents(run, network);

        const next = await this.#prepareInitialBorders(run);
        this.#assertCurrent(run);
        applyView(network, null, next, construction.options);
        run.view = next;
        this.#configuration.lastProjection = next.projection;
        this.#reportWarnings(run, next.warnings);

        if (run.input.selected) network.select(...run.input.selected);
        this.#interaction = {
          hover: null,
          selected: run.input.selected,
          atFitView: true,
        };
        this.#updateChrome(run);
        network.fit();
        this.#shell.showLive(data);
        network.fadeIn();
        this.#syncPause(run);
        run.succeed();
        this.#dispatchPlainEvent('load');
      } catch (error) {
        if (run !== this.#activation || run.abort.signal.aborted) return;
        this.#fail(run, error);
      }
    }

    #subscribeNetworkEvents(run: Activation, network: Network): void {
      run.own(
        network.on('hover', (kind, index) => {
          if (!this.#isCurrent(run)) return;
          const hover = itemTuple(kind, index);
          this.#interaction = { ...this.#interaction, hover };
          this.#updateChrome(run);
          this.#dispatchDetailEvent('hover', { kind, index });
        }),
      );
      run.own(
        network.on('select', (kind, index) => {
          if (!this.#isCurrent(run)) return;
          const selected = itemTuple(kind, index);
          const changed = !sameItem(this.#interaction.selected, selected);
          run.input.selected = selected;
          this.#interaction = { ...this.#interaction, selected };
          this.#updateChrome(run, changed);
          this.#dispatchDetailEvent('select', { kind, index });
        }),
      );
      run.own(
        network.on('zoom', (atFitView) => {
          if (!this.#isCurrent(run)) return;
          this.#interaction = { ...this.#interaction, atFitView };
          this.#updateChrome(run);
          this.#dispatchDetailEvent('zoom', { atFitView });
        }),
      );
      run.own(
        network.on('deviceLost', (reason, message) => {
          this.#onDeviceLost(run, reason, message);
        }),
      );
      run.own(
        network.on('pipelineError', (pipeline, cause) => {
          if (!this.#isCurrent(run)) return;
          this.#dispatchDetailEvent('pipelineError', { pipeline, cause });
        }),
      );
    }

    async #prepareInitialBorders(run: Activation): Promise<ViewState> {
      for (;;) {
        this.#assertCurrent(run);
        const candidate = this.#resolveView(run);
        this.#reportWarnings(run, candidate.warnings);
        const key = borderKey(candidate);
        let packaged: Borders | null = null;
        let borderFailure: { readonly error: unknown } | null = null;

        if (candidate.borders.kind === 'natural-earth' && candidate.options.borders && this.#near) {
          const request = this.#beginBorderRequest(run, key);
          try {
            try {
              packaged = await dependencies.loadNaturalEarthBorders(request.controller.signal);
            } catch (error) {
              if (run.abort.signal.aborted) throw error;
              if (request.controller.signal.aborted) continue;
              borderFailure = { error };
            }
            this.#assertCurrent(run);
          } finally {
            request.release();
          }
        }

        const latest = this.#resolveView(run);
        if (key !== borderKey(latest)) continue;
        if (latest.borders.kind === 'custom') {
          run.naturalBordersApplied = false;
          run.network!.setBorders(latest.borders.data);
        } else if (
          latest.borders.kind === 'natural-earth' &&
          latest.options.borders &&
          this.#near &&
          packaged
        ) {
          run.naturalBordersApplied = true;
          run.network!.setBorders(packaged);
        } else {
          run.naturalBordersApplied = false;
          if (
            latest.borders.kind === 'natural-earth' &&
            latest.options.borders &&
            this.#near &&
            borderFailure
          ) {
            this.#warnBorderFailure(run, borderFailure.error);
          }
          run.network!.setBorders(null);
        }
        return latest;
      }
    }

    #requestViewUpdate(): void {
      if (this.#transactionDepth > 0) {
        this.#pendingViewUpdate = true;
        return;
      }
      this.#flushViewUpdate(this.#activation);
    }

    #flushViewUpdate(run: Activation): void {
      if (
        run.borderAbort &&
        !run.view &&
        run.data &&
        run.network &&
        (!this.#near || !Object.is(run.borderRequestKey, borderKey(this.#resolveView(run))))
      ) {
        this.#cancelBorderRequest(run);
      }
      this.#updateLiveView(run);
    }

    #updateLiveView(run: Activation): void {
      try {
        this.#updateView(run);
      } catch (error) {
        if (this.#isCurrent(run)) this.#fail(run, error);
      }
    }

    #updateView(run: Activation): void {
      if (!this.#isCurrent(run) || !run.data || !run.network || !run.view) return;
      const previous = run.view;
      const next = this.#resolveView(run);
      applyView(run.network, previous, next);
      run.view = next;
      this.#configuration.lastProjection = next.projection;
      this.#reportWarnings(run, next.warnings);
      this.#syncLiveBorders(run, previous, next);
      this.#updateChrome(run);
    }

    #resolveView(run: Activation): ViewState {
      return resolveView(
        run.data!,
        this.#attributeValues(),
        run.network!.projections,
        this.#configuration,
        run.input,
      );
    }

    #syncLiveBorders(run: Activation, previous: ViewState, next: ViewState): void {
      if (!borderChanged(previous, next)) return;
      const network = run.network!;
      this.#cancelBorderRequest(run);

      if (next.borders.kind === 'none') {
        run.naturalBordersApplied = false;
        network.setBorders(null);
        return;
      }
      if (next.borders.kind === 'custom') {
        run.naturalBordersApplied = false;
        network.setBorders(next.borders.data);
        return;
      }
      if (!next.options.borders) {
        if (previous.borders.kind !== 'natural-earth') {
          run.naturalBordersApplied = false;
          network.setBorders(null);
        }
        return;
      }

      if (previous.borders.kind !== 'natural-earth') {
        run.naturalBordersApplied = false;
        network.setBorders(null);
      }
      this.#ensureNaturalBorders(run);
    }

    #ensureNaturalBorders(run: Activation): void {
      const view = run.view;
      if (
        !this.#isCurrent(run) ||
        !this.#near ||
        !view ||
        view.borders.kind !== 'natural-earth' ||
        !view.options.borders ||
        run.naturalBordersApplied ||
        run.borderAbort
      ) {
        return;
      }

      const request = this.#beginBorderRequest(run, borderKey(view));
      const pending = this.#loadAndApplyNaturalBorders(run, request);
      void pending.catch((error: unknown) => {
        if (this.#isCurrent(run) && !run.abort.signal.aborted) this.#fail(run, error);
      });
    }

    async #loadAndApplyNaturalBorders(run: Activation, request: BorderRequest): Promise<void> {
      try {
        let borders: Borders | null = null;
        let failure: unknown;
        try {
          borders = await dependencies.loadNaturalEarthBorders(request.controller.signal);
        } catch (error) {
          if (request.controller.signal.aborted) return;
          failure = error;
        }
        if (!this.#isCurrent(run) || request.revision !== run.borderRevision || !this.#near) {
          return;
        }
        const view = run.view;
        if (view?.borders.kind !== 'natural-earth' || !view.options.borders) return;
        if (borders) {
          run.naturalBordersApplied = true;
          run.network!.setBorders(borders);
        } else {
          this.#warnBorderFailure(run, failure);
        }
      } finally {
        request.release();
      }
    }

    #beginBorderRequest(run: Activation, key: string | object): BorderRequest {
      this.#cancelBorderRequest(run);
      const controller = new AbortController();
      const revision = ++run.borderRevision;
      const relayAbort = () => controller.abort(run.abort.signal.reason);
      run.borderAbort = controller;
      run.borderRequestKey = key;
      if (run.abort.signal.aborted) relayAbort();
      else run.abort.signal.addEventListener('abort', relayAbort, { once: true });

      let released = false;
      return {
        controller,
        revision,
        release: () => {
          if (released) return;
          released = true;
          run.abort.signal.removeEventListener('abort', relayAbort);
          if (run.borderAbort !== controller) return;
          run.borderAbort = null;
          run.borderRequestKey = null;
        },
      };
    }

    #cancelBorderRequest(run: Activation): void {
      const controller = run.borderAbort;
      if (!controller) return;
      run.borderRevision++;
      run.borderAbort = null;
      run.borderRequestKey = null;
      controller.abort(abortError());
    }

    #warnBorderFailure(run: Activation, error: unknown): void {
      const key = 'border-source\u0000natural-earth-load';
      if (run.warnings.has(key)) return;
      run.warnings.add(key);
      dependencies.warn(
        'Natural Earth borders could not be loaded; continuing without them.',
        error,
      );
    }

    #updateChrome(run: Activation, announceSelection = false): void {
      if (!run.data || !run.view) return;
      this.#chrome.update(
        run.data,
        fieldsFor(run.data),
        run.view,
        this.#projections,
        this.#interaction,
        announceSelection,
      );
    }

    #syncPause(run: Activation): void {
      if (!this.#isCurrent(run) || !run.network) return;
      const paused = this.#configuration.consumerPaused || !this.#near;
      if (run.paused === paused) return;
      run.paused = paused;
      if (paused) run.network.pause();
      else run.network.resume();
    }

    #liveNetwork(): Network | null {
      const run = this.#activation;
      return run.live ? run.network : null;
    }

    #validateKnownChannelLength(
      scope: 'vertex' | 'edge',
      channel: Channel,
      values: Float32Array,
    ): void {
      const data = this.#activation.data ?? this.#input.decoded;
      if (!data) return;
      const expected =
        scope === 'vertex' ? data.topology.vertexCount : data.topology.edges.length / 2;
      if (values.length !== expected) {
        throw new RangeError(`network channel ${channel} length ${values.length} != ${expected}`);
      }
    }

    #validateSelection(data: NetworkData, kind: unknown, index: number): void {
      if (kind !== 'vertex' && kind !== 'edge') throw new TypeError('selection kind is invalid');
      if (typeof index !== 'number' || !Number.isFinite(index)) {
        throw new RangeError('selection index must be finite');
      }
      if (!Number.isInteger(index)) throw new RangeError('selection index must be an integer');
      const count = kind === 'vertex' ? data.topology.vertexCount : data.topology.edges.length / 2;
      if (index < 0 || index >= count) throw new RangeError('selection index is out of range');
    }

    #reportWarnings(run: Activation, warnings: readonly ViewWarning[]): void {
      for (const warning of warnings) {
        if (run.warnings.has(warning.key)) continue;
        run.warnings.add(warning.key);
        dependencies.warn(warning.message);
      }
    }

    #attributeValues(): AttributeValues {
      return new Map(VIEW_ATTRIBUTES.map((name) => [name, this.getAttribute(name)] as const));
    }

    #transaction(action: () => void): void {
      this.#transactionDepth++;
      try {
        action();
      } finally {
        this.#transactionDepth--;
        if (this.#transactionDepth === 0) {
          if (this.#pendingActivationReplacement) {
            this.#pendingActivationReplacement = false;
            this.#pendingViewUpdate = false;
            this.#replaceActivation();
          } else if (this.#pendingViewUpdate) {
            this.#pendingViewUpdate = false;
            this.#flushViewUpdate(this.#activation);
          }
        }
      }
    }

    #onDeviceLost(run: Activation, reason: string, message: string): void {
      if (!this.#isCurrent(run) || !this.isConnected) return;
      const recovering = this.#recoveries < DEVICE_RECOVERIES;
      this.#dispatchDetailEvent('deviceLost', { reason, message, recovering });
      if (!this.#isCurrent(run) || !this.isConnected) return;

      if (recovering) {
        this.#recoveries++;
        this.#replaceActivation();
        return;
      }

      const failed = this.#installActivation();
      this.#fail(failed, new Error(`@latkit/embed: WebGPU device was repeatedly lost: ${message}`));
    }

    #fail(run: Activation, error: unknown): void {
      if (run !== this.#activation) return;
      const failed = run.live ? this.#installActivation() : run;
      failed.fail(error);
      this.#projections = UNAVAILABLE_PROJECTIONS;
      this.#shell.showFallback();
      this.#chrome.reset();
      if (!(error instanceof GpuUnavailableError)) dependencies.warn('activation failed', error);
      this.#dispatchDetailEvent('error', { error });
    }

    #dispatchPlainEvent(type: 'load'): void {
      const EventConstructor = this.ownerDocument.defaultView?.Event ?? Event;
      this.dispatchEvent(new EventConstructor(type, { bubbles: true, composed: true }));
    }

    #dispatchDetailEvent<Key extends Exclude<keyof NetworkElementEventMap, 'load'>>(
      type: Key,
      detail: NetworkElementEventMap[Key] extends CustomEvent<infer Detail> ? Detail : never,
    ): void {
      const CustomEventConstructor = this.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
      this.dispatchEvent(
        new CustomEventConstructor(type, {
          detail: Object.freeze(detail),
          bubbles: true,
          composed: true,
        }),
      );
    }

    #assertCurrent(run: Activation): void {
      if (!this.#isCurrent(run)) throw abortError();
    }

    #isCurrent(run: Activation): boolean {
      return run === this.#activation && !run.closed && !run.abort.signal.aborted;
    }
  };
  const checked: CustomElementConstructor & { readonly prototype: NetworkElement } =
    NetworkElementClass;
  return checked;
}

/** Observe first approach to the viewport and later pause/resume visibility. */
function observeNear(host: HTMLElement, update: (near: boolean) => void): () => void {
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
    { rootMargin: ROOT_MARGIN },
  );
  observer.observe(host);
  return () => observer.disconnect();
}

function borderKey(view: ViewState): string | object {
  if (view.borders.kind === 'custom') return `custom:${view.borders.revision}`;
  return `${view.borders.kind}:${view.options.borders}`;
}

function borderChanged(previous: ViewState, next: ViewState): boolean {
  if (previous.borders.kind !== next.borders.kind) return true;
  if (
    previous.borders.kind === 'custom' &&
    next.borders.kind === 'custom' &&
    (previous.borders.data !== next.borders.data ||
      previous.borders.revision !== next.borders.revision)
  ) {
    return true;
  }
  return (
    (previous.borders.kind === 'natural-earth' || next.borders.kind === 'natural-earth') &&
    previous.options.borders !== next.options.borders
  );
}

function itemTuple(
  kind: 'vertex' | 'edge' | null,
  index: number | null,
): readonly ['vertex' | 'edge', number] | null {
  return kind === null || index === null ? null : [kind, index];
}

function sameItem(
  previous: readonly ['vertex' | 'edge', number] | null,
  next: readonly ['vertex' | 'edge', number] | null,
): boolean {
  return (
    previous === next ||
    (previous !== null && next !== null && previous[0] === next[0] && previous[1] === next[1])
  );
}

function sameSource(previous: NetworkSource, next: NetworkSource): boolean {
  return (
    previous.kind === next.kind &&
    (previous.kind === 'inline' ||
      (next.kind !== 'inline' && Object.is(previous.value, next.value)))
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'latkit-network': NetworkElement;
  }
}
