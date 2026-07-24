import type { ChannelBinding, InteractionState, ViewState } from './state.js';
import { channelValues } from './state.js';
import { CHANNEL_ATTRIBUTES } from './attributes.js';
import type { NetworkData } from '../data/types.js';
import { formatNumber, humanizeName } from './format.js';

/** Stable caption and polite selection-announcement coordinator. */
export interface Caption {
  update(
    data: NetworkData,
    view: ViewState,
    interaction: InteractionState,
    announceSelection: boolean,
  ): void;
  reset(): void;
}

/** Bind caption text and the selection-only live output to stable nodes. */
export function createCaption(output: HTMLOutputElement, live: HTMLOutputElement): Caption {
  return {
    update(data, view, interaction, announceSelection) {
      output.hidden = !view.controls.has('caption');
      output.dataset.state = interaction.selected
        ? 'selected'
        : interaction.hover
          ? 'hover'
          : 'idle';
      output.textContent = captionText(data, view, interaction);
      if (announceSelection) {
        live.textContent = interaction.selected
          ? `Selected ${describeItem(data, view, interaction.selected)}.`
          : 'Selection cleared.';
      }
    },
    reset() {
      output.hidden = true;
      output.dataset.state = 'idle';
      output.textContent = '';
      live.textContent = '';
    },
  };
}

function captionText(data: NetworkData, view: ViewState, interaction: InteractionState): string {
  const active = interaction.selected ?? interaction.hover;
  if (active) {
    const prefix = interaction.selected ? 'Selected' : 'Hover';
    return `${prefix}: ${describeItem(data, view, active)}`;
  }

  const vertices = data.topology.vertexCount;
  const edges = data.topology.edges.length / 2;
  return `${vertices} vertices · ${edges} edges`;
}

function describeItem(
  data: NetworkData,
  view: ViewState,
  item: readonly ['vertex' | 'edge', number],
): string {
  const [kind, index] = item;
  const label = itemLabel(data, kind, index);
  const values = itemValues(view, kind, index);
  return values.length === 0 ? label : `${label}; ${values.join('; ')}`;
}

function itemLabel(data: NetworkData, kind: 'vertex' | 'edge', index: number): string {
  const labels = kind === 'vertex' ? data.labels?.vertex : data.labels?.edge;
  return labels?.[index] ?? `${humanizeName(kind)} ${index}`;
}

function itemValues(view: ViewState, kind: 'vertex' | 'edge', index: number): string[] {
  const values: string[] = [];
  const seen = new Set<object>();

  for (const definition of CHANNEL_ATTRIBUTES) {
    if (definition.scope !== kind) continue;
    const binding = view.channels[definition.key];
    if (!binding) continue;
    const identity = binding.kind === 'field' ? binding.entry : binding.values;
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(valueDescription(binding, definition.key, index));
  }
  return values;
}

function valueDescription(binding: ChannelBinding, channel: string, index: number): string {
  const value = channelValues(binding)[index];
  const formatted = value === undefined ? 'unavailable' : formatNumber(value);
  if (binding.kind === 'direct') return `${humanizeName(channel)}: ${formatted}`;

  const unit = binding.entry.field.unit;
  return `${binding.entry.field.label}: ${formatted}${unit ? ` ${unit}` : ''}`;
}
