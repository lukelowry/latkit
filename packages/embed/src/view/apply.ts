import type { Channel, ChannelRange, Network, Options } from '@latkit/network';

import {
  CHANNEL_ATTRIBUTES,
  OPTION_ATTRIBUTES,
  channelAttribute,
  type RuntimeAttributeOption,
} from './attributes.js';
import {
  channelValues,
  isNormalizedChannel,
  type ChannelBinding,
  type ResolvedRuntimeOptions,
  type ViewState,
} from './state.js';

/** Apply only effective view changes to an already loaded Network. */
export function applyView(
  network: Network,
  previous: ViewState | null,
  next: ViewState,
  constructionOptions?: ResolvedRuntimeOptions,
): void {
  applyOptions(network, previous?.options ?? constructionOptions, next.options);

  if (!previous || !sameColormap(previous, next)) network.setColormap(next.colormap.fn);

  for (const definition of CHANNEL_ATTRIBUTES) {
    applyChannel(
      network,
      definition.key,
      previous?.channels[definition.key] ?? null,
      next.channels[definition.key],
    );
  }

  if (
    (!previous || previous.projection !== next.projection) &&
    !network.setProjection(next.projection)
  ) {
    throw new Error(`@latkit/embed: resolved projection ${next.projection} is unavailable`);
  }
}

function applyOptions(
  network: Network,
  previous: ResolvedRuntimeOptions | undefined,
  next: ResolvedRuntimeOptions,
): void {
  const patch: Options = {};
  let changed = false;

  for (const entry of OPTION_ATTRIBUTES) {
    if (entry.definition.lifecycle !== 'runtime') continue;
    const key = entry.option as RuntimeAttributeOption;
    const value = next[key];
    if (previous && sameOption(previous[key], value)) continue;
    (patch as Record<string, unknown>)[key] = value;
    changed = true;
  }
  if (changed) network.setOptions(patch);
}

function applyChannel(
  network: Network,
  channel: Channel,
  previous: ChannelBinding | null,
  next: ChannelBinding | null,
): void {
  if (!next) {
    if (previous) network.clearChannel(channel);
    return;
  }

  const sourceChanged = !previous || !sameChannelSource(previous, next);
  const baseChanged = !previous || !sameOptionalRange(previous.baseDomain, next.baseDomain);
  const outputChanged = !previous || !sameOptionalRange(previous.outputRange, next.outputRange);
  if (sourceChanged || baseChanged || outputChanged) {
    const definition = channelAttribute(channel);
    if (definition.map === 'dash') network.setChannel(channel, channelValues(next));
    else if (definition.map === 'height') {
      network.setChannel(channel, channelValues(next), next.baseDomain, next.outputRange);
    } else network.setChannel(channel, channelValues(next), next.baseDomain);
    if (isNormalizedChannel(channel)) network.setChannelRange(channel, next.domainOverride);
    return;
  }

  if (
    isNormalizedChannel(channel) &&
    !sameOptionalRange(previous.domainOverride, next.domainOverride)
  ) {
    network.setChannelRange(channel, next.domainOverride);
  }
}

function sameColormap(previous: ViewState, next: ViewState): boolean {
  if (previous.colormap.kind !== next.colormap.kind) return false;
  if (previous.colormap.kind === 'named' && next.colormap.kind === 'named') {
    return previous.colormap.name === next.colormap.name;
  }
  return (
    previous.colormap.kind === 'custom' &&
    next.colormap.kind === 'custom' &&
    previous.colormap.fn === next.colormap.fn &&
    previous.colormap.revision === next.colormap.revision
  );
}

function sameChannelSource(previous: ChannelBinding, next: ChannelBinding): boolean {
  if (previous.kind !== next.kind) return false;
  return previous.kind === 'field' && next.kind === 'field'
    ? previous.entry === next.entry
    : previous.kind === 'direct' && next.kind === 'direct'
      ? previous.source === next.source
      : false;
}

function sameOption(previous: unknown, next: unknown): boolean {
  if (Array.isArray(previous) && Array.isArray(next)) return sameTuple(previous, next);
  return Object.is(previous, next);
}

function sameOptionalRange(
  previous: ChannelRange | null | undefined,
  next: ChannelRange | null | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return previous[0] === next[0] && previous[1] === next[1];
}

function sameTuple(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}
