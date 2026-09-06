import '@latkit/embed/register';
import type { Projection } from '@latkit/network';

import './style.css';

const network = document.querySelector('latkit-network');
const monitor = document.querySelector('latkit-monitor');
const status = document.querySelector<HTMLElement>('#status')!;
const hover = document.querySelector<HTMLElement>('#hover')!;
const reading = document.querySelector<HTMLElement>('#reading')!;

if (!network || !monitor) throw new Error('embed example elements are missing');

// The element reports its data source; the page decides what to say about it.
void network.ready.then(
  () => {
    status.textContent = 'live';
    status.dataset.state = 'live';
  },
  (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : 'unavailable';
    status.dataset.state = 'error';
  },
);

// Controller events arrive as DOM events with the payload as `detail`.
network.addEventListener('hover', (event) => {
  const item = event.detail;
  hover.textContent = item ? `hover: ${item.kind} #${item.index}` : 'hover: -';
});
monitor.addEventListener('hover', (event) => {
  const value = event.detail;
  reading.textContent = value
    ? `reading: element ${value.element} = ${value.value.toFixed(2)} at t=${value.t}`
    : 'reading: -';
});

// The imperative surface is the controller itself.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-projection]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.projection as Projection;
    if (!network.network.setProjection(mode)) return;
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-projection]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  });
}

// Attributes stay declarative: change one and the element applies it.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-signal]')) {
  button.addEventListener('click', () => {
    monitor.setAttribute('signal', button.dataset.signal!);
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-signal]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  });
}
