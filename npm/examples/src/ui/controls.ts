import type { Scene, View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** A button that runs `run`, and the key that runs it too. */
export interface Action {
  label: string;
  key: string;
  run: () => void;
}

const keyName = (key: string) => (key === ' ' ? 'Space' : key.toUpperCase());

/** A titled group of controls in the side panel. */
export class Section {
  readonly element: HTMLElement;
  readonly content = h('div', { class: 'section-body' });
  /** The row toggles share, made on first use. */
  #toggles?: HTMLElement;

  constructor(
    private readonly stage: Stage,
    title: string,
    open = true,
  ) {
    this.element = h('details', { class: 'section', open }, h('summary', {}, title), this.content);
  }

  /** Buttons in a grid, each also run by its key. */
  actions(actions: readonly Action[]): void {
    const row = h('div', { class: 'actions' });
    for (const { label, key, run } of actions) {
      const button = h('button', { type: 'button' }, label, h('kbd', {}, keyName(key)));
      button.addEventListener('click', run, { signal: this.stage.signal });
      this.stage.key(key, run);
      row.append(button);
    }
    this.content.append(row);
  }

  /** A button that stays pressed, also flipped by its key. Returns a setter for outside changes. */
  toggle(
    label: string,
    key: string,
    value: boolean,
    change: (on: boolean) => void,
  ): (on: boolean) => void {
    const pressed = String(value);
    const button = h(
      'button',
      { type: 'button', 'aria-pressed': pressed },
      label,
      h('kbd', {}, keyName(key)),
    );
    const set = (on: boolean) => {
      button.setAttribute('aria-pressed', String(on));
      change(on);
    };
    const flip = () => set(button.getAttribute('aria-pressed') !== 'true');
    button.addEventListener('click', flip, { signal: this.stage.signal });
    this.stage.key(key, flip);
    if (!this.#toggles) this.content.append((this.#toggles = h('div', { class: 'actions' })));
    this.#toggles.append(button);
    return set;
  }

  /** A slider with its value shown through `format`. */
  range(
    label: string,
    o: { min: number; max: number; step: number; value: number; format: (value: number) => string },
    change: (value: number) => void,
  ): void {
    const input = h('input', {
      type: 'range',
      min: o.min,
      max: o.max,
      step: o.step,
      value: o.value,
    });
    const output = h('output');
    const update = () => {
      output.value = o.format(input.valueAsNumber);
      change(input.valueAsNumber);
    };
    input.addEventListener('input', update, { signal: this.stage.signal });
    update();
    this.content.append(h('label', { class: 'field' }, h('span', {}, label, output), input));
  }

  /** One of several options; returns the select, for outside changes. */
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

  /** Swatches naming the series a view draws. */
  series(items: readonly { label: string; color: string }[]): HTMLElement {
    const swatches = items.map(({ label, color }) =>
      h('span', { style: `--swatch: ${color}` }, label),
    );
    const line = h('p', { class: 'series' }, ...swatches);
    this.content.append(line);
    return line;
  }

  /** A line of text the page keeps up to date. */
  note(text = ''): HTMLParagraphElement {
    const line = h('p', { class: 'note' }, text);
    this.content.append(line);
    return line;
  }

  /** A view inside this section. */
  view(scene: Scene, options: { label: string; height?: number }): View {
    return this.stage.view(scene, { ...options, into: this.content });
  }

  /** Standard playback speed control. */
  speed(rates: readonly number[], value: number, change: (value: number) => void): void {
    this.choice(
      'Speed',
      rates.map((rate) => [`${rate}×`, rate] as const),
      value,
      change,
    );
  }

  /** A labeled text field, such as a selected item's name. */
  text(label: string, change: (value: string) => void): HTMLInputElement {
    const input = h('input', { type: 'text' });
    input.addEventListener('change', () => change(input.value), { signal: this.stage.signal });
    this.content.append(h('label', { class: 'field' }, h('span', {}, label), input));
    return input;
  }
}
