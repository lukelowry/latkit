/** Small DOM builders for the page's panel: sections, selects, toggles, segmented choices, legends. */
import { colormapCss, type Colormap } from '@latkit/gpu';

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props))
    if (value !== undefined) node.setAttribute(key === 'className' ? 'class' : key, value);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

/** A collapsible section of the panel; its body holds its rows. */
export function section(parent: HTMLElement, title: string, open = true): HTMLElement {
  const body = element('div', { className: 'body' }),
    details = element('details', { className: 'section' }, element('summary', {}, title), body);
  details.open = open;
  parent.append(details);
  return body;
}

/** A labeled row: a name, then its controls, wrapping as they need. */
export function field(parent: HTMLElement, label: string, ...controls: Node[]): HTMLElement {
  const row = element(
    'div',
    { className: 'field' },
    element('span', { className: 'name' }, label),
    element('div', { className: 'controls' }, ...controls),
  );
  parent.append(row);
  return row;
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly group?: string;
}
/** A select of choices, grouped where they name groups. */
export function choose(
  choices: readonly Choice[],
  value: string,
  change: (value: string) => void,
  label: string,
): HTMLSelectElement {
  const select = element('select', { 'aria-label': label }),
    groups = new Map<string, HTMLOptGroupElement>();
  for (const choice of choices) {
    const option = new Option(choice.label, choice.value);
    if (!choice.group) {
      select.append(option);
      continue;
    }
    let group = groups.get(choice.group);
    if (!group) {
      group = element('optgroup', { label: choice.group });
      groups.set(choice.group, group);
      select.append(group);
    }
    group.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => change(select.value));
  return select;
}
/** Replace a select's choices, keeping its value where it still is one. */
export function rechoose(
  select: HTMLSelectElement,
  choices: readonly Choice[],
  value: string,
): void {
  select.replaceChildren(...choices.map((c) => new Option(c.label, c.value)));
  select.value = choices.some((c) => c.value === value) ? value : (choices[0]?.value ?? '');
}

/** A button that toggles. */
export function toggle(
  label: string,
  on: boolean,
  change: (on: boolean) => void,
): HTMLButtonElement {
  const button = element('button', { type: 'button', className: 'toggle' }, label);
  let state = on;
  const show = () => {
    button.classList.toggle('on', state);
    button.setAttribute('aria-pressed', String(state));
  };
  show();
  button.addEventListener('click', () => {
    state = !state;
    show();
    change(state);
  });
  return button;
}

/** A range over [min, max], reporting each value as it moves. */
export function slider(
  label: string,
  [min, max]: readonly [number, number],
  input: (value: number) => void,
): HTMLInputElement {
  const range = element('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: 'any',
    value: String(min),
    'aria-label': label,
  });
  range.addEventListener('input', () => input(Number(range.value)));
  return range;
}

export interface LegendEntry {
  readonly label: string;
  readonly color: string;
}
/** A colormap from one end's label to the other's. */
export interface LegendRamp {
  readonly colormap: Colormap;
  readonly from: string;
  readonly to: string;
}
/** A key to what colors mean: a colormap from one end to the other, or one swatch per category. */
export function legend(
  parent: HTMLElement,
): (key: LegendRamp | readonly LegendEntry[] | null) => void {
  const root = element('div', { className: 'legend' });
  parent.append(root);
  return (key) => {
    root.hidden = !key;
    if (!key) return root.replaceChildren();
    if (!('colormap' in key)) {
      root.replaceChildren(
        ...key.map((entry) =>
          element(
            'span',
            { className: 'category' },
            element('i', { style: `background:${entry.color}` }),
            entry.label,
          ),
        ),
      );
      return;
    }
    const { colormap, from, to } = key,
      ramp = element('span', { className: 'ramp' });
    ramp.style.background = colormapCss(colormap, { direction: 'to right' });
    root.replaceChildren(element('span', {}, from), ramp, element('span', {}, to));
  };
}

export interface Segmented {
  readonly root: HTMLElement;
  set(value: string): void;
  enable(value: string, enabled: boolean): void;
}
/** One of a few choices, side by side. */
export function segmented(
  choices: readonly Choice[],
  value: string,
  change: (value: string) => void,
  label: string,
): Segmented {
  const root = element('div', { className: 'segmented', role: 'radiogroup', 'aria-label': label }),
    buttons = new Map<string, HTMLButtonElement>();
  const set = (next: string) => {
    for (const [v, b] of buttons) {
      b.classList.toggle('on', v === next);
      b.setAttribute('aria-checked', String(v === next));
    }
  };
  for (const choice of choices) {
    const button = element('button', { type: 'button', role: 'radio' }, choice.label);
    button.addEventListener('click', () => {
      set(choice.value);
      change(choice.value);
    });
    buttons.set(choice.value, button);
    root.append(button);
  }
  set(value);
  return {
    root,
    set,
    enable: (v, enabled) => {
      const b = buttons.get(v);
      if (b) b.disabled = !enabled;
    },
  };
}

export function button(label: string, click: () => void): HTMLButtonElement {
  const b = element('button', { type: 'button' }, label);
  b.addEventListener('click', click);
  return b;
}
/** A grid of named numbers, updated in place. */
export function stats(
  parent: HTMLElement,
  names: readonly string[],
): (values: Record<string, string>) => void {
  const cells = new Map<string, HTMLElement>(),
    grid = element('dl', { className: 'stats' });
  for (const name of names) {
    const value = element('dd', {}, '–');
    cells.set(name, value);
    grid.append(element('dt', {}, name), value);
  }
  parent.append(grid);
  return (values) => {
    for (const [name, value] of Object.entries(values)) {
      const cell = cells.get(name);
      if (cell && cell.textContent !== value) cell.textContent = value;
    }
  };
}
