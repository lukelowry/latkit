import { cpSync } from 'node:fs';

const source = new URL('../assets/', import.meta.url);
const destination = new URL('../dist/assets/', import.meta.url);

cpSync(source, destination, { recursive: true });
