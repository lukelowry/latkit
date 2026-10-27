import { start } from './shell/shell.js';
import './shell/style.css';

start([
  { id: 'grids', title: 'Power grids', load: () => import('./pages/grids/index.js') },
  { id: 'bunny', title: 'Soft body', load: () => import('./pages/bunny/index.js') },
  { id: 'orbits', title: 'Orbits', load: () => import('./pages/orbits.js') },
  { id: 'telemetry', title: 'Telemetry', load: () => import('./pages/telemetry.js') },
  { id: 'diagram', title: 'Diagram', load: () => import('./pages/diagram.js') },
]);
