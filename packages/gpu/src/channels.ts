/**
 * A renderer's channels: named per-item value streams, bound as arrays or following one signal of
 * a series, each owning a slot of float words in the one store the renderer's shaders read, with
 * the input domain a normalized channel maps through. Written once for every renderer: a renderer
 * supplies its registry, its store, and how a channel's record reaches its uniforms.
 */

import { validateDomain, validateSeries, type Domain, type Series } from '@latkit/model';

import { createPlayback } from './playback.js';

/** What a renderer's registry says about one channel. */
interface Definition<Scope extends string> {
  /** The items it holds a value per. */
  readonly scope: Scope;
  /** Whether its values pass through an input domain. */
  readonly normalized: boolean;
  /** Float words per item. */
  readonly components: 1 | 2;
  /** Whether it can follow one signal of a series; only a scalar channel can. */
  readonly series: boolean;
}

/** One signal of a series a channel follows, one element per item of its scope. */
interface Following {
  readonly series: Series;
  readonly signal: number;
}

/** A renderer's channels: a slot each, bound or following, and the domains they map through. */
export interface Channels<Channel extends string, Scope extends string> {
  /** Float words the slots take in the store; the windows of followed series come after them. */
  readonly words: number;
  /** The words the slots of `counts` take, before any load. */
  measure(counts: Readonly<Record<Scope, number>>): number;
  /** Lay out a slot per channel for `counts`, or none for null; every channel unbinds. */
  load(counts: Readonly<Record<Scope, number>> | null): void;
  /**
   * Bind values, follow `{ series, signal }`, or unbind with null.
   *
   * @remarks
   * An array holds a value per item of the channel's scope for each component; it maps through
   * `domain`, else the domain its values start with. A series shows nothing, its slot NaN, until a
   * seek shows a frame, and without `domain` it maps through the signal's recorded range as it
   * grows. Following the signal a channel follows already keeps what it shows.
   *
   * @returns False when unbinding found nothing bound.
   * @throws Error before a load, for a wrong length, for series elements that do not fit, or when
   * the store cannot hold another window, which leaves the channel unbound; TypeError for values of
   * another kind, or a channel that cannot follow a series; RangeError for a signal the series
   * lacks; RangeError or TypeError for a bad domain. Otherwise nothing changes when it throws.
   */
  set(
    channel: Channel,
    values: Float32Array | Float64Array | Following | null,
    domain?: Domain | null,
  ): boolean;
  /**
   * Show every followed channel at `time`: each value takes its latest sample at or before it, or
   * its first before the recording starts.
   *
   * @throws RangeError when `time` is not finite.
   */
  seek(time: number): void;
  /**
   * Override the domain of a normalized channel, or return to its own with null; a raw channel
   * ignores it.
   *
   * @throws RangeError or TypeError for a bad domain.
   */
  setDomain(channel: Channel, domain: Domain | null): void;
  /** The domain a bound normalized channel maps through, or null. */
  domain(channel: Channel): Domain | null;
  /** What a channel shows, as the CPU reads it, or null while unbound. Borrowed: never mutate it. */
  values(channel: Channel): Float32Array | null;
  /** Write a channel's record again, as when something its record reads changed. */
  refresh(channel: Channel): void;
  /** Write every slot and followed window into a store that was just created. */
  upload(): void;
}

/** A channel's binding. */
interface Bound {
  /** The words of its own slot: an array's values, or what a followed channel holds there. */
  readonly own: Float32Array;
  /** What it shows: its own words, or a window of the series it follows. */
  values: Float32Array;
  /** Where what it shows starts in the store, when not its own slot. */
  shown: number | null;
  readonly following: Following | null;
  /** Its domain as bound: given, or the one its values start with, or the recorded range. */
  data: Domain | null;
  /** Whether the domain follows the recorded range of the signal it follows. */
  readonly recorded: boolean;
}

/** The domain a normalized channel maps through when nothing says otherwise. */
const UNIT: Domain = Object.freeze([0, 1] as const);

/**
 * Create a renderer's channels.
 *
 * @remarks
 * Every channel owns a slot for as long as a load holds, so binding one is one write and never a
 * relayout, and a followed signal's frames stay resident in a window of the store after the slots,
 * shared by every channel following that signal. The CPU keeps what every channel shows, across a
 * store that comes and goes: `upload` writes it all into the next one.
 */
export function createChannels<Channel extends string, Scope extends string>(spec: {
  /** The renderer, as its errors name it: `network`. */
  readonly name: string;
  /** What a load gives it, as its errors name it: `topology`. */
  readonly structure: string;
  /** Every channel, in slot order. */
  readonly channels: Readonly<Record<Channel, Definition<Scope>>>;
  /**
   * The store the slots and windows live in, or null while there is none. `reserve` grows it to
   * hold `words` float words, keeping what it holds, and throws when it cannot.
   */
  store(): {
    reserve(words: number): void;
    writeWords(offset: number, values: Float32Array): void;
  } | null;
  /**
   * Write a channel's record: the word its values start at, whether it is bound, and the
   * `(value - min) * scale` its values map through: a normalized channel's domain, the identity for
   * a raw one, and zeros while unbound.
   */
  record(channel: Channel, offset: number, bound: boolean, min: number, scale: number): void;
  /** A followed channel shows another frame, or the recorded range its domain follows grew. */
  shown(channel: Channel): void;
  /** A read of the series a channel follows failed. */
  error(channel: Channel, cause: unknown): void;
  /** The domain values bound without one map through; `[0, 1]` unless given. */
  initialDomain?(channel: Channel, values: Float32Array | Float64Array): Domain;
}): Channels<Channel, Scope> {
  const keys = Object.keys(spec.channels) as Channel[];
  const bound = new Map<Channel, Bound>();
  const overrides = new Map<Channel, Domain>();
  let counts: Readonly<Record<Scope, number>> | null = null;
  let offsets = new Map<Channel, number>();
  let words = 0;

  function definitionOf(channel: Channel): Definition<Scope> {
    if (!Object.hasOwn(spec.channels, channel))
      throw new Error(`unknown ${spec.name} channel ${String(channel)}`);
    return spec.channels[channel];
  }

  function itemsOf(scope: Scope): number {
    return counts?.[scope] ?? 0;
  }

  function measure(of: Readonly<Record<Scope, number>>): number {
    let total = 0;
    for (const key of keys) total += of[spec.channels[key].scope] * spec.channels[key].components;
    return total;
  }

  function loaded(): void {
    if (!counts)
      throw new Error(`${spec.name} ${spec.structure} must be loaded before binding channels`);
  }

  /** Write a channel's record from what it holds now. */
  function write(channel: Channel): void {
    const own = offsets.get(channel)!;
    const entry = bound.get(channel);
    if (!entry) {
      spec.record(channel, own, false, 0, 0);
      return;
    }
    const offset = entry.shown ?? own;
    if (!spec.channels[channel].normalized) {
      spec.record(channel, offset, true, 0, 1);
      return;
    }
    const [min, max] = overrides.get(channel) ?? entry.data ?? UNIT;
    spec.record(channel, offset, true, min, 1 / Math.max(max - min, 1e-12));
  }

  /** Validate and own a domain before keeping it. */
  function checked(channel: Channel, domain: Domain): Domain {
    validateDomain(domain, `${spec.name} ${channel} domain`);
    return Object.freeze([domain[0], domain[1]] as const);
  }

  const playback = createPlayback<Channel>({
    reserved: () => words,
    items: (channel) => itemsOf(spec.channels[channel].scope),
    store: () => spec.store(),
    show(channel, offset, view) {
      const entry = bound.get(channel)!;
      entry.shown = offset;
      entry.values = view;
      write(channel);
      spec.shown(channel);
    },
    hold(channel) {
      const entry = bound.get(channel);
      if (!entry || entry.shown === null) return;
      entry.own.set(entry.values);
      spec.store()?.writeWords(offsets.get(channel)!, entry.own);
      entry.values = entry.own;
      entry.shown = null;
      write(channel);
    },
    changed(channel) {
      const entry = bound.get(channel);
      if (!entry?.following || !entry.recorded) return;
      entry.data = recordedDomain(entry.following);
      write(channel);
      spec.shown(channel);
    },
    error: (channel, cause) => spec.error(channel, cause),
  });

  function bind(
    channel: Channel,
    definition: Definition<Scope>,
    values: Float32Array | Float64Array,
    domain?: Domain | null,
  ): void {
    loaded();
    const tag = Object.prototype.toString.call(values);
    if (tag !== '[object Float32Array]' && tag !== '[object Float64Array]') {
      throw new TypeError(
        `${spec.name} channel ${channel} values must be a Float32Array or Float64Array`,
      );
    }
    const expected = itemsOf(definition.scope) * definition.components;
    if (values.length !== expected) {
      throw new Error(`${spec.name} channel ${channel} length ${values.length} != ${expected}`);
    }
    const data = definition.normalized
      ? domain
        ? checked(channel, domain)
        : (spec.initialDomain?.(channel, values) ?? UNIT)
      : null;
    // The store copies synchronously, so float32 values feed it directly; the CPU copy changes only
    // once the write succeeded, so a failure leaves nothing changed.
    const f32 = values instanceof Float32Array ? values : Float32Array.from(values);
    spec.store()?.writeWords(offsets.get(channel)!, f32);
    const previous = bound.get(channel);
    if (previous?.following) playback.stop(channel);
    // A rebind refreshes the words it owns in place, so animated values never allocate.
    let own = previous?.own;
    if (own?.length === f32.length) own.set(f32);
    else own = f32 === values ? f32.slice() : f32;
    bound.set(channel, { own, values: own, shown: null, following: null, data, recorded: false });
    write(channel);
  }

  function follow(
    channel: Channel,
    definition: Definition<Scope>,
    following: Following,
    domain?: Domain | null,
  ): void {
    loaded();
    if (!definition.series || definition.components !== 1) {
      throw new TypeError(`${spec.name} channel ${channel} cannot follow a series`);
    }
    const { series, signal } = following;
    validateSeries(series);
    if (!Number.isInteger(signal) || signal < 0 || signal >= series.signals.length) {
      throw new RangeError(
        `${spec.name} channel ${channel} signal ${signal} out of [0, ${series.signals.length})`,
      );
    }
    const items = itemsOf(definition.scope);
    const last = series.elements ? (series.elements.at(-1) ?? -1) : series.elementCount - 1;
    if (series.elements ? last >= items : series.elementCount !== items) {
      throw new Error(`${spec.name} channel ${channel} series elements do not fit ${items} items`);
    }
    const data = definition.normalized
      ? domain
        ? checked(channel, domain)
        : recordedDomain(following)
      : null;
    const previous = bound.get(channel);
    if (previous?.following?.series === series && previous.following.signal === signal) {
      bound.set(channel, { ...previous, following, data, recorded: !domain });
    } else {
      const own = new Float32Array(items).fill(NaN);
      spec.store()?.writeWords(offsets.get(channel)!, own);
      bound.set(channel, {
        own,
        values: own,
        shown: null,
        following,
        data,
        recorded: !domain,
      });
    }
    write(channel);
    try {
      // Following the signal already followed reads again after a failure.
      playback.follow(channel, series, signal);
    } catch (error) {
      clear(channel);
      throw error;
    }
  }

  function clear(channel: Channel): boolean {
    const entry = bound.get(channel);
    if (!entry && !overrides.has(channel)) return false;
    if (entry?.following) playback.stop(channel);
    bound.delete(channel);
    overrides.delete(channel);
    write(channel);
    return true;
  }

  return {
    get words() {
      return words;
    },
    measure,
    load(next) {
      bound.clear();
      overrides.clear();
      counts = next ? { ...next } : null;
      offsets = new Map();
      words = 0;
      for (const key of keys) {
        const definition = spec.channels[key];
        offsets.set(key, words);
        words += itemsOf(definition.scope) * definition.components;
      }
      // Forget every window: the next ones lay out after these slots.
      playback.reset();
      for (const key of keys) write(key);
    },
    set(channel, values, domain) {
      const definition = definitionOf(channel);
      if (values === null) return clear(channel);
      if (isFollowing(values)) follow(channel, definition, values, domain);
      else bind(channel, definition, values, domain);
      return true;
    },
    seek: (time) => playback.seek(time),
    setDomain(channel, domain) {
      if (!definitionOf(channel).normalized) return;
      const previous = overrides.get(channel) ?? null;
      if (domain) {
        const next = checked(channel, domain);
        if (previous && previous[0] === next[0] && previous[1] === next[1]) return;
        overrides.set(channel, next);
      } else {
        if (!previous) return;
        overrides.delete(channel);
      }
      write(channel);
    },
    domain(channel) {
      const entry = bound.get(channel);
      if (!entry || !definitionOf(channel).normalized) return null;
      return overrides.get(channel) ?? entry.data ?? UNIT;
    },
    values: (channel) => bound.get(channel)?.values ?? null,
    refresh: (channel) => write(channel),
    upload() {
      const store = spec.store();
      if (!store) return;
      store.reserve(words);
      for (const [channel, entry] of bound) store.writeWords(offsets.get(channel)!, entry.own);
      playback.upload();
    },
  };
}

/** Whether channel values name a series to follow rather than holding the values. */
function isFollowing(values: unknown): values is Following {
  return typeof values === 'object' && values !== null && 'series' in values;
}

/** The recorded finite range of a series signal, or `[0, 1]` before anything finite is recorded. */
function recordedDomain({ series, signal }: Following): Domain {
  const ranges = series.state.ranges;
  const lo = ranges?.[signal * 2];
  const hi = ranges?.[signal * 2 + 1];
  return lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi)
    ? [lo, hi]
    : UNIT;
}
