import { Patch, field, icon, type Scene } from 'latkit/core';
const scene: Scene = {
  space: 'plane',
  marks: [{ vertices: { of: ['grid', 'T'], position: [field('x'), field('y')] } }],
};
const patch = new Patch().replace('T', [1], { x: [1], y: [2] });
const marker = icon(
  [{ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) }],
  field('i'),
);
void [scene, patch.toBytes(), marker];
