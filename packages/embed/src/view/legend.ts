import { colormapGradientCss, type Colormap } from '@latkit/colormaps';
import type { Channel } from '@latkit/network';

import { CHANNEL_ATTRIBUTES, type LegendControl } from './attributes.js';
import { effectiveChannelDomain, type ChannelBinding, type ViewState } from './state.js';
import { formatNumber, humanizeName } from './format.js';

interface LegendNodes {
  readonly channel: Channel;
  readonly token: LegendControl;
  readonly root: HTMLDivElement;
  readonly title: HTMLSpanElement;
  readonly swatch: HTMLSpanElement;
  readonly minimum: HTMLSpanElement;
  readonly maximum: HTMLSpanElement;
}

/** Single visible color bar backed by one node per colormap channel. */
export interface Legends {
  update(view: ViewState): void;
  reset(): void;
}

/** Create one color-bar legend per colormap channel; at most one is ever shown. */
export function createLegends(container: HTMLDivElement): Legends {
  const document = container.ownerDocument;
  const entries: LegendNodes[] = [];

  for (const definition of CHANNEL_ATTRIBUTES) {
    if (definition.map !== 'colormap') continue;
    const token = `${definition.attribute}-legend` as LegendControl;
    const root = document.createElement('div');
    root.setAttribute('part', `legend ${token}`);
    root.setAttribute('role', 'group');
    root.hidden = true;

    const title = document.createElement('span');
    title.className = 'latkit-legend-title';
    const swatch = document.createElement('span');
    swatch.className = 'latkit-legend-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const range = document.createElement('output');
    range.className = 'latkit-legend-range';
    range.setAttribute('aria-hidden', 'true');
    const minimum = document.createElement('span');
    const maximum = document.createElement('span');
    range.append(minimum, maximum);
    root.append(title, swatch, range);
    container.append(root);
    entries.push({
      channel: definition.key,
      token,
      root,
      title,
      swatch,
      minimum,
      maximum,
    });
  }

  return {
    update(view) {
      // Channels are created in canonical order, so the first applicable entry
      // (vertex color before edge color) claims the single visible color bar.
      let visible = false;
      for (const entry of entries) {
        const binding = view.channels[entry.channel];
        const show = !visible && view.controls.has(entry.token) && binding !== null;
        entry.root.hidden = !show;
        if (!show || !binding) {
          clearLegend(entry);
          continue;
        }

        visible = true;
        const label = bindingLabel(binding, entry.channel);
        const unit = binding.kind === 'field' ? binding.entry.field.unit : undefined;
        const [minimum, maximum] = effectiveChannelDomain(binding);
        entry.title.textContent = unit ? `${label} (${unit})` : label;
        entry.minimum.textContent = formatNumber(minimum);
        entry.maximum.textContent = formatNumber(maximum);
        entry.root.setAttribute(
          'aria-label',
          `${label} color legend, ${rangeDescription(minimum, maximum, unit)}`,
        );
        entry.swatch.style.background = legendBackground(view);
      }
      container.hidden = !visible;
    },
    reset() {
      container.hidden = true;
      for (const entry of entries) {
        entry.root.hidden = true;
        clearLegend(entry);
      }
    },
  };
}

function clearLegend(entry: LegendNodes): void {
  entry.root.removeAttribute('aria-label');
  entry.title.textContent = '';
  entry.minimum.textContent = '';
  entry.maximum.textContent = '';
  entry.swatch.style.removeProperty('background');
}

function bindingLabel(binding: ChannelBinding, channel: Channel): string {
  return binding.kind === 'field' ? binding.entry.field.label : humanizeName(channel);
}

function legendBackground(view: ViewState): string {
  return view.colormap.kind === 'named'
    ? colormapGradientCss(view.colormap.name, 'to right')
    : customGradient(view.colormap.fn);
}

function customGradient(fn: Colormap): string {
  const stops: string[] = [];
  for (let index = 0; index <= 16; index++) {
    const position = index / 16;
    const [r, g, b] = fn(position);
    stops.push(`rgb(${byte(r)} ${byte(g)} ${byte(b)}) ${Math.round(position * 100)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function byte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function rangeDescription(minimum: number, maximum: number, unit?: string): string {
  const suffix = unit ? ` ${unit}` : '';
  return `${formatNumber(minimum)}${suffix} to ${formatNumber(maximum)}${suffix}`;
}
