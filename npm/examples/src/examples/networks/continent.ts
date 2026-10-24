import { random } from '../../random.js';
/**
 * A synthetic grid the size of a continent's. Buses cluster around North America's cities as a real
 * grid's do: every substation feeds radial distribution feeders, which hold most of the buses; each
 * city's substations mesh at 115 and 230 kV; and cities join along 345 to 765 kV corridors through
 * switching stations, the busiest by double or triple circuits, with rural substations and power
 * plants along the way. Seeded, so every build draws the same grid, in time linear in its size.
 */
import { Data, Patch, reference } from 'latkit';
import { levelOf, type Case } from './cases.js';

/** Metro areas: name, longitude, latitude, and millions of people. */
const CITIES: readonly (readonly [string, number, number, number])[] = [
  ['New York', -74.01, 40.71, 19.5],
  ['Los Angeles', -118.24, 34.05, 13.0],
  ['Chicago', -87.63, 41.88, 9.4],
  ['Dallas', -96.8, 32.78, 7.6],
  ['Houston', -95.37, 29.76, 7.1],
  ['Washington', -77.04, 38.91, 6.3],
  ['Philadelphia', -75.17, 39.95, 6.2],
  ['Miami', -80.19, 25.76, 6.1],
  ['Atlanta', -84.39, 33.75, 6.1],
  ['Boston', -71.06, 42.36, 4.9],
  ['Phoenix', -112.07, 33.45, 4.9],
  ['San Francisco', -122.42, 37.77, 4.7],
  ['Riverside', -117.4, 33.95, 4.6],
  ['Detroit', -83.05, 42.33, 4.3],
  ['Seattle', -122.33, 47.61, 4.0],
  ['Minneapolis', -93.27, 44.98, 3.7],
  ['San Diego', -117.16, 32.72, 3.3],
  ['Tampa', -82.46, 27.95, 3.2],
  ['Denver', -104.99, 39.74, 3.0],
  ['St. Louis', -90.2, 38.63, 2.8],
  ['Baltimore', -76.61, 39.29, 2.8],
  ['Charlotte', -80.84, 35.23, 2.7],
  ['Orlando', -81.38, 28.54, 2.7],
  ['San Antonio', -98.49, 29.42, 2.6],
  ['Portland', -122.68, 45.52, 2.5],
  ['Sacramento', -121.49, 38.58, 2.4],
  ['Pittsburgh', -80.0, 40.44, 2.4],
  ['Austin', -97.74, 30.27, 2.3],
  ['Las Vegas', -115.14, 36.17, 2.3],
  ['Cincinnati', -84.51, 39.1, 2.3],
  ['Kansas City', -94.58, 39.1, 2.2],
  ['Columbus', -83.0, 39.96, 2.1],
  ['Indianapolis', -86.16, 39.77, 2.1],
  ['Cleveland', -81.69, 41.5, 2.1],
  ['San Jose', -121.89, 37.34, 2.0],
  ['Nashville', -86.78, 36.16, 2.0],
  ['Virginia Beach', -75.98, 36.85, 1.8],
  ['Providence', -71.41, 41.82, 1.7],
  ['Jacksonville', -81.66, 30.33, 1.6],
  ['Milwaukee', -87.91, 43.04, 1.6],
  ['Raleigh', -78.64, 35.78, 1.4],
  ['Oklahoma City', -97.52, 35.47, 1.4],
  ['Memphis', -90.05, 35.15, 1.3],
  ['Richmond', -77.44, 37.54, 1.3],
  ['Louisville', -85.76, 38.25, 1.3],
  ['New Orleans', -90.07, 29.95, 1.3],
  ['Salt Lake City', -111.89, 40.76, 1.3],
  ['Hartford', -72.67, 41.76, 1.2],
  ['Buffalo', -78.88, 42.89, 1.2],
  ['Birmingham', -86.8, 33.52, 1.1],
  ['Rochester', -77.61, 43.16, 1.1],
  ['Grand Rapids', -85.67, 42.96, 1.1],
  ['Tucson', -110.97, 32.22, 1.0],
  ['Tulsa', -95.99, 36.15, 1.0],
  ['Fresno', -119.79, 36.74, 1.0],
  ['Omaha', -95.94, 41.26, 0.97],
  ['Greenville', -82.4, 34.85, 0.93],
  ['Albuquerque', -106.65, 35.08, 0.92],
  ['Bakersfield', -119.02, 35.37, 0.91],
  ['Albany', -73.75, 42.65, 0.9],
  ['Knoxville', -83.92, 35.96, 0.9],
  ['El Paso', -106.49, 31.76, 0.87],
  ['Baton Rouge', -91.15, 30.45, 0.87],
  ['McAllen', -98.23, 26.2, 0.87],
  ['Allentown', -75.47, 40.6, 0.86],
  ['Columbia', -81.03, 34.0, 0.83],
  ['Dayton', -84.19, 39.76, 0.81],
  ['Charleston', -79.93, 32.78, 0.8],
  ['Greensboro', -79.79, 36.07, 0.77],
  ['Boise', -116.2, 43.62, 0.75],
  ['Colorado Springs', -104.82, 38.83, 0.75],
  ['Little Rock', -92.29, 34.75, 0.75],
  ['Des Moines', -93.62, 41.59, 0.7],
  ['Madison', -89.4, 43.07, 0.68],
  ['Syracuse', -76.15, 43.05, 0.66],
  ['Toledo', -83.54, 41.65, 0.64],
  ['Wichita', -97.34, 37.69, 0.64],
  ['Jackson', -90.18, 32.3, 0.59],
  ['Harrisburg', -76.88, 40.27, 0.59],
  ['Spokane', -117.43, 47.66, 0.57],
  ['Chattanooga', -85.31, 35.05, 0.56],
  ['Portland, Maine', -70.26, 43.66, 0.55],
  ['Lansing', -84.56, 42.73, 0.54],
  ['Lexington', -84.5, 38.04, 0.52],
  ['Pensacola', -87.22, 30.42, 0.51],
  ['Reno', -119.81, 39.53, 0.49],
  ['Huntsville', -86.59, 34.73, 0.49],
  ['Springfield', -93.29, 37.21, 0.47],
  ['Corpus Christi', -97.4, 27.8, 0.42],
  ['Fort Wayne', -85.14, 41.08, 0.42],
  ['Mobile', -88.04, 30.69, 0.43],
  ['Savannah', -81.09, 32.08, 0.4],
  ['Peoria', -89.59, 40.69, 0.4],
  ['Shreveport', -93.75, 32.53, 0.39],
  ['Tallahassee', -84.28, 30.44, 0.39],
  ['Eugene', -123.09, 44.05, 0.38],
  ['Montgomery', -86.3, 32.37, 0.37],
  ['Lubbock', -101.86, 33.58, 0.32],
  ['Green Bay', -88.01, 44.51, 0.32],
  ['Roanoke', -79.94, 37.27, 0.31],
  ['Duluth', -92.1, 46.79, 0.29],
  ['Amarillo', -101.83, 35.22, 0.27],
  ['Sioux Falls', -96.73, 43.55, 0.27],
  ['Fargo', -96.79, 46.88, 0.25],
  ['Yakima', -120.51, 46.6, 0.25],
  ['Medford', -122.87, 42.33, 0.22],
  ['Burlington', -73.21, 44.48, 0.22],
  ['Charleston, West Virginia', -81.63, 38.35, 0.2],
  ['Billings', -108.5, 45.78, 0.18],
  ['Midland', -102.08, 31.99, 0.18],
  ['Redding', -122.39, 40.59, 0.18],
  ['Abilene', -99.73, 32.45, 0.17],
  ['Rapid City', -103.23, 44.08, 0.15],
  ['Santa Fe', -105.94, 35.69, 0.15],
  ['Bangor', -68.77, 44.8, 0.15],
  ['Flagstaff', -111.65, 35.2, 0.14],
  ['Bismarck', -100.78, 46.81, 0.13],
  ['Missoula', -113.99, 46.87, 0.12],
  ['Cheyenne', -104.82, 41.14, 0.1],
  ['Great Falls', -111.3, 47.5, 0.08],
  ['Casper', -106.31, 42.87, 0.08],
  ['Toronto', -79.38, 43.65, 6.2],
  ['Montreal', -73.57, 45.5, 4.3],
  ['Vancouver', -123.12, 49.28, 2.6],
  ['Calgary', -114.07, 51.05, 1.5],
  ['Edmonton', -113.49, 53.55, 1.4],
  ['Ottawa', -75.7, 45.42, 1.4],
  ['Quebec City', -71.21, 46.81, 0.84],
  ['Winnipeg', -97.14, 49.9, 0.83],
  ['Hamilton', -79.87, 43.26, 0.79],
  ['Kitchener', -80.49, 43.45, 0.58],
  ['London, Ontario', -81.25, 42.98, 0.54],
  ['Halifax', -63.57, 44.65, 0.44],
  ['Victoria', -123.37, 48.43, 0.4],
  ['Saskatoon', -106.67, 52.13, 0.32],
  ['Regina', -104.61, 50.45, 0.25],
  ['Sudbury', -80.99, 46.49, 0.17],
  ['Thunder Bay', -89.25, 48.38, 0.12],
  ['Mexico City', -99.13, 19.43, 21.8],
  ['Guadalajara', -103.35, 20.66, 5.3],
  ['Monterrey', -100.32, 25.69, 5.3],
  ['Puebla', -98.21, 19.04, 3.2],
  ['Toluca', -99.66, 19.28, 2.4],
  ['Tijuana', -117.04, 32.51, 2.2],
  ['León', -101.68, 21.12, 1.9],
  ['Querétaro', -100.39, 20.59, 1.6],
  ['Ciudad Juárez', -106.42, 31.69, 1.5],
  ['Torreón', -103.42, 25.54, 1.4],
  ['Mérida', -89.59, 20.97, 1.3],
  ['San Luis Potosí', -100.98, 22.15, 1.3],
  ['Aguascalientes', -102.29, 21.88, 1.1],
  ['Mexicali', -115.45, 32.62, 1.0],
  ['Chihuahua', -106.07, 28.63, 0.99],
  ['Morelia', -101.19, 19.7, 0.98],
  ['Culiacán', -107.39, 24.81, 0.95],
  ['Hermosillo', -110.96, 29.07, 0.94],
  ['Veracruz', -96.13, 19.17, 0.94],
  ['Tampico', -97.86, 22.25, 0.93],
  ['Saltillo', -101.0, 25.42, 0.92],
  ['Cancún', -86.85, 21.16, 0.89],
  ['Acapulco', -99.82, 16.85, 0.85],
  ['Villahermosa', -92.93, 17.99, 0.83],
  ['Oaxaca', -96.73, 17.07, 0.71],
  ['Durango', -104.66, 24.02, 0.69],
];

/** Kilometres per degree of latitude. */
const KM = 111.2;
/** Buses a substation feeds, on average. */
const PER_SUBSTATION = 320;
/** Kilometres between switching stations along a corridor. */
const STATION_SPACING = 90;
/** The share of buses fed along corridors rather than in cities. */
const RURAL = 0.12;

/** Kilometres between two points, near enough for a continent. */
function km(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const across = (lon1 - lon0) * Math.cos(((lat0 + lat1) * Math.PI) / 360);
  return Math.hypot(across, lat1 - lat0) * KM;
}

/** Buses and lines as they are made, in typed arrays that grow by half again. */
class Builder {
  lon = new Float64Array(1024);
  lat = new Float64Array(1024);
  kv = new Float32Array(1024);
  load = new Float32Array(1024);
  generation = new Float32Array(1024);
  buses = 0;
  from = new Uint32Array(1024);
  to = new Uint32Array(1024);
  lineKv = new Float32Array(1024);
  transformer = new Uint8Array(1024);
  lines = 0;
  readonly machineBus: number[] = [];
  readonly machinePower: number[] = [];
  readonly machineNames: string[] = [];

  constructor(buses: number) {
    this.reserveBuses(buses);
    this.reserveLines(Math.ceil(buses * 1.1));
  }

  private reserveBuses(n: number): void {
    if (n <= this.lon.length) return;
    const grow = <T extends Float64Array | Float32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.lon = grow(this.lon);
    this.lat = grow(this.lat);
    this.kv = grow(this.kv);
    this.load = grow(this.load);
    this.generation = grow(this.generation);
  }

  private reserveLines(n: number): void {
    if (n <= this.from.length) return;
    const grow = <T extends Uint32Array | Float32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.from = grow(this.from);
    this.to = grow(this.to);
    this.lineKv = grow(this.lineKv);
    this.transformer = grow(this.transformer);
  }

  bus(lon: number, lat: number, kv: number, load = 0): number {
    if (this.buses === this.lon.length) this.reserveBuses(this.buses + (this.buses >> 1));
    const b = this.buses++;
    this.lon[b] = lon;
    this.lat[b] = lat;
    this.kv[b] = kv;
    this.load[b] = load;
    return b;
  }

  line(a: number, b: number, kv: number, transformer = false): void {
    if (this.lines === this.from.length) this.reserveLines(this.lines + (this.lines >> 1));
    const e = this.lines++;
    this.from[e] = a;
    this.to[e] = b;
    this.lineKv[e] = kv;
    this.transformer[e] = transformer ? 1 : 0;
  }

  machine(bus: number, power: number, name: string): void {
    this.machineBus.push(bus);
    this.machinePower.push(power);
    this.machineNames.push(name);
    this.generation[bus]! += power;
  }
}

/** The cheapest tree joining `n` points, by Prim's algorithm on squared distance: each point's parent
 * in it, the first point's being -1. */
function spanning(n: number, distance: (a: number, b: number) => number): Int32Array {
  const parent = new Int32Array(n).fill(-1);
  const best = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  best[0] = 0;
  for (let k = 0; k < n; k++) {
    let next = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (next < 0 || best[i]! < best[next]!)) next = i;
    done[next] = 1;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const d = distance(next, i);
      if (d < best[i]!) {
        best[i] = d;
        parent[i] = next;
      }
    }
  }
  return parent;
}

/** Feeds `count` distribution buses from substation bus `root`: radial feeders that run outward from
 * it and branch, steps of `step` degrees apart. */
function feed(grid: Builder, rng: () => number, root: number, count: number, step: number): void {
  const feeders = Math.max(3, Math.round((count / 50) * (0.8 + 0.4 * rng())));
  const lat0 = grid.lat[root]!;
  const stretch = 1 / Math.cos((lat0 * Math.PI) / 180);
  let left = count;
  for (let f = 0; f < feeders && left > 0; f++) {
    const size =
      f === feeders - 1
        ? left
        : Math.min(left, Math.round((count / feeders) * (0.6 + 0.8 * rng())));
    left -= size;
    // The feeder's buses, and the way each one's line ran.
    const first = grid.buses;
    const headings = new Float32Array(size);
    let heading = (2 * Math.PI * (f + rng())) / feeders;
    let parent = root;
    for (let k = 0; k < size; k++) {
      // Mostly the trunk runs on; now and then a lateral branches off a bus already fed.
      if (k > 0 && rng() < 0.18) {
        const from = Math.floor(rng() * k);
        parent = first + from;
        heading = headings[from]! + (rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rng() - 0.5) * 0.8);
      } else {
        heading += (rng() - 0.5) * 0.7;
      }
      const length = step * (0.5 + rng());
      const lon = grid.lon[parent]! + Math.cos(heading) * length * stretch;
      const lat = grid.lat[parent]! + Math.sin(heading) * length;
      const bus = grid.bus(lon, lat, 13.8, 0.05 + -Math.log(1 - rng()) * 0.35);
      headings[k] = heading;
      grid.line(parent, bus, 13.8, parent === root);
      parent = bus;
    }
  }
}

/** The synthetic grids, by id, and the buses each is built to. */
export const CONTINENTS: Readonly<Record<string, number>> = {
  'continent-2m': 2_000_000,
};

/** The synthetic grid `id` as a case named `grid`, as the case files are read. */
export function continent(id: string): Case {
  const target = CONTINENTS[id];
  if (!target) throw new Error(`No synthetic grid ${id}`);
  const rng = random(20261014);
  const grid = new Builder(Math.ceil(target * 1.02));
  const weights = CITIES.map(([, , , people]) => people ** 0.85);
  const total = weights.reduce((a, b) => a + b, 0);

  // Corridors first, as a graph of cities: the cheapest tree joining them all, and each city's two
  // nearest neighbours within 700 km.
  const n = CITIES.length;
  const distance = (a: number, b: number) =>
    km(CITIES[a]![1], CITIES[a]![2], CITIES[b]![1], CITIES[b]![2]);
  const corridors = new Set<number>();
  const pair = (a: number, b: number) => Math.min(a, b) * n + Math.max(a, b);
  const tree = spanning(n, distance);
  tree.forEach((p, c) => p >= 0 && corridors.add(pair(p, c)));
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()]
      .filter((b) => b !== a)
      .sort((x, y) => distance(a, x) - distance(a, y))
      .slice(0, 2);
    for (const b of near) if (distance(a, b) < 700) corridors.add(pair(a, b));
  }

  // Each city: substations meshing at 115 and 230 kV, each feeding its share of the city's buses.
  const hubs = new Map<number, number>();
  const substations: number[][] = [];
  for (let c = 0; c < n; c++) {
    const [, lon, lat, people] = CITIES[c]!;
    const buses = Math.floor(((1 - RURAL) * target * weights[c]!) / total);
    const count = Math.max(2, Math.round(buses / PER_SUBSTATION));
    const spread = 0.04 + 0.05 * Math.sqrt(people);
    const stretch = 1 / Math.cos((lat * Math.PI) / 180);
    const subs: number[] = [];
    for (let s = 0; s < count; s++) {
      const r = s === 0 ? 0 : spread * Math.sqrt(-2 * Math.log(1 - rng()));
      const angle = 2 * Math.PI * rng();
      const kv = s < Math.ceil(count / 6) ? 230 : 115;
      subs.push(grid.bus(lon + Math.cos(angle) * r * stretch, lat + Math.sin(angle) * r, kv));
    }
    substations.push(subs);
    const at = (s: number) => [grid.lon[subs[s]!]!, grid.lat[subs[s]!]!] as const;
    const parent = spanning(count, (a, b) => {
      const [x0, y0] = at(a);
      const [x1, y1] = at(b);
      return km(x0, y0, x1, y1);
    });
    parent.forEach((p, s) => {
      if (p < 0) return;
      const [a, b] = [subs[p]!, subs[s]!];
      grid.line(a, b, Math.min(grid.kv[a]!, grid.kv[b]!), grid.kv[a] !== grid.kv[b]);
    });
    // A mesh as well as a tree: each substation also joins one more near it.
    for (let s = 1; s < count; s++) {
      const other = Math.floor(rng() * count);
      if (other !== s && other !== parent[s]) {
        const [a, b] = [subs[s]!, subs[other]!];
        const [x0, y0] = at(s);
        const [x1, y1] = at(other);
        if (km(x0, y0, x1, y1) < spread * KM * 1.2)
          grid.line(a, b, Math.min(grid.kv[a]!, grid.kv[b]!), grid.kv[a] !== grid.kv[b]);
      }
    }
    // Feeders run shorter where people crowd closer.
    const step = 0.0012 + 0.002 / Math.sqrt(1 + people);
    for (let s = 0; s < count; s++)
      feed(grid, rng, subs[s]!, Math.max(0, Math.floor(buses / count) - 1), step);
  }

  /** City `c`'s bus at `kv`, made on first use and joined to its central substation. */
  const hub = (c: number, kv: number) => {
    const key = c * 1000 + kv;
    const found = hubs.get(key);
    if (found !== undefined) return found;
    const [name, lon, lat, people] = CITIES[c]!;
    const bus = grid.bus(lon + (rng() - 0.5) * 0.04, lat + (rng() - 0.5) * 0.04, kv);
    grid.line(bus, substations[c]![0]!, 230, true);
    hubs.set(key, bus);
    if (people > 0.6 && rng() < 0.7)
      grid.machine(bus, Math.round(400 + rng() * 1600), `${name} ${kv} kV plant`);
    return bus;
  };

  // Corridors: each a chain of switching stations, its circuits as many as its cities need, with a
  // rural substation and its feeders off every station, and a power plant at some.
  let stations = 0;
  const links = [...corridors].map((p) => [Math.floor(p / n), p % n] as const);
  for (const [a, b] of links) stations += Math.floor(distance(a, b) / STATION_SPACING);
  const rural = Math.floor((RURAL * target) / Math.max(1, stations));
  for (const [a, b] of links) {
    const [nameA, lonA, latA, peopleA] = CITIES[a]!;
    const [nameB, lonB, latB, peopleB] = CITIES[b]!;
    const people = peopleA + peopleB;
    const central = (lon: number, lat: number) => lon > -92 && lon < -77 && lat > 35 && lat < 43;
    const kv =
      people > 8 && central(lonA, latA) && central(lonB, latB)
        ? 765
        : people > 6
          ? 500
          : people > 2
            ? 345
            : 230;
    const circuits = people > 14 ? 3 : people > 6 ? 2 : 1;
    const length = distance(a, b);
    const hops = Math.floor(length / STATION_SPACING) + 1;
    // The corridor bends a little off the straight line, the same way along its whole length.
    const bend = (rng() - 0.5) * 0.12;
    let previous = hub(a, kv);
    for (let h = 1; h <= hops; h++) {
      let station: number;
      if (h === hops) {
        station = hub(b, kv);
      } else {
        const t = h / hops;
        const across = bend * 4 * t * (1 - t) + (rng() - 0.5) * 0.02;
        const lon = lonA + (lonB - lonA) * t - (latB - latA) * across;
        const lat = latA + (latB - latA) * t + (lonB - lonA) * across;
        station = grid.bus(lon, lat, kv);
        const sub = grid.bus(lon + (rng() - 0.5) * 0.06, lat + (rng() - 0.5) * 0.06, 69);
        grid.line(station, sub, 69, true);
        feed(grid, rng, sub, rural, 0.004);
        if (rng() < 0.22) {
          const plant = rng() < 0.5 ? `${nameA}–${nameB} wind` : `${nameA}–${nameB} station ${h}`;
          grid.machine(station, Math.round(100 + rng() * 1100), plant);
        }
      }
      for (let k = 0; k < circuits; k++) grid.line(previous, station, kv);
      previous = station;
    }
  }

  const buses = grid.buses;
  const lines = grid.lines;
  const machines = grid.machineBus.length;
  const lon = grid.lon.subarray(0, buses);
  const lat = grid.lat.subarray(0, buses);
  const kv = grid.kv.subarray(0, buses);
  const lineKv = grid.lineKv.subarray(0, lines);
  const positions = new Float32Array(buses * 2);
  for (let b = 0; b < buses; b++) {
    positions[b * 2] = lon[b]!;
    positions[b * 2 + 1] = lat[b]!;
  }
  const machineBus = Uint32Array.from(grid.machineBus);
  const machinePower = Float32Array.from(grid.machinePower);
  const load = grid.load.slice(0, buses);
  const generation = grid.generation.slice(0, buses);
  const patch = new Patch()
    .set(
      'Bus',
      { count: buses },
      {
        lon,
        lat,
        kv,
        level: Float32Array.from(kv, levelOf),
        load,
        generation,
      },
    )
    .set(
      'Line',
      { count: lines },
      {
        from: reference('Bus', grid.from.subarray(0, lines)),
        to: reference('Bus', grid.to.subarray(0, lines)),
        kv: lineKv,
        level: Float32Array.from(lineKv, levelOf),
        transformer: grid.transformer.subarray(0, lines),
      },
    )
    .set(
      'Machine',
      { count: machines },
      {
        lon: Float64Array.from(machineBus, (b) => lon[b]!),
        lat: Float64Array.from(machineBus, (b) => lat[b]!),
        name: grid.machineNames,
        power: machinePower,
      },
    );
  return {
    data: new Data('grid').apply(patch),
    name: 'Synthetic North America',
    buses,
    lines,
    machines,
    bytes: 0,
    named: false,
    positions,
    load,
    generation,
    machineBus,
    machinePower,
  };
}
