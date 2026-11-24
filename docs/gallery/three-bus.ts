import { threeBusGrid, voltageDiagram } from '../../npm/test/consumer/three-bus.ts';
import type { Picture } from './render.ts';

export default function (): Picture {
  return {
    scene: voltageDiagram(threeBusGrid()),
    size: [1000, 410],
    fit: { bounds: { min: [-130, -17, 0], max: [130, 48, 0] } },
  };
}
