/**
 * Build the packaged geographic border assets (`packages/network/assets/ne-50m-line-borders.*.bin`)
 * that `@latkit/network/borders` loads, in the renderer's `Borders` binary format.
 *
 * Format:
 *   - `*.vertices.bin` — 24-byte vertices: float32 longitude/latitude, float32 unit-sphere ECEF
 *     coordinates, and a uint32 layer (0 countries, 1 states, 2 coastline).
 *   - `*.indices.bin`  — uint32 line-strip indices with 0xffffffff primitive restarts.
 *
 * The current assets combine Natural Earth 50m land boundaries, state/province boundaries, and
 * coastlines. Regenerate from GeoJSON exports named with the Natural Earth filenames. Run from the
 * repository root; input and output paths resolve against the current working directory:
 *
 *   node packages/network/scripts/build-borders.mjs --preset 50m-line --input-dir <geojson-dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const VERTEX_BYTES = 24;
const RESTART = 0xffffffff;
const MAX_SEGMENT_DEG = 2.0;
const DEFAULT_MAX_VERTICES = 200_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const LAYER = {
  countries: 0,
  states: 1,
  coastline: 2,
};

const DEFAULT_INPUT_DIR = process.cwd();
const PRESETS = {
  /**
   * Full Natural Earth 50m line-work:
   * - ne_50m_admin_0_boundary_lines_land.geojson
   * - ne_50m_admin_1_states_provinces_lines.geojson
   * - ne_50m_coastline.geojson
   */
  '50m-line': {
    outputPrefix: 'packages/network/assets/ne-50m-line-borders',
    maxVertices: 200_000,
    maxBytes: 4 * 1024 * 1024,
    sources: [
      ['ne_50m_admin_0_boundary_lines_land', LAYER.countries],
      ['ne_50m_admin_1_states_provinces_lines', LAYER.states],
      ['ne_50m_coastline', LAYER.coastline],
    ],
  },
};

const args = parseArgs(process.argv.slice(2));
const preset = PRESETS[args.preset ?? '50m-line'];
if (!preset) {
  throw new Error(
    `unknown preset ${args.preset}; expected one of ${Object.keys(PRESETS).join(', ')}`,
  );
}
const inputDir = resolve(args.inputDir ?? DEFAULT_INPUT_DIR);
const outputPrefix = resolve(args.outputPrefix ?? preset.outputPrefix);
const maxVertices = args.maxVertices ?? preset.maxVertices ?? DEFAULT_MAX_VERTICES;
const maxBytes = args.maxBytes ?? preset.maxBytes ?? DEFAULT_MAX_BYTES;
const verticesPath = `${outputPrefix}.vertices.bin`;
const indicesPath = `${outputPrefix}.indices.bin`;

const vertices = [];
const indices = [];

for (const [name, layer] of preset.sources) {
  const fc = JSON.parse(await readFile(resolve(inputDir, `${name}.geojson`), 'utf8'));
  if (!Array.isArray(fc.features)) throw new Error(`${name}.geojson is not a FeatureCollection`);
  for (const feature of fc.features) {
    if (feature.geometry) walkGeometry(feature.geometry, layer);
  }
}

const vertexByteLength = vertices.length * VERTEX_BYTES;
const indexByteLength = indices.length * Uint32Array.BYTES_PER_ELEMENT;
const byteLength = vertexByteLength + indexByteLength;

if (vertices.length > maxVertices) {
  throw new Error(`border asset has ${vertices.length} vertices; max is ${maxVertices}`);
}
if (byteLength > maxBytes) {
  throw new Error(`border asset is ${byteLength} bytes; max is ${maxBytes}`);
}

const vertexBuffer = new ArrayBuffer(vertexByteLength);
const view = new DataView(vertexBuffer);
let offset = 0;
for (const vertex of vertices) {
  view.setFloat32(offset, vertex.lon, true);
  offset += 4;
  view.setFloat32(offset, vertex.lat, true);
  offset += 4;
  view.setFloat32(offset, vertex.x, true);
  offset += 4;
  view.setFloat32(offset, vertex.y, true);
  offset += 4;
  view.setFloat32(offset, vertex.z, true);
  offset += 4;
  view.setUint32(offset, vertex.layer, true);
  offset += 4;
}
const indexBuffer = new Uint32Array(indices.length);
indexBuffer.set(indices);

await mkdir(dirname(verticesPath), { recursive: true });
await mkdir(dirname(indicesPath), { recursive: true });
await writeFile(verticesPath, Buffer.from(vertexBuffer));
await writeFile(indicesPath, Buffer.from(indexBuffer.buffer));
console.log(`wrote ${verticesPath}`);
console.log(`wrote ${indicesPath}`);
console.log(
  `${vertices.length} vertices, ${indices.length} indices, ${(byteLength / 1024).toFixed(1)} KiB`,
);

function walkGeometry(geometry, layer) {
  const { type, coordinates } = geometry;
  if (type === 'LineString') pushLine(coordinates, layer);
  else if (type === 'MultiLineString') coordinates.forEach((line) => pushLine(line, layer));
  else if (type === 'Polygon') coordinates.forEach((ring) => pushLine(ring, layer));
  else if (type === 'MultiPolygon')
    coordinates.forEach((poly) => poly.forEach((ring) => pushLine(ring, layer)));
}

function pushLine(line, layer) {
  let previous = null;
  let wrote = false;

  for (const raw of densify(line, MAX_SEGMENT_DEG)) {
    const lon = wrapLon(raw[0]);
    const lat = raw[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    if (previous && Math.abs(lon - previous.lon) > 180) {
      indices.push(RESTART);
    }

    const [x, y, z] = geoToEcef(lon, lat);
    vertices.push({ lon, lat, x, y, z, layer });
    indices.push(vertices.length - 1);
    previous = { lon, lat };
    wrote = true;
  }

  if (wrote) indices.push(RESTART);
}

function* densify(line, maxSegmentDeg) {
  if (!Array.isArray(line) || line.length === 0) return;
  yield line[0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const dx = shortestLonDelta(a[0], b[0]);
    const dy = b[1] - a[1];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxSegmentDeg));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      yield [a[0] + dx * t, a[1] + dy * t];
    }
  }
}

function geoToEcef(lon, lat) {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const c = Math.cos(la);
  return [c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo)];
}

function wrapLon(lon) {
  return (((lon % 360) + 540) % 360) - 180;
}

function shortestLonDelta(a, b) {
  return wrapLon(b - a);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preset') out.preset = argv[++i];
    else if (arg === '--input-dir') out.inputDir = argv[++i];
    else if (arg === '--output-prefix') out.outputPrefix = argv[++i];
    else if (arg === '--max-vertices') out.maxVertices = Number(argv[++i]);
    else if (arg === '--max-bytes') out.maxBytes = Number(argv[++i]);
    else if (arg === '--output')
      throw new Error(
        'use --output-prefix; border assets are written as .vertices.bin and .indices.bin',
      );
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}
