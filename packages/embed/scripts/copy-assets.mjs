// The border binaries live once, in @latkit/network. The standalone embed bundle resolves them
// beside itself, so they are copied into this package's dist too.
import { cpSync } from 'node:fs';

const source = new URL('../../network/assets/', import.meta.url);
const destination = new URL('../dist/assets/', import.meta.url);

cpSync(source, destination, { recursive: true });
