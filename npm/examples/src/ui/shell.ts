import type { Gpu } from 'latkit';
import { h } from './dom.js';
import { exportSection } from './export.js';
import { Stage } from './stage.js';

declare global {
  interface Window {
    /** The active example's stage, exposed for the browser gate. */
    stage?: Stage;
  }
}

export interface Page {
  readonly id: string;
  readonly title: string;
  load(): Promise<{ default: (stage: Stage) => Promise<void> | void }>;
}

/** The page layout every example shares: a header with the example picker, the main view, the
 * controls panel, and the timeline. It shows the example named in the URL hash. */
export class Shell {
  readonly #picker = h('select', { 'aria-label': 'Example' });
  readonly #detail = h('p', { class: 'detail' });
  readonly #error = h('div', { role: 'alert', class: 'error', hidden: true });
  readonly #loading = h('p', { class: 'loading', role: 'status', hidden: true }, 'Loading…');
  readonly #regions = {
    main: h('main', { id: 'example', 'aria-label': 'Example' }),
    side: h('aside', { id: 'controls', 'aria-label': 'Controls' }),
    timeline: h('footer', { 'aria-label': 'Playback' }),
  };
  #stage?: Stage;
  #showing = 0;

  constructor(
    private readonly pages: readonly Page[],
    private readonly gpu: Promise<Gpu>,
  ) {
    this.#picker.append(...pages.map(({ id, title }) => h('option', { value: id }, title)));
    this.#picker.addEventListener('change', () => (location.hash = this.#picker.value));
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'controls-toggle',
        'aria-expanded': 'true',
        'aria-controls': 'controls',
      },
      'Controls',
    );
    toggle.addEventListener('click', () => {
      const hidden = !this.#regions.side.hidden;
      this.#regions.side.hidden = hidden;
      toggle.setAttribute('aria-expanded', String(!hidden));
    });
    document.body.append(
      h('a', { class: 'skip-link', href: '#example' }, 'Skip to example'),
      h(
        'header',
        {},
        h('a', { class: 'brand', href: `#${pages[0]!.id}` }, 'latkit'),
        h('label', { class: 'example-picker' }, h('span', {}, 'Examples'), this.#picker),
        this.#detail,
        toggle,
      ),
      this.#error,
      this.#loading,
      this.#regions.main,
      this.#regions.side,
      this.#regions.timeline,
    );
    document.querySelector('.skip-link')!.addEventListener('click', (event) => {
      event.preventDefault();
      this.#regions.main.querySelector('canvas')?.focus();
    });
    addEventListener('hashchange', () => void this.#show());
    void this.#show();
  }

  async #show(): Promise<void> {
    const showing = ++this.#showing;
    const page = this.pages.find((p) => `#${p.id}` === location.hash) ?? this.pages[0]!;
    this.#stage?.close();
    this.#stage = window.stage = undefined;
    this.#error.hidden = true;
    this.#loading.hidden = false;
    this.#regions.main.setAttribute('aria-busy', 'true');
    this.#picker.value = page.id;
    document.title = `${page.title} · latkit`;
    this.#regions.main.setAttribute('aria-label', page.title);
    try {
      const [gpu, module] = await Promise.all([this.gpu, page.load()]);
      if (showing !== this.#showing) return;
      const stage = new Stage(gpu, this.#regions, this.#detail, (error) => {
        if (showing === this.#showing) this.#fail(error);
      });
      this.#stage = window.stage = stage;
      await module.default(stage);
      if (showing === this.#showing && !stage.signal.aborted) {
        for (const section of this.#regions.side.querySelectorAll('.performance')) {
          this.#regions.side.append(section);
        }
        exportSection(stage);
      }
    } catch (error) {
      if (showing === this.#showing) this.#fail(error);
    } finally {
      if (showing === this.#showing) {
        this.#loading.hidden = true;
        this.#regions.main.removeAttribute('aria-busy');
      }
    }
  }

  #fail(error: unknown): void {
    this.#stage?.close();
    this.#stage = window.stage = undefined;
    this.#error.hidden = false;
    const unsupported = (error as { code?: string }).code === 'unsupported';
    this.#error.replaceChildren(
      h(
        'p',
        {},
        unsupported
          ? 'WebGPU is unavailable. Open these examples in a browser with WebGPU enabled.'
          : `Could not load this example. ${String(error)}`,
      ),
    );
    const retry = h('button', { type: 'button' }, 'Reload');
    retry.addEventListener('click', () => location.reload());
    this.#error.append(retry);
    console.error(error);
  }
}
