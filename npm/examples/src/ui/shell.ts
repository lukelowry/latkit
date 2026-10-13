import type { Gpu } from 'latkit';
import { h } from './dom.js';
import { Stage } from './stage.js';

/** A page of the suite: what the bar shows, and the module that draws it into a stage. */
export interface Page {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  load(): Promise<{ default: (stage: Stage) => Promise<void> | void }>;
}

/** The suite: one GPU, the page bar, and the regions every page draws into. */
export class Shell {
  readonly #title = h('h1');
  readonly #summary = h('p', { class: 'summary' });
  readonly #detail = h('p', { class: 'detail' });
  readonly #error = h('div', { role: 'alert', class: 'error', hidden: true });
  readonly #regions = { main: h('main'), side: h('aside'), timeline: h('footer') };
  #stage?: Stage;
  #showing = 0;

  constructor(
    private readonly pages: readonly Page[],
    private readonly gpu: Promise<Gpu>,
  ) {
    const links = pages.map((page) => h('a', { href: `#${page.id}` }, page.title));
    document.body.append(
      h(
        'header',
        {},
        h('a', { class: 'brand', href: '#' }, 'latkit'),
        h('nav', { 'aria-label': 'Examples' }, ...links),
      ),
      h('section', { class: 'intro' }, h('div', {}, this.#title, this.#summary), this.#detail),
      this.#error,
      this.#regions.main,
      this.#regions.side,
      this.#regions.timeline,
    );
    addEventListener('hashchange', () => void this.#show());
    void this.#show();
  }

  async #show(): Promise<void> {
    const showing = ++this.#showing;
    const page = this.pages.find((p) => `#${p.id}` === location.hash) ?? this.pages[0]!;
    this.#stage?.close();
    this.#stage = undefined;
    this.#error.hidden = true;
    document.title = `${page.title} · latkit`;
    this.#title.textContent = page.title;
    this.#summary.textContent = page.summary;
    for (const link of document.querySelectorAll('nav a')) {
      if (link.getAttribute('href') === `#${page.id}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    try {
      const [gpu, module] = await Promise.all([this.gpu, page.load()]);
      if (showing !== this.#showing) return;
      const stage = new Stage(gpu, this.#regions, this.#detail, (error) => this.#fail(error));
      this.#stage = stage;
      await module.default(stage);
    } catch (error) {
      if (showing === this.#showing) this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    this.#stage?.close();
    this.#stage = undefined;
    this.#error.hidden = false;
    const unsupported = (error as { code?: string }).code === 'unsupported';
    this.#error.textContent = unsupported
      ? `This page needs WebGPU, which this browser does not offer: ${String(error)}`
      : `Stopped: ${String(error)}`;
    console.error(error);
  }
}
