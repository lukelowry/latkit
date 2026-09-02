// @vitest-environment jsdom

import type { Network } from '@latkit/network';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkData } from '../src/data/types.js';
import { createCaption } from '../src/view/caption.js';
import { createChrome, type HostCommandSink } from '../src/view/chrome.js';
import { attachCanvasInteraction, type InteractionCommandSink } from '../src/view/interaction.js';
import { createLegends } from '../src/view/legend.js';
import { createShell, type Shell } from '../src/view/shell.js';
import { fieldsFor } from '../src/view/fields.js';
import { networkDataWithFields } from './fixtures.js';
import {
  ALL_PROJECTIONS,
  NO_INTERACTION,
  direct,
  inputRevision,
  resolvedView,
} from './view-fixtures.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('semantic chrome', () => {
  it('installs default host semantics without replacing author attributes', () => {
    const host = document.createElement('div');
    const internals = { role: null as string | null };
    const attachInternals = vi.fn(() => internals);
    Object.defineProperty(host, 'attachInternals', { value: attachInternals });
    host.setAttribute('role', 'application');
    host.setAttribute('aria-label', 'Author network label');
    document.body.append(host);

    createShell(host);

    expect(attachInternals).toHaveBeenCalledOnce();
    expect(internals.role).toBe('group');
    expect(host.getAttribute('role')).toBe('application');
    expect(host.getAttribute('aria-label')).toBe('Author network label');
  });

  it('creates stable native regions and canonical public parts once', () => {
    const h = chromeHarness();
    const data = labeledData();
    const view = completeView(data);
    const projection = h.shell.regions.projection;
    const channel = h.shell.regions.channels.querySelector('[part="channel vertex-color"]');
    const legend = h.shell.regions.legends.querySelector('[part="legend vertex-color-legend"]');

    h.chrome.update(data, fieldsFor(data), view, ALL_PROJECTIONS, NO_INTERACTION);
    h.chrome.update(
      data,
      fieldsFor(data),
      resolvedView(data, { controls: 'none' }),
      ALL_PROJECTIONS,
      NO_INTERACTION,
    );

    expect(h.host.shadowRoot).not.toBeNull();
    expect(h.shell.canvas.getAttribute('role')).toBe('img');
    expect(h.shell.canvas.tabIndex).toBe(0);
    expect(h.shell.canvas.getAttribute('aria-describedby')).toBe('latkit-canvas-instructions');
    expect(h.host.shadowRoot?.getElementById('latkit-canvas-instructions')?.textContent).toContain(
      'arrow keys to pan',
    );
    expect(h.shell.regions.caption.getAttribute('role')).toBe('note');
    expect(projection.querySelector('legend')?.textContent).toBe('Projection');
    expect(projection.querySelectorAll('button')).toHaveLength(3);
    expect(projection.querySelectorAll('button > svg[aria-hidden="true"]')).toHaveLength(3);
    expect(
      [...projection.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Flat', 'Tilt', 'Globe']);
    expect(h.shell.regions.navigation.querySelector('legend')?.textContent).toBe('Navigation');
    expect(
      h.shell.regions.navigation.querySelectorAll('button > svg[aria-hidden="true"]'),
    ).toHaveLength(3);
    expect(
      [...h.shell.regions.navigation.querySelectorAll('button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Fit view', 'Zoom in', 'Zoom out']);
    expect(h.shell.regions.channels.querySelectorAll('[part~="channel"]')).toHaveLength(7);
    expect(h.shell.regions.legends.querySelectorAll('[part~="legend"]')).toHaveLength(2);
    expect(h.shell.regions.live.getAttribute('aria-live')).toBe('polite');
    expect(h.host.shadowRoot?.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(h.shell.regions.projection).toBe(projection);
    expect(h.shell.regions.channels.querySelector('[part="channel vertex-color"]')).toBe(channel);
    expect(h.shell.regions.legends.querySelector('[part="legend vertex-color-legend"]')).toBe(
      legend,
    );
  });

  it('synchronizes projection, navigation, scoped channel options, and visibility', () => {
    const h = chromeHarness();
    const data = labeledData();
    const view = completeView(data);
    const projections: Network['projections'] = { flat: true, tilt: true, globe: false };

    h.chrome.update(data, fieldsFor(data), view, projections, {
      hover: null,
      selected: null,
      atFitView: true,
    });

    expect(h.shell.regions.projection.hidden).toBe(false);
    const projectionButtons = buttonsByText(h.shell.regions.projection);
    expect(projectionButtons.get('Tilt')?.getAttribute('aria-pressed')).toBe('true');
    expect(projectionButtons.get('Globe')?.disabled).toBe(true);
    expect(h.shell.regions.navigation.hidden).toBe(false);
    expect(buttonsByText(h.shell.regions.navigation).get('Fit view')?.disabled).toBe(true);
    expect(h.shell.regions.colormap.hidden).toBe(false);
    expect(h.shell.regions.channels.hidden).toBe(false);

    expect(channelOptions(h.shell, 'vertex-color')).toEqual([
      ['', 'None'],
      ['load', 'Load'],
      ['capacity', 'Capacity'],
    ]);
    expect(channelOptions(h.shell, 'edge-color')).toEqual([
      ['', 'None'],
      ['flow', 'Flow'],
    ]);
    expect(channelSelect(h.shell, 'vertex-size').value).toBe('capacity');
    expect(channelSelect(h.shell, 'edge-dash').value).toBe('flow');
    const scopes = h.shell.regions.channels.querySelectorAll('.latkit-channel-scope');
    expect(Array.from(scopes, (scope) => scope.getAttribute('role'))).toEqual(['group', 'group']);
    expect(Array.from(scopes, (scope) => scope.getAttribute('aria-labelledby'))).toEqual([
      'latkit-vertex-channels-label',
      'latkit-edge-channels-label',
    ]);
  });

  it('keeps explicit but inapplicable controls present and disabled', () => {
    const h = chromeHarness();
    const data: NetworkData = { ...labeledData(), fields: [] };
    const view = resolvedView(data, {
      controls: 'projection colormap edge-color edge-color-legend',
      'edge-color': '',
    });

    h.chrome.update(
      data,
      fieldsFor(data),
      view,
      { flat: true, tilt: false, globe: false },
      NO_INTERACTION,
    );

    expect(h.shell.regions.projection.hidden).toBe(false);
    expect(h.shell.regions.colormap.hidden).toBe(false);
    expect(h.shell.regions.colormap.querySelector('select')?.disabled).toBe(true);
    expect(channelRoot(h.shell, 'edge-color').hidden).toBe(false);
    expect(channelSelect(h.shell, 'edge-color').disabled).toBe(true);
    expect(legendRoot(h.shell, 'edge-color-legend').hidden).toBe(true);
  });

  it('routes control actions only through the durable host sink', () => {
    const h = chromeHarness();
    const data = labeledData();
    h.chrome.update(data, fieldsFor(data), completeView(data), ALL_PROJECTIONS, {
      ...NO_INTERACTION,
      atFitView: false,
    });
    h.setAttribute.mockClear();

    buttonsByText(h.shell.regions.projection).get('Globe')!.click();
    buttonsByText(h.shell.regions.navigation).get('Fit view')!.click();
    buttonsByText(h.shell.regions.navigation).get('Zoom in')!.click();
    buttonsByText(h.shell.regions.navigation).get('Zoom out')!.click();
    choose(h.shell.regions.colormap.querySelector('select')!, 'magma');
    choose(channelSelect(h.shell, 'vertex-color'), 'capacity');

    expect(h.setAttribute.mock.calls).toEqual([
      ['projection', 'globe'],
      ['colormap', 'magma'],
      ['vertex-color', 'capacity'],
    ]);
    expect(h.fit).toHaveBeenCalledWith(true);
    expect(h.zoomBy.mock.calls).toEqual([[1.25], [0.8]]);
  });

  it('shows and removes synthetic display-only options for custom bindings', () => {
    const h = chromeHarness();
    const data = labeledData();
    const input = inputRevision(data, {
      vertexColor: direct(new Float32Array([0.1, 0.2, 0.3])),
    });
    const custom = (value: number) => [value, 0, 1 - value] as const;
    const customView = resolvedView(
      data,
      { controls: 'colormap vertex-color' },
      { input, configuration: { customColormap: custom } },
    );

    h.chrome.update(data, fieldsFor(data), customView, ALL_PROJECTIONS, NO_INTERACTION);
    const colormap = h.shell.regions.colormap.querySelector('select')!;
    const vertexColor = channelSelect(h.shell, 'vertex-color');
    expect(colormap.selectedOptions[0]?.textContent).toBe('Custom');
    expect(vertexColor.selectedOptions[0]?.textContent).toBe('Custom values');
    expect(colormap.selectedOptions[0]?.disabled).toBe(true);
    expect(vertexColor.selectedOptions[0]?.disabled).toBe(true);

    const fieldView = resolvedView(data, {
      controls: 'colormap vertex-color',
      colormap: 'plasma',
      'vertex-color': 'capacity',
    });
    h.chrome.update(data, fieldsFor(data), fieldView, ALL_PROJECTIONS, NO_INTERACTION);
    expect(colormap.value).toBe('plasma');
    expect(vertexColor.value).toBe('capacity');
    expect(colormap.querySelector('[data-latkit-synthetic]')).toBeNull();
    expect(vertexColor.querySelector('[data-latkit-synthetic]')).toBeNull();
  });

  it('does not resample custom legends for interaction-only updates', () => {
    const h = chromeHarness();
    const data = labeledData();
    const custom = vi.fn((value: number) => [value, 0, 1 - value] as const);
    const view = resolvedView(
      data,
      { controls: 'caption vertex-color-legend', 'vertex-color': 'load' },
      { configuration: { customColormap: custom } },
    );

    h.chrome.update(data, fieldsFor(data), view, ALL_PROJECTIONS, NO_INTERACTION);
    expect(custom).toHaveBeenCalledTimes(17);
    h.chrome.update(data, fieldsFor(data), view, ALL_PROJECTIONS, {
      hover: { kind: 'vertex', index: 1 },
      selected: null,
      atFitView: true,
    });
    expect(custom).toHaveBeenCalledTimes(17);
  });

  it('tracks partial encoding regions and hides empty channel scopes', () => {
    const h = chromeHarness();
    const data = labeledData();
    const colormapOnly = resolvedView(data, {
      controls: 'colormap',
      'vertex-color': 'load',
    });
    h.chrome.update(data, fieldsFor(data), colormapOnly, ALL_PROJECTIONS, NO_INTERACTION);
    expect(h.shell.regions.root.classList.contains('latkit-has-encodings')).toBe(true);
    expect(h.shell.regions.root.classList.contains('latkit-has-colormap')).toBe(true);
    expect(h.shell.regions.root.classList.contains('latkit-has-channels')).toBe(false);

    const vertexOnly = resolvedView(data, { controls: 'vertex-size' });
    h.chrome.update(data, fieldsFor(data), vertexOnly, ALL_PROJECTIONS, NO_INTERACTION);
    expect(h.shell.regions.root.classList.contains('latkit-has-colormap')).toBe(false);
    expect(h.shell.regions.root.classList.contains('latkit-has-channels')).toBe(true);
    expect(
      h.shell.regions.channels.querySelector<HTMLElement>('[data-scope="vertex"]')?.hidden,
    ).toBe(false);
    expect(h.shell.regions.channels.querySelector<HTMLElement>('[data-scope="edge"]')?.hidden).toBe(
      true,
    );
  });

  it('resets all transient text and chrome exposure without replacing nodes', () => {
    const h = chromeHarness();
    const data = labeledData();
    h.chrome.update(
      data,
      fieldsFor(data),
      completeView(data),
      ALL_PROJECTIONS,
      {
        hover: null,
        selected: { kind: 'vertex', index: 1 },
        atFitView: false,
      },
      true,
    );
    const projection = h.shell.regions.projection;

    h.chrome.reset();

    expect(h.shell.regions.projection).toBe(projection);
    expect(h.shell.regions.projection.hidden).toBe(true);
    expect(h.shell.regions.navigation.hidden).toBe(true);
    expect(h.shell.regions.colormap.hidden).toBe(true);
    expect(h.shell.regions.channels.hidden).toBe(true);
    expect(h.shell.regions.legends.hidden).toBe(true);
    expect(h.shell.regions.caption.hidden).toBe(true);
    expect(h.shell.regions.caption.textContent).toBe('');
    expect(h.shell.regions.live.textContent).toBe('');
    expect(h.shell.regions.root.className).toBe('');
  });
});

describe('inspector disclosure', () => {
  it('keeps automatic encodings collapsed behind an accessible toggle', () => {
    const h = chromeHarness();
    const data = labeledData();

    h.chrome.update(data, fieldsFor(data), resolvedView(data), ALL_PROJECTIONS, NO_INTERACTION);

    const toggle = inspectorToggle(h.shell);
    expect(h.shell.regions.inspector.hidden).toBe(true);
    expect(h.shell.regions.inspector.getAttribute('role')).toBe('group');
    expect(h.shell.regions.inspector.getAttribute('aria-label')).toBe('Display settings');
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(h.shell.regions.inspector.id);

    toggle.click();
    expect(h.shell.regions.inspector.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(h.shell.regions.inspector.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens explicit control lists by default and keeps the user preference', () => {
    const h = chromeHarness();
    const data = labeledData();

    h.chrome.update(data, fieldsFor(data), completeView(data), ALL_PROJECTIONS, NO_INTERACTION);
    const toggle = inspectorToggle(h.shell);
    expect(h.shell.regions.inspector.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(h.shell.regions.inspector.hidden).toBe(true);

    h.chrome.update(
      data,
      fieldsFor(data),
      completeView(data, { colormap: 'magma' }),
      ALL_PROJECTIONS,
      NO_INTERACTION,
    );
    expect(h.shell.regions.inspector.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape inside the panel and returns focus to the toggle', () => {
    const h = chromeHarness();
    const data = labeledData();

    h.chrome.update(data, fieldsFor(data), completeView(data), ALL_PROJECTIONS, NO_INTERACTION);
    const toggle = inspectorToggle(h.shell);
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    channelSelect(h.shell, 'vertex-color').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(h.shell.regions.inspector.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(h.host.shadowRoot?.activeElement).toBe(toggle);
  });

  it('hides the toggle and toolbar when no encodings or toolbar controls exist', () => {
    const h = chromeHarness();
    const data = labeledData();

    h.chrome.update(
      data,
      fieldsFor(data),
      resolvedView(data, { controls: 'caption' }),
      ALL_PROJECTIONS,
      NO_INTERACTION,
    );
    expect(inspectorToggle(h.shell).hidden).toBe(true);
    expect(h.shell.regions.toolbar.hidden).toBe(true);
    expect(h.shell.regions.inspector.hidden).toBe(true);

    h.chrome.update(
      data,
      fieldsFor(data),
      resolvedView(data, { controls: 'zoom' }),
      ALL_PROJECTIONS,
      NO_INTERACTION,
    );
    expect(inspectorToggle(h.shell).hidden).toBe(true);
    expect(h.shell.regions.toolbar.hidden).toBe(false);
  });

  it('forgets the user preference on reset', () => {
    const h = chromeHarness();
    const data = labeledData();

    h.chrome.update(data, fieldsFor(data), completeView(data), ALL_PROJECTIONS, NO_INTERACTION);
    const toggle = inspectorToggle(h.shell);
    toggle.click();
    expect(h.shell.regions.inspector.hidden).toBe(true);

    h.chrome.reset();
    expect(h.shell.regions.toolbar.hidden).toBe(true);
    expect(toggle.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    h.chrome.update(data, fieldsFor(data), completeView(data), ALL_PROJECTIONS, NO_INTERACTION);
    expect(h.shell.regions.inspector.hidden).toBe(false);
  });
});

describe('caption contract', () => {
  it('shows counts/help, hover preview, and selection details without duplicate sources', () => {
    const output = document.createElement('output');
    const live = document.createElement('output');
    const caption = createCaption(output, live);
    const data = labeledData();
    const view = resolvedView(data, {
      controls: 'caption',
      'vertex-color': 'load',
      'vertex-height': 'load',
      'vertex-size': 'capacity',
    });

    caption.update(data, view, NO_INTERACTION, false);
    expect(output.hidden).toBe(false);
    expect(output.textContent).toBe('3 vertices · 3 edges');
    expect(live.textContent).toBe('');

    caption.update(
      data,
      view,
      { hover: { kind: 'vertex', index: 1 }, selected: null, atFitView: true },
      false,
    );
    expect(output.textContent).toBe('Hover: Beta; Load: 30 MW; Capacity: 60 MW');
    expect(live.textContent).toBe('');

    caption.update(
      data,
      view,
      { hover: null, selected: { kind: 'vertex', index: 1 }, atFitView: true },
      true,
    );
    expect(output.textContent).toBe('Selected: Beta; Load: 30 MW; Capacity: 60 MW');
    expect(live.textContent).toBe('Selected Beta; Load: 30 MW; Capacity: 60 MW.');
  });

  it('uses fallback labels, direct channel labels, and announces selection clear', () => {
    const output = document.createElement('output');
    const live = document.createElement('output');
    const caption = createCaption(output, live);
    const data = networkDataWithFields();
    const values = new Float32Array([1.5, 2.25, 3.75]);
    const input = inputRevision(data, { vertexColor: direct(values) });
    const view = resolvedView(data, { controls: 'caption' }, { input });

    caption.update(
      data,
      view,
      { hover: null, selected: { kind: 'vertex', index: 0 }, atFitView: true },
      true,
    );
    expect(output.textContent).toBe('Selected: Vertex 0; Vertex Color: 1.5');
    expect(live.textContent).toBe('Selected Vertex 0; Vertex Color: 1.5.');

    caption.update(data, view, NO_INTERACTION, true);
    expect(live.textContent).toBe('Selection cleared.');
  });

  it('keeps the idle caption compact when focus is disabled', () => {
    const output = document.createElement('output');
    const live = document.createElement('output');
    const caption = createCaption(output, live);
    const data = labeledData();
    const view = resolvedView(data, { controls: 'caption', 'focus-enabled': 'false' });
    caption.update(data, view, NO_INTERACTION, false);
    expect(output.textContent).toBe('3 vertices · 3 edges');
  });
});

describe('legend contract', () => {
  it('creates only colormap legends and shows exactly one color bar', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const legends = createLegends(container);
    const data = labeledData();
    const view = completeView(data, {
      'vertex-color-domain': '12 28',
      'edge-color-domain': '5 7',
    });

    legends.update(view);

    expect(container.querySelectorAll('[part~="legend"]')).toHaveLength(2);
    expect(container.querySelector('[part~="vertex-height-legend"]')).toBeNull();
    expect(container.querySelector('[part~="vertex-size-legend"]')).toBeNull();
    expect(container.querySelector('[part~="edge-dash-legend"]')).toBeNull();
    expect(container.hidden).toBe(false);
    expect(legendText(container, 'vertex-color-legend')).toEqual(['Load (MW)', '12', '28']);
    expect(legendRootFrom(container, 'vertex-color-legend').hidden).toBe(false);
    expect(legendRootFrom(container, 'edge-color-legend').hidden).toBe(true);
    expect(legendText(container, 'edge-color-legend')).toEqual(['', '', '']);
    expect(legendRootFrom(container, 'vertex-color-legend').getAttribute('aria-label')).toBe(
      'Load color legend, 12 MW to 28 MW',
    );
    expect(
      legendRootFrom(container, 'vertex-color-legend')
        .querySelector('.latkit-legend-range')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(legendSwatch(container, 'vertex-color-legend').style.background).toContain(
      'linear-gradient',
    );
  });

  it('falls back to the edge color bar when the vertex color bar is inapplicable', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const legends = createLegends(container);
    const data = labeledData();
    const edgeOnly = completeView(data, { 'vertex-color': '', 'edge-color-domain': '5 7' });

    legends.update(edgeOnly);

    expect(container.hidden).toBe(false);
    expect(legendRootFrom(container, 'vertex-color-legend').hidden).toBe(true);
    expect(legendRootFrom(container, 'edge-color-legend').hidden).toBe(false);
    expect(legendText(container, 'edge-color-legend')).toEqual(['Flow (MW)', '5', '7']);
  });

  it('keeps requested legends hidden until bound and labels direct values canonically', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const legends = createLegends(container);
    const data = labeledData();
    const unbound = resolvedView(data, {
      controls: 'edge-color-legend',
      'edge-color': '',
    });
    legends.update(unbound);
    expect(container.hidden).toBe(true);

    const input = inputRevision(data, {
      edgeColor: direct(new Float32Array([2, 4, 8]), { baseDomain: [2, 8] }),
    });
    const bound = resolvedView(data, { controls: 'edge-color-legend' }, { input });
    legends.update(bound);
    expect(container.hidden).toBe(false);
    expect(legendText(container, 'edge-color-legend')).toEqual(['Edge Color', '2', '8']);

    legends.reset();
    expect(container.hidden).toBe(true);
    expect(legendText(container, 'edge-color-legend')).toEqual(['', '', '']);
  });
});

describe('canvas keyboard adapter', () => {
  it.each([
    ['ArrowLeft', 'panBy', [-24, 0]],
    ['ArrowRight', 'panBy', [24, 0]],
    ['ArrowUp', 'panBy', [0, -24]],
    ['ArrowDown', 'panBy', [0, 24]],
    ['+', 'zoomBy', [1.25]],
    ['=', 'zoomBy', [1.25]],
    ['-', 'zoomBy', [0.8]],
    ['_', 'zoomBy', [0.8]],
    ['Home', 'fit', [true]],
    ['Escape', 'select', [null]],
  ] as const)('handles %s with %s', (key, command, args) => {
    const canvas = document.createElement('canvas');
    const commands = commandSink();
    attachCanvasInteraction(canvas, commands);
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    canvas.dispatchEvent(event);

    expect(commands[command]).toHaveBeenCalledWith(...args);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not consume unrelated keys', () => {
    const canvas = document.createElement('canvas');
    const commands = commandSink();
    attachCanvasInteraction(canvas, commands);
    const unrelated = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
  });
});

interface ChromeHarness extends InteractionCommandSink {
  readonly host: HTMLElement & HostCommandSink;
  readonly shell: Shell;
  readonly chrome: ReturnType<typeof createChrome>;
  readonly setAttribute: ReturnType<typeof vi.spyOn>;
  readonly panBy: ReturnType<typeof vi.fn>;
  readonly zoomBy: ReturnType<typeof vi.fn>;
  readonly fit: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
}

function chromeHarness(): ChromeHarness {
  const host = document.createElement('div') as unknown as HTMLElement & HostCommandSink;
  const panBy = vi.fn();
  const zoomBy = vi.fn();
  const fit = vi.fn();
  const select = vi.fn();
  Object.assign(host, { panBy, zoomBy, fit, select });
  document.body.append(host);
  const setAttribute = vi.spyOn(host, 'setAttribute');
  const shell = createShell(host);
  return {
    host,
    shell,
    chrome: createChrome(host, shell),
    setAttribute,
    panBy,
    zoomBy,
    fit,
    select,
  };
}

function labeledData(): NetworkData {
  return {
    ...networkDataWithFields(),
    labels: {
      vertex: ['Alpha', 'Beta', 'Gamma'],
      edge: ['Alpha–Beta', 'Beta–Gamma', 'Gamma–Alpha'],
    },
  };
}

function completeView(
  data: NetworkData,
  overrides: Readonly<Record<string, string | null | undefined>> = {},
) {
  return resolvedView(data, {
    controls: 'caption projection navigation colormap channels legends',
    projection: 'tilt',
    colormap: 'plasma',
    'vertex-color': 'load',
    'vertex-height': 'load',
    'vertex-size': 'capacity',
    'edge-color': 'flow',
    'edge-dash': 'flow',
    ...overrides,
  });
}

function buttonsByText(root: ParentNode): Map<string, HTMLButtonElement> {
  return new Map(
    [...root.querySelectorAll('button')].map((button) => [
      button.getAttribute('aria-label') ?? button.textContent ?? '',
      button,
    ]),
  );
}

function channelRoot(shell: Shell, token: string): HTMLLabelElement {
  const root = shell.regions.channels.querySelector<HTMLLabelElement>(`[part="channel ${token}"]`);
  if (!root) throw new Error(`Missing ${token} channel control`);
  return root;
}

function channelSelect(shell: Shell, token: string): HTMLSelectElement {
  const select = channelRoot(shell, token).querySelector('select');
  if (!select) throw new Error(`Missing ${token} select`);
  return select;
}

function channelOptions(shell: Shell, token: string): Array<readonly [string, string]> {
  return [...channelSelect(shell, token).options].map(
    (option) => [option.value, option.textContent ?? ''] as const,
  );
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function inspectorToggle(shell: Shell): HTMLButtonElement {
  const toggle = shell.regions.toolbar.querySelector<HTMLButtonElement>(
    '[part~="inspector-toggle"]',
  );
  if (!toggle) throw new Error('Missing inspector toggle');
  return toggle;
}

function legendRoot(shell: Shell, token: string): HTMLDivElement {
  return legendRootFrom(shell.regions.legends, token);
}

function legendRootFrom(container: ParentNode, token: string): HTMLDivElement {
  const root = container.querySelector<HTMLDivElement>(`[part="legend ${token}"]`);
  if (!root) throw new Error(`Missing ${token}`);
  return root;
}

function legendText(container: ParentNode, token: string): [string, string, string] {
  const spans = legendRootFrom(container, token).querySelectorAll('span');
  return [spans[0]?.textContent ?? '', spans[2]?.textContent ?? '', spans[3]?.textContent ?? ''];
}

function legendSwatch(container: ParentNode, token: string): HTMLSpanElement {
  const swatch = legendRootFrom(container, token).querySelector<HTMLSpanElement>(
    '.latkit-legend-swatch',
  );
  if (!swatch) throw new Error(`Missing ${token} swatch`);
  return swatch;
}

function commandSink() {
  return {
    panBy: vi.fn(),
    zoomBy: vi.fn(),
    fit: vi.fn(),
    select: vi.fn(),
  };
}
