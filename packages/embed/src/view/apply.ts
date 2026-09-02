import type { Channel, Domain, Network, Options } from '@latkit/network';

import {
  CHANNEL_ATTRIBUTES,
  OPTION_ATTRIBUTES,
  type RuntimeAttributeOption,
} from './attributes.js';
import {
  channelValues,
  type ChannelBinding,
  type ColormapBinding,
  type OptionState,
  type ViewState,
} from './state.js';

/**
 * Apply only effective view changes to an already loaded Network.
 *
 * `construction` is the option state the Network was created with; on the first application it
 * stands in for the previous view so options already supplied at construction are not re-sent.
 */
export function applyView(
  network: Network,
  previous: ViewState | null,
  next: ViewState,
  construction?: OptionState,
): void {
  const baseline = previous ?? construction;
  applyOptions(network, baseline, next);

  for (const definition of CHANNEL_ATTRIBUTES) {
    applyChannel(
      network,
      definition.key,
      definition.normalized,
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

/** Collect changed live options and the colormap into one `setOptions` patch. */
function applyOptions(
  network: Network,
  previous: OptionState | undefined,
  next: OptionState,
): void {
  const patch: Options = {};
  let changed = false;

  for (const entry of OPTION_ATTRIBUTES) {
    if (!entry.definition.live) continue;
    const key = entry.option as RuntimeAttributeOption;
    const value = next.options[key];
    if (previous && sameOption(previous.options[key], value)) continue;
    (patch as Record<string, unknown>)[key] = value;
    changed = true;
  }
  if (!previous || !sameColormap(previous.colormap, next.colormap)) {
    patch.colormap = next.colormap.fn;
    changed = true;
  }
  if (changed) network.setOptions(patch);
}

function applyChannel(
  network: Network,
  channel: Channel,
  normalized: boolean,
  previous: ChannelBinding | null,
  next: ChannelBinding | null,
): void {
  if (!next) {
    if (previous) network.setChannel(channel, null);
    return;
  }

  const sourceChanged = !previous || !sameChannelSource(previous, next);
  const baseChanged = !previous || !sameOptionalDomain(previous.baseDomain, next.baseDomain);

  if (sourceChanged || baseChanged) {
    if (normalized) network.setChannel(channel, channelValues(next), next.baseDomain);
    else network.setChannel(channel, channelValues(next));
    if (normalized) network.setChannelDomain(channel, next.domainOverride);
    return;
  }

  if (normalized && !sameOptionalDomain(previous.domainOverride, next.domainOverride)) {
    network.setChannelDomain(channel, next.domainOverride);
  }
}

function sameColormap(previous: ColormapBinding, next: ColormapBinding): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'named' && next.kind === 'named') return previous.name === next.name;
  return (
    previous.kind === 'custom' &&
    next.kind === 'custom' &&
    previous.fn === next.fn &&
    previous.revision === next.revision
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

function sameOptionalDomain(
  previous: Domain | null | undefined,
  next: Domain | null | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return previous[0] === next[0] && previous[1] === next[1];
}

function sameTuple(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}
