import { COLORMAPS, type ColormapName } from '@latkit/colormaps';
import { PROJECTIONS, type Network, type Projection } from '@latkit/network';

import { CHANNEL_ATTRIBUTES, type ChannelAttributeDefinition } from './attributes.js';
import { humanizeName } from './format.js';
import type { FieldCatalog } from './fields.js';
import { ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR, type InteractionCommandSink } from './interaction.js';
import type { InteractionState, ViewState } from './state.js';
import type { ChromeRegions } from './shell.js';

/** Durable public-element sink used by controls instead of the private Network. */
export interface HostCommandSink extends InteractionCommandSink {
  setAttribute(name: string, value: string): void;
}

/** Stable built-in buttons and selectors. */
export interface Controls {
  update(
    fields: FieldCatalog,
    view: ViewState,
    projections: Network['projections'],
    interaction: InteractionState,
  ): void;
  reset(): void;
}

interface ChannelControl {
  readonly definition: ChannelAttributeDefinition;
  readonly root: HTMLLabelElement;
  readonly select: HTMLSelectElement;
  synthetic: HTMLOptionElement | null;
}

interface ChannelControls {
  readonly entries: readonly ChannelControl[];
  readonly scopes: Readonly<Record<'vertex' | 'edge', HTMLDivElement>>;
}

/** Create all supported controls once and bind them to the durable host sink. */
export function createControls(regions: ChromeRegions, host: HostCommandSink): Controls {
  const document = regions.root.ownerDocument;
  const projectionButtons = createProjectionControls(document, regions.projection, host);
  const navigation = createNavigationControls(document, regions.navigation, host);
  const colormap = createColormapControl(document, regions.colormap, host);
  const channels = createChannelControls(document, regions.channels, host);
  const inspectorToggle = createInspectorToggle(document, regions.inspector);
  regions.toolbar.append(inspectorToggle);
  let currentFields: FieldCatalog | null = null;

  // The inspector is a disclosure: it opens by default only for explicit
  // control lists, and a user's own toggle choice always wins afterwards.
  let inspectorAvailable = false;
  let inspectorDefaultOpen = false;
  let inspectorPreference: boolean | null = null;

  function inspectorOpen(): boolean {
    return inspectorAvailable && (inspectorPreference ?? inspectorDefaultOpen);
  }

  function syncInspector(): void {
    const open = inspectorOpen();
    regions.inspector.hidden = !open;
    inspectorToggle.hidden = !inspectorAvailable;
    inspectorToggle.setAttribute('aria-expanded', String(open));
    regions.toolbar.hidden =
      regions.projection.hidden && regions.navigation.hidden && !inspectorAvailable;
  }

  inspectorToggle.addEventListener('click', () => {
    inspectorPreference = !inspectorOpen();
    syncInspector();
  });
  regions.inspector.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !inspectorOpen()) return;
    event.preventDefault();
    inspectorPreference = false;
    syncInspector();
    inspectorToggle.focus();
  });

  return {
    update(fields, view, projections, interaction) {
      if (fields !== currentFields) {
        currentFields = fields;
        rebuildFieldOptions(document, channels.entries, fields);
      }

      regions.projection.hidden = !view.controls.has('projection');
      for (const [mode, button] of projectionButtons) {
        button.disabled = !projections[mode];
        button.setAttribute('aria-pressed', String(view.projection === mode));
      }

      const showFit = view.controls.has('fit');
      const showZoom = view.controls.has('zoom');
      regions.navigation.hidden = !showFit && !showZoom;
      navigation.fit.hidden = !showFit;
      navigation.fit.disabled = interaction.atFitView;
      navigation.zoomIn.hidden = !showZoom;
      navigation.zoomOut.hidden = !showZoom;
      regions.root.classList.toggle(
        'latkit-has-toolbar',
        !regions.projection.hidden || !regions.navigation.hidden,
      );

      regions.colormap.hidden = !view.controls.has('colormap');
      colormap.select.disabled = !colormapApplicable(fields, view);
      syncColormap(colormap, view);
      regions.root.classList.toggle('latkit-has-colormap', !regions.colormap.hidden);

      let visibleChannel = false;
      const visibleScope = { vertex: false, edge: false };
      for (const control of channels.entries) {
        const visible = view.controls.has(control.definition.attribute);
        control.root.hidden = !visible;
        visibleChannel ||= visible;
        visibleScope[control.definition.scope] ||= visible;
        syncChannel(control, fields, view);
      }
      channels.scopes.vertex.hidden = !visibleScope.vertex;
      channels.scopes.edge.hidden = !visibleScope.edge;
      regions.channels.hidden = !visibleChannel;
      regions.root.classList.toggle('latkit-has-channels', visibleChannel);
      regions.root.classList.toggle(
        'latkit-has-encodings',
        !regions.colormap.hidden || !regions.channels.hidden,
      );

      inspectorAvailable = !regions.colormap.hidden || !regions.channels.hidden;
      inspectorDefaultOpen = view.controlsMode === 'explicit';
      syncInspector();
    },
    reset() {
      regions.root.classList.remove(
        'latkit-has-toolbar',
        'latkit-has-encodings',
        'latkit-has-colormap',
        'latkit-has-channels',
      );
      regions.projection.hidden = true;
      for (const button of projectionButtons.values()) {
        button.disabled = true;
        button.setAttribute('aria-pressed', 'false');
      }
      regions.navigation.hidden = true;
      navigation.fit.hidden = true;
      navigation.fit.disabled = false;
      navigation.zoomIn.hidden = true;
      navigation.zoomOut.hidden = true;
      regions.colormap.hidden = true;
      colormap.select.disabled = true;
      regions.channels.hidden = true;
      channels.scopes.vertex.hidden = true;
      channels.scopes.edge.hidden = true;
      for (const control of channels.entries) {
        control.root.hidden = true;
        control.select.disabled = true;
      }
      inspectorAvailable = false;
      inspectorDefaultOpen = false;
      inspectorPreference = null;
      syncInspector();
    },
  };
}

function createInspectorToggle(document: Document, inspector: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'latkit-command';
  button.setAttribute('part', 'inspector-toggle');
  button.title = 'Display settings';
  button.setAttribute('aria-label', 'Display settings');
  button.setAttribute('aria-controls', inspector.id);
  button.setAttribute('aria-expanded', 'false');
  button.hidden = true;
  button.append(strokeIcon(document, COMMAND_ICON_PATHS.settings));
  return button;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Stroke path data for one 16x16 projection glyph per canonical mode. */
const PROJECTION_ICON_PATHS: Readonly<Record<Projection, readonly string[]>> = Object.freeze({
  flat: Object.freeze(['M1.5 3.5h13v9h-13z', 'M1.5 8h13', 'M8 3.5v9']),
  tilt: Object.freeze(['M4.5 4.5h7l3 7h-13z', 'M3.25 8h9.5', 'M8 4.5v7']),
  globe: Object.freeze([
    'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z',
    'M1.5 8h13',
    'M8 1.5c-2.2 1.6-3.3 3.9-3.3 6.5s1.1 4.9 3.3 6.5c2.2-1.6 3.3-3.9 3.3-6.5S10.2 3.1 8 1.5z',
  ]),
});

/** Stroke path data for the 16x16 navigation command glyphs. */
const COMMAND_ICON_PATHS = Object.freeze({
  fit: Object.freeze(['M5.5 2.5h-3v3', 'M10.5 2.5h3v3', 'M5.5 13.5h-3v-3', 'M10.5 13.5h3v-3']),
  zoomIn: Object.freeze(['M8 4.75v6.5', 'M4.75 8h6.5']),
  zoomOut: Object.freeze(['M4.75 8h6.5']),
  settings: Object.freeze([
    'M2.5 4.75h11',
    'M2.5 8h11',
    'M2.5 11.25h11',
    'M6 3.25v3',
    'M10.5 6.5v3',
    'M4.5 9.75v3',
  ]),
});

function strokeIcon(document: Document, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.25');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const data of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

function createProjectionControls(
  document: Document,
  fieldset: HTMLFieldSetElement,
  host: HostCommandSink,
): ReadonlyMap<Projection, HTMLButtonElement> {
  const legend = document.createElement('legend');
  legend.textContent = 'Projection';
  const row = document.createElement('div');
  row.className = 'latkit-segments';
  fieldset.append(legend, row);
  const buttons = new Map<Projection, HTMLButtonElement>();
  for (const mode of PROJECTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    const label = humanizeName(mode);
    button.className = 'latkit-segment';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    button.append(strokeIcon(document, PROJECTION_ICON_PATHS[mode]));
    button.addEventListener('click', () => host.setAttribute('projection', mode));
    row.append(button);
    buttons.set(mode, button);
  }
  return buttons;
}

function createNavigationControls(
  document: Document,
  fieldset: HTMLFieldSetElement,
  host: HostCommandSink,
): {
  readonly fit: HTMLButtonElement;
  readonly zoomIn: HTMLButtonElement;
  readonly zoomOut: HTMLButtonElement;
} {
  const legend = document.createElement('legend');
  legend.textContent = 'Navigation';
  const row = document.createElement('div');
  row.className = 'latkit-command-row';
  const fit = commandButton(document, 'Fit view', COMMAND_ICON_PATHS.fit, () => host.fit(true));
  const zoomIn = commandButton(document, 'Zoom in', COMMAND_ICON_PATHS.zoomIn, () =>
    host.zoomBy(ZOOM_IN_FACTOR),
  );
  const zoomOut = commandButton(document, 'Zoom out', COMMAND_ICON_PATHS.zoomOut, () =>
    host.zoomBy(ZOOM_OUT_FACTOR),
  );
  row.append(fit, zoomIn, zoomOut);
  fieldset.append(legend, row);
  return { fit, zoomIn, zoomOut };
}

function commandButton(
  document: Document,
  label: string,
  paths: readonly string[],
  command: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'latkit-command';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(strokeIcon(document, paths));
  button.addEventListener('click', command);
  return button;
}

function createColormapControl(
  document: Document,
  root: HTMLLabelElement,
  host: HostCommandSink,
): { readonly select: HTMLSelectElement; synthetic: HTMLOptionElement | null } {
  const text = document.createElement('span');
  text.textContent = 'Colormap';
  text.className = 'latkit-control-label';
  const select = document.createElement('select');
  for (const name of Object.keys(COLORMAPS) as ColormapName[]) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = COLORMAPS[name].label;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const option = select.selectedOptions[0];
    if (!option || option.dataset.latkitSynthetic === 'true') return;
    host.setAttribute('colormap', option.value);
  });
  root.append(text, select);
  return { select, synthetic: null };
}

function createChannelControls(
  document: Document,
  fieldset: HTMLFieldSetElement,
  host: HostCommandSink,
): ChannelControls {
  const legend = document.createElement('legend');
  legend.textContent = 'Encodings';
  const scopes = {
    vertex: createChannelScope(document, 'Vertices', 'vertex'),
    edge: createChannelScope(document, 'Edges', 'edge'),
  } as const;
  const groups = document.createElement('div');
  groups.className = 'latkit-channel-groups';
  groups.append(scopes.vertex.root, scopes.edge.root);
  fieldset.append(legend, groups);
  const entries = CHANNEL_ATTRIBUTES.map((definition) => {
    const root = document.createElement('label');
    root.setAttribute('part', `channel ${definition.attribute}`);
    root.hidden = true;
    const text = document.createElement('span');
    text.textContent = definition.label;
    text.className = 'latkit-control-label';
    const select = document.createElement('select');
    select.addEventListener('change', () => {
      const option = select.selectedOptions[0];
      if (!option || option.dataset.latkitSynthetic === 'true') return;
      host.setAttribute(definition.attribute, option.value);
    });
    root.append(text, select);
    scopes[definition.scope].fields.append(root);
    return { definition, root, select, synthetic: null };
  });
  return {
    entries,
    scopes: { vertex: scopes.vertex.root, edge: scopes.edge.root },
  };
}

function createChannelScope(
  document: Document,
  label: string,
  scope: 'vertex' | 'edge',
): { readonly root: HTMLDivElement; readonly fields: HTMLDivElement } {
  const root = document.createElement('div');
  root.className = 'latkit-channel-scope';
  root.dataset.scope = scope;
  root.setAttribute('role', 'group');
  const heading = document.createElement('span');
  heading.className = 'latkit-scope-label';
  heading.id = `latkit-${scope}-channels-label`;
  heading.textContent = label;
  root.setAttribute('aria-labelledby', heading.id);
  const fields = document.createElement('div');
  fields.className = 'latkit-channel-fields';
  root.append(heading, fields);
  return { root, fields };
}

function rebuildFieldOptions(
  document: Document,
  controls: readonly ChannelControl[],
  fields: FieldCatalog,
): void {
  for (const control of controls) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    const options: HTMLOptionElement[] = [none];
    for (const entry of fields[control.definition.scope]) {
      const option = document.createElement('option');
      option.value = entry.field.id;
      option.textContent = entry.field.label;
      options.push(option);
    }
    control.select.replaceChildren(...options);
    control.synthetic = null;
  }
}

function syncColormap(
  control: { readonly select: HTMLSelectElement; synthetic: HTMLOptionElement | null },
  view: ViewState,
): void {
  if (view.colormap.kind === 'custom') {
    control.synthetic ??= syntheticOption(control.select.ownerDocument, 'Custom');
    if (!control.synthetic.isConnected) control.select.append(control.synthetic);
    selectOnly(control.select, control.synthetic);
    return;
  }

  control.synthetic?.remove();
  selectValue(control.select, view.colormap.name);
}

function colormapApplicable(fields: FieldCatalog, view: ViewState): boolean {
  return CHANNEL_ATTRIBUTES.some(
    (definition) =>
      definition.map === 'colormap' &&
      (view.channels[definition.key] !== null ||
        (view.controls.has(definition.attribute) && fields[definition.scope].length > 0)),
  );
}

function syncChannel(control: ChannelControl, fields: FieldCatalog, view: ViewState): void {
  const binding = view.channels[control.definition.key];
  control.select.disabled =
    fields[control.definition.scope].length === 0 && binding?.kind !== 'direct';

  if (binding?.kind === 'direct') {
    control.synthetic ??= syntheticOption(control.select.ownerDocument, 'Custom values');
    if (!control.synthetic.isConnected) control.select.append(control.synthetic);
    selectOnly(control.select, control.synthetic);
    return;
  }

  control.synthetic?.remove();
  selectValue(control.select, binding?.kind === 'field' ? binding.entry.field.id : '');
}

function syntheticOption(document: Document, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = '';
  option.textContent = label;
  option.disabled = true;
  option.dataset.latkitSynthetic = 'true';
  return option;
}

function selectValue(select: HTMLSelectElement, value: string): void {
  for (const option of select.options) {
    option.selected = option.dataset.latkitSynthetic !== 'true' && option.value === value;
  }
}

function selectOnly(select: HTMLSelectElement, selected: HTMLOptionElement): void {
  for (const option of select.options) option.selected = option === selected;
}
