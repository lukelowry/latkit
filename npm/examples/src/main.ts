import { Gpu } from 'latkit';
import { pages } from './pages.js';
import { Shell } from './ui/shell.js';
import './ui/style.css';

new Shell(pages, Gpu.create());
