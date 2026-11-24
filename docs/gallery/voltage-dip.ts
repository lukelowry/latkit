import { readFileSync } from 'node:fs';
import { voltageDip, type Recording } from './voltage.ts';

export default function draw() {
  const dir = new URL('../../crates/latkit-cli/examples/wecc240-fault/recording/', import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL('metadata.json', dir), 'utf8')) as Recording;
  const buffer = readFileSync(new URL('voltage.f32', dir));
  return voltageDip(metadata, new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
}
