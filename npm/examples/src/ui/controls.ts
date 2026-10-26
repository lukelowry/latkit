import type { Scene, View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A button that calls `run`, with an optional `key` that also calls it. */
export interface Action {
  label: string;
  key?: string;
  run: () => void;
}

/** The key label shown on a button, if there is a key. */
const kbd = (key: string | undefined) =>
  key ? [h('kbd', {}, key === ' ' ? 'Space' : key.toUpperCase())] : [];

/** A titled group of controls in the side panel. */
export class Section {
  readonly element: HTMLElement;
  readonly content = h('div', { class: 'section-body' });
  /** The row that holds the toggles, created on first use. */
  #toggles?: HTMLElement;

  constructor(
    private readonly stage: Stage,
    title: string,
    open = true,
  ) {
    this.element = h('details', { class: 'section', open }, h('summary', {}, title), this.content);
  }

  /** Adds a grid of buttons. Each button's key, if any, also runs it. */
  actions(actions: readonly Action[]): void {
    const row = h('div', { class: 'actions' });
    for (const { label, key, run } of actions) {
      const button = h('button', { type: 'button' }, label, ...kbd(key));
      button.addEventListener('click', run, { signal: this.stage.signal });
      if (key) this.stage.key(key, run);
      row.append(button);
    }
    this.content.append(row);
  }

  /** Adds a toggle button, which its key, if any, also flips. Returns a setter for changes made
   * elsewhere. */
  toggle(
    label: string,
    key: string | undefined,
    value: boolean,
    change: (on: boolean) => void,
  ): (on: boolean) => void {
    const pressed = String(value);
    const button = h('button', { type: 'button', 'aria-pressed': pressed }, label, ...kbd(key));
    const set = (on: boolean) => {
      button.setAttribute('aria-pressed', String(on));
      change(on);
    };
    const flip = () => set(button.getAttribute('aria-pressed') !== 'true');
    button.addEventListener('click', flip, { signal: this.stage.signal });
    if (key) this.stage.key(key, flip);
    if (!this.#toggles) this.content.append((this.#toggles = h('div', { class: 'actions' })));
    this.#toggles.append(button);
    return set;
  }

  /** Adds a slider that shows its value through `format` and calls `change` as it moves. Returns
   * the input so the page can change it. */
  range(
    label: string,
    o: { min: number; max: number; step: number; value: number; format: (value: number) => string },
    change: (value: number) => void,
  ): HTMLInputElement {
    const input = h('input', {
      type: 'range',
      min: o.min,
      max: o.max,
      step: o.step,
      value: o.value,
    });
    const output = h('output', {}, o.format(input.valueAsNumber));
    input.addEventListener(
      'input',
      () => {
        output.value = o.format(input.valueAsNumber);
        change(input.valueAsNumber);
      },
      { signal: this.stage.signal },
    );
    this.content.append(h('label', { class: 'field' }, h('span', {}, label, output), input));
    return input;
  }

  /** Adds a dropdown of labeled `options`. Returns the select so the page can change it. */
  choice<T>(
    label: string,
    options: readonly (readonly [string, T])[],
    value: T,
    change: (value: T) => void,
  ): HTMLSelectElement {
    const select = h(
      'select',
      {},
      ...options.map(([name, v], i) => h('option', { value: i, selected: v === value }, name)),
    );
    select.addEventListener('change', () => change(options[select.selectedIndex]![1]), {
      signal: this.stage.signal,
    });
    this.content.append(h('label', { class: 'field' }, h('span', {}, label), select));
    return select;
  }

  /** Adds color swatches that label the series a view draws. */
  series(items: readonly { label: string; color: string }[]): HTMLElement {
    const swatches = items.map(({ label, color }) =>
      h('span', { style: `--swatch: ${color}` }, label),
    );
    const line = h('p', { class: 'series' }, ...swatches);
    this.content.append(line);
    return line;
  }

  /** Adds a line of text for the page to keep up to date. */
  note(text = ''): HTMLParagraphElement {
    const line = h('p', { class: 'note' }, text);
    this.content.append(line);
    return line;
  }

  /** Creates a view inside this section. */
  view(scene: Scene, options: { label: string; height?: number }): View {
    return this.stage.view(scene, { ...options, into: this.content });
  }

  /** Adds the standard playback speed control. */
  speed(rates: readonly number[], value: number, change: (value: number) => void): void {
    this.choice(
      'Speed',
      rates.map((rate) => [`${rate}×`, rate] as const),
      value,
      change,
    );
  }

  /** Adds a labeled text field, such as for a selected item's name. */
  text(label: string, change: (value: string) => void): HTMLInputElement {
    const input = h('input', { type: 'text' });
    input.addEventListener('change', () => change(input.value), { signal: this.stage.signal });
    this.content.append(h('label', { class: 'field' }, h('span', {}, label), input));
    return input;
  }
}
