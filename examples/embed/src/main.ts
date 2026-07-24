import '@latkit/embed/register';

import './style.css';

const element = document.querySelector('latkit-network');
const status = document.querySelector<HTMLElement>('#status')!;

if (!element) throw new Error('latkit-network example element is missing');

void element.ready.then(
  () => {
    status.textContent = 'live';
    status.dataset.state = 'live';
  },
  (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : 'unavailable';
    status.dataset.state = 'error';
  },
);
