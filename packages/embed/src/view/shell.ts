import type { NetworkData } from '../data/types.js';
import { SHELL_STYLES } from './styles.js';

/** Stable shadow-DOM regions populated by the chrome coordinator. */
export interface ChromeRegions {
  readonly root: HTMLDivElement;
  readonly caption: HTMLOutputElement;
  readonly toolbar: HTMLDivElement;
  readonly projection: HTMLFieldSetElement;
  readonly navigation: HTMLFieldSetElement;
  readonly inspector: HTMLDivElement;
  readonly colormap: HTMLLabelElement;
  readonly channels: HTMLFieldSetElement;
  readonly legends: HTMLDivElement;
  readonly live: HTMLOutputElement;
}

/** Element-owned renderer, chrome, live-region, and fallback surfaces. */
export interface Shell {
  readonly canvas: HTMLCanvasElement;
  readonly regions: ChromeRegions;
  showFallback(): void;
  showLive(data: NetworkData): void;
}

/** Create every stable shadow-tree region once for an element instance. */
export function createShell(host: HTMLElement): Shell {
  installDefaultRole(host);

  const document = host.ownerDocument;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHELL_STYLES;

  const stage = document.createElement('div');
  stage.setAttribute('part', 'stage');
  stage.hidden = true;
  stage.setAttribute('aria-hidden', 'true');

  const canvas = document.createElement('canvas');
  canvas.setAttribute('part', 'canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-describedby', 'latkit-canvas-instructions');
  canvas.tabIndex = 0;
  const instructions = document.createElement('span');
  instructions.id = 'latkit-canvas-instructions';
  instructions.className = 'latkit-visually-hidden';
  instructions.textContent =
    'Use the arrow keys to pan, plus and minus to zoom, Home to fit the network, and Escape to clear the selection.';
  stage.append(canvas, instructions);

  const chrome = document.createElement('div');
  chrome.setAttribute('part', 'chrome');
  chrome.hidden = true;
  chrome.setAttribute('aria-hidden', 'true');

  const rail = document.createElement('div');
  rail.className = 'latkit-rail';

  const caption = document.createElement('output');
  caption.setAttribute('part', 'caption');
  caption.setAttribute('role', 'note');
  caption.dataset.state = 'idle';
  caption.hidden = true;

  const toolbar = document.createElement('div');
  toolbar.setAttribute('part', 'toolbar');
  toolbar.hidden = true;

  const projection = document.createElement('fieldset');
  projection.setAttribute('part', 'projection');
  projection.hidden = true;

  const navigation = document.createElement('fieldset');
  navigation.setAttribute('part', 'navigation');
  navigation.hidden = true;

  const inspector = document.createElement('div');
  inspector.setAttribute('part', 'inspector');
  inspector.id = 'latkit-inspector';
  inspector.setAttribute('role', 'group');
  inspector.setAttribute('aria-label', 'Display settings');
  inspector.hidden = true;

  const colormap = document.createElement('label');
  colormap.setAttribute('part', 'colormap');
  colormap.hidden = true;

  const channels = document.createElement('fieldset');
  channels.setAttribute('part', 'channels');
  channels.hidden = true;

  const legends = document.createElement('div');
  legends.setAttribute('part', 'legends');
  legends.hidden = true;

  toolbar.append(projection, navigation);
  rail.append(caption, toolbar);
  inspector.append(colormap, channels);
  chrome.append(rail, inspector, legends);

  const live = document.createElement('output');
  live.setAttribute('part', 'live');
  live.className = 'latkit-visually-hidden';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.hidden = true;
  live.setAttribute('aria-hidden', 'true');

  const fallback = document.createElement('slot');
  fallback.setAttribute('part', 'fallback');

  root.append(style, stage, chrome, live, fallback);

  const regions: ChromeRegions = {
    root: chrome,
    caption,
    toolbar,
    projection,
    navigation,
    inspector,
    colormap,
    channels,
    legends,
    live,
  };
  let focusedLiveElement: HTMLElement | null = null;

  return {
    canvas,
    regions,
    showFallback() {
      const active = root.activeElement;
      if (
        active &&
        (stage.contains(active) || chrome.contains(active)) &&
        typeof (active as HTMLElement).focus === 'function'
      ) {
        focusedLiveElement = active as HTMLElement;
      }
      setExposed(stage, false);
      setExposed(chrome, false);
      setExposed(live, false);
      setExposed(fallback, true);
    },
    showLive(data) {
      const edges = data.topology.edges.length / 2;
      canvas.setAttribute(
        'aria-label',
        `Network with ${data.topology.vertexCount} vertices and ${edges} edges`,
      );
      setExposed(fallback, false);
      setExposed(stage, true);
      setExposed(chrome, true);
      setExposed(live, true);
      const active = document.activeElement;
      const mayRestoreFocus =
        active === null ||
        active === document.body ||
        active === host ||
        active === focusedLiveElement;
      if (focusedLiveElement?.isConnected && mayRestoreFocus) {
        focusedLiveElement.focus({ preventScroll: true });
      }
      focusedLiveElement = null;
    },
  };
}

/** Keep visual and assistive-technology exposure in the same state. */
function setExposed(element: HTMLElement, exposed: boolean): void {
  element.hidden = !exposed;
  if (exposed) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', 'true');
}

/** Install default group semantics without replacing an author-supplied role. */
function installDefaultRole(host: HTMLElement): void {
  if (typeof host.attachInternals !== 'function') return;
  try {
    host.attachInternals().role = 'group';
  } catch {
    // Some DOM implementations expose attachInternals without supporting it.
  }
}
