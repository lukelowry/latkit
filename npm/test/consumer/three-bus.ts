import { Data, field, reference, type Scene } from 'latkit';

export function threeBusGrid() {
  return new Data('grid')
    .set('Bus', [101, 102, 103], {
      name: ['North', 'Mill', 'South'],
      x: [-100, 0, 100],
      y: [0, 30, 0],
      kv: [115, 115, 115],
      vm: [1.02, 1.0, 0.98],
    })
    .set('Branch', [1, 2], {
      name: ['North–Mill', 'Mill–South'],
      from: reference('Bus', [101, 102]),
      to: reference('Bus', [102, 103]),
      mva: [95, 56],
      rating: [100, 80],
    });
}

export function voltageDiagram(grid: Data): Scene {
  return {
    space: { plane: { grid: 'off' } },
    marks: [
      { edges: grid.table('Branch'), ends: ['from', 'to'], color: '#8392a5', width: 2 },
      {
        vertices: grid.table('Bus'),
        position: ['$x', '$y'],
        radius: 8,
        color: field('vm').colormap('viridis').domain(0.98, 1.02),
        label: { text: '$name', place: 'bottom' },
        legend: { title: 'Bus voltage', unit: ' p.u.', place: 'bottom' },
      },
    ],
  };
}
