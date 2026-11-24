import { start } from './shell/shell.js';
import './shell/style.css';

start([
  { id: 'grids', title: 'Power grids', load: () => import('./pages/grids/index.js') },
  { id: 'hawaii', title: 'Hawaiʻi one-line', load: () => import('./pages/hawaii.js') },
  { id: 'oneline', title: 'One-line', load: () => import('./pages/oneline.js') },
  { id: 'voltage-dip', title: 'Bus voltage monitor', href: 'monitor.html?plot=voltage' },
  { id: 'step-response', title: 'Setpoint and response', href: 'monitor.html?plot=response' },
  { id: 'bunny', title: 'Soft body', load: () => import('./pages/bunny/index.js') },
  { id: 'orbits', title: 'Orbits', load: () => import('./pages/orbits.js') },
  { id: 'telemetry', title: 'Telemetry', load: () => import('./pages/telemetry.js') },
]);
