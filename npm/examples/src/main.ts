import { Gpu } from './latkit.js';
import { examples } from './examples/index.js';
import { Shell } from './ui/shell.js';
import './ui/style.css';

new Shell(examples, Gpu.create());
