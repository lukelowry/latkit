/** Globe: routes between world cities along great circles, with comets flowing along them. */
import { Patch, field, reference, units, when } from 'latkit';
import { THEME, worldMap, type Piece } from './look.ts';

/** Cities as `[name, longitude, latitude, population in millions]`. Populations are approximate. */
const CITIES: readonly (readonly [string, number, number, number])[] = [
  ['Tokyo', 139.69, 35.69, 37],
  ['Delhi', 77.21, 28.61, 32],
  ['Shanghai', 121.47, 31.23, 28],
  ['São Paulo', -46.63, -23.55, 22],
  ['Mexico City', -99.13, 19.43, 22],
  ['Cairo', 31.24, 30.04, 21],
  ['Mumbai', 72.88, 19.08, 21],
  ['Beijing', 116.41, 39.9, 21],
  ['Dhaka', 90.41, 23.81, 22],
  ['New York', -74.01, 40.71, 19],
  ['Karachi', 67.01, 24.86, 17],
  ['Buenos Aires', -58.38, -34.6, 15],
  ['Istanbul', 28.98, 41.01, 15],
  ['Lagos', 3.38, 6.52, 15],
  ['Manila', 120.98, 14.6, 14],
  ['Rio de Janeiro', -43.17, -22.91, 13],
  ['Kinshasa', 15.27, -4.44, 15],
  ['Los Angeles', -118.24, 34.05, 12],
  ['Moscow', 37.62, 55.76, 12],
  ['Paris', 2.35, 48.86, 11],
  ['Jakarta', 106.85, -6.21, 11],
  ['Lima', -77.04, -12.05, 11],
  ['London', -0.13, 51.51, 9.6],
  ['Bangkok', 100.5, 13.76, 11],
  ['Seoul', 126.98, 37.57, 10],
  ['Chicago', -87.63, 41.88, 8.9],
  ['Hong Kong', 114.17, 22.32, 7.5],
  ['Santiago', -70.67, -33.45, 6.9],
  ['Madrid', -3.7, 40.42, 6.7],
  ['Toronto', -79.38, 43.65, 6.3],
  ['Johannesburg', 28.05, -26.2, 6],
  ['Singapore', 103.82, 1.35, 6],
  ['Sydney', 151.21, -33.87, 5.4],
  ['Nairobi', 36.82, -1.29, 5],
  ['Dubai', 55.27, 25.2, 3.5],
  ['Frankfurt', 8.68, 50.11, 2.3],
  ['Auckland', 174.76, -36.85, 1.7],
  ['Honolulu', -157.86, 21.31, 1],
  ['Anchorage', -149.9, 61.22, 0.3],
  ['Reykjavík', -21.94, 64.15, 0.2],
];

/** Long-haul routes between hubs, added to the routes to each city's three nearest neighbors. */
const HAULS = [
  ['London', 'New York'],
  ['New York', 'Los Angeles'],
  ['London', 'Dubai'],
  ['Dubai', 'Singapore'],
  ['Singapore', 'Sydney'],
  ['Tokyo', 'Los Angeles'],
  ['Frankfurt', 'Shanghai'],
  ['Paris', 'São Paulo'],
  ['Johannesburg', 'Dubai'],
  ['Honolulu', 'Tokyo'],
  ['Honolulu', 'Los Angeles'],
  ['Auckland', 'Sydney'],
  ['Los Angeles', 'Lima'],
  ['Anchorage', 'Seoul'],
  ['Reykjavík', 'Toronto'],
  ['Reykjavík', 'London'],
  ['Moscow', 'Beijing'],
  ['Cairo', 'Mumbai'],
  ['Lagos', 'London'],
  ['Nairobi', 'Mumbai'],
  ['Santiago', 'Auckland'],
] as const;

/** The great-circle distance between two cities, in degrees, by the haversine formula. */
function arc(
  a: readonly [string, number, number, number],
  b: readonly [string, number, number, number],
): number {
  const r = Math.PI / 180;
  const [x1, y1, x2, y2] = [a[1] * r, a[2] * r, b[1] * r, b[2] * r];
  const h =
    Math.sin((y2 - y1) / 2) ** 2 + Math.cos(y1) * Math.cos(y2) * Math.sin((x2 - x1) / 2) ** 2;
  return (2 * Math.asin(Math.sqrt(h))) / r;
}

export default function globe(): Piece {
  const index = new Map(CITIES.map((c, i) => [c[0], i]));
  const pairs = new Set<string>();
  CITIES.forEach((city, i) => {
    const nearest = CITIES.map((other, j) => [j, arc(city, other)] as const)
      .filter(([j]) => j !== i)
      .sort((p, q) => p[1] - q[1])
      .slice(0, 3);
    for (const [j] of nearest) pairs.add([i, j].sort((p, q) => p - q).join(','));
  });
  for (const [a, b] of HAULS)
    pairs.add([index.get(a)!, index.get(b)!].sort((p, q) => p - q).join(','));
  const routes = [...pairs].map((p) => p.split(',').map(Number) as [number, number]);
  // The most populous cities are named: those at least as populous as the fourteenth largest.
  const named = CITIES.map((c) => c[3]).sort((p, q) => q - p)[13]!;
  const data = new Patch('world')
    .replace(
      'City',
      { count: CITIES.length },
      {
        name: CITIES.map((c) => c[0]),
        lon: CITIES.map((c) => c[1]),
        lat: CITIES.map((c) => c[2]),
        people: CITIES.map((c) => c[3]),
      },
    )
    .replace(
      'Route',
      { count: routes.length },
      {
        from: reference(
          'City',
          routes.map(([a]) => a),
        ),
        to: reference(
          'City',
          routes.map(([, b]) => b),
        ),
        degrees: routes.map(([a, b]) => arc(CITIES[a]!, CITIES[b]!)),
      },
    );
  return {
    name: 'globe',
    alt: `Routes between ${CITIES.length} of the world's great cities, along great circles on a globe, comets flowing on them`,
    data: [
      data,
      { name: 'coast', file: worldMap('coastline') },
      { name: 'borders', file: worldMap('countries') },
    ],
    camera: { center: [16, 20], zoom: 2.3, pitch: 0, bearing: 0 },
    elapsed: 3,
    scene: {
      space: {
        earth: { projection: 'globe', graticule: false, atmosphere: true },
      },
      ease: 0,
      theme: {
        ...THEME,
        earth: { ground: '#0e1824' },
        flow: { color: '#fff6e0e0', spacing: units(9), length: units(3.5), width: 2.6 },
      },
      marks: [
        { lines: { of: ['borders', 'lines'], width: 0.5, color: '#22384f' } },
        { lines: { of: ['coast', 'lines'], width: 0.8, color: '#3d6a8f' } },
        {
          edges: {
            of: ['world', 'Route'],
            ends: ['from', 'to'],
            width: 1.3,
            flow: 2.5,
            color: {
              colormap: {
                kind: 'sequential',
                colors: ['#5ce0c2', '#5aa9ff', '#b48cff', '#ffb35c'],
              },
              value: '$degrees',
              domain: [5, 90],
            },
          },
        },
        {
          vertices: {
            of: ['world', 'City'],
            position: ['$lon', '$lat'],
            radius: { scale: [2, 6], value: '$people', domain: [0, 37] },
            color: '#f4f8ff',
            priority: '$people',
            label: {
              text: when(field('people').ge(named)).then(field('name')).otherwise(null),
              size: 11,
              color: '#c9d6e6',
            },
          },
        },
      ],
    },
  };
}
