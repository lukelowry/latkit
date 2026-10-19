/** The body's numerical checks, run by vitest; no wasm build. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { Body, ROOM, STEP, type Controls } from './body.js';
import { fracture } from './fracture.js';
import { loadMesh } from './mesh.js';

const bytes = readFileSync('npm/examples/src/bunny/stanford-bunny.bin');
const mesh = await loadMesh(
  new URL(`data:application/octet-stream;base64,${bytes.toString('base64')}`),
);
const controls: Controls = { gravity: 9.81, firmness: 0.45, inflate: 1, wind: false };

function run(body: Body, seconds: number, settings = controls): void {
  for (let i = 0; i < Math.ceil(seconds / (STEP * 8)); i++) body.advance(STEP * 8, settings);
}

function bounded(body: Body): void {
  const positions = body.burst.active ? body.burst.x : body.x;
  assert.ok(positions.every(Number.isFinite), 'all positions remain finite');
  for (let i = 0; i < positions.length; i += 3) {
    assert.ok(Math.abs(positions[i]!) <= ROOM + 1e-6);
    assert.ok(Math.abs(positions[i + 1]!) <= ROOM + 1e-6);
    assert.ok(positions[i + 2]! >= -1e-6 && positions[i + 2]! <= 6.5 + 1e-6);
  }
}

test('fracture makes 24 closed, outward solids with normalized surface bindings', () => {
  const pieces = fracture(mesh);
  assert.equal(pieces.length, 24);
  let volume = 0;
  for (const piece of pieces) {
    const edges = new Map<string, number>();
    let pieceVolume = 0;
    for (const face of piece.faces) {
      for (let e = 0; e < 3; e++) {
        const a = face[e]!,
          b = face[(e + 1) % 3]!;
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1));
      }
      const [a, b, c] = face.map((i) => piece.vertices[i]!.p);
      pieceVolume +=
        (a![0] * (b![1] * c![2] - b![2] * c![1]) +
          a![1] * (b![2] * c![0] - b![0] * c![2]) +
          a![2] * (b![0] * c![1] - b![1] * c![0])) /
        6;
    }
    assert.ok(
      [...edges.values()].every((v) => v === 0),
      'each edge has an opposite winding',
    );
    assert.ok(pieceVolume > 0, 'piece is outward wound');
    volume += pieceVolume;
    for (const vertex of piece.vertices) {
      assert.ok(Math.abs([...vertex.weights.values()].reduce((a, b) => a + b, 0) - 1) < 1e-8);
      for (let axis = 0; axis < 3; axis++) {
        const mapped = [...vertex.weights].reduce(
          (sum, [row, w]) => sum + mesh.positions[row * 3 + axis]! * w,
          0,
        );
        assert.ok(Math.abs(mapped - vertex.p[axis]!) < 1e-7);
      }
    }
  }
  const body = new Body(mesh);
  assert.ok(Math.abs(volume - body.volume) < 1e-6, 'cuts preserve enclosed volume');
});

/** Steps until the body rests, for at most `seconds`. */
function rest(body: Body, settings = controls, seconds = 10): void {
  for (let steps = 0; !body.asleep && steps < seconds / STEP; steps++) body.advance(STEP, settings);
}

test('body rests where it lands, hops at once, and ignores presses in the air', () => {
  const body = new Body(mesh);
  body.drop(true);
  run(body, 6);
  bounded(body);
  assert.equal(body.state, 'resting', `rest speed: ${body.metrics()[1]}`);
  const resting = body.x.slice();
  run(body, 2);
  assert.deepEqual(body.x, resting, 'a resting body does not move');
  const before = body.metrics()[0];
  body.hop();
  assert.ok(!body.asleep, 'a hop wakes it');
  run(body, 0.15);
  assert.equal(body.state, 'airborne');
  const copy = body.x.slice();
  const speed = body.metrics()[1];
  for (let i = 0; i < 20; i++) body.hop();
  assert.deepEqual(body.x, copy);
  assert.equal(body.metrics()[1], speed, 'presses in the air change nothing');
  run(body, 0.15);
  assert.ok(body.metrics()[0] > before + 0.2, 'hop leaves the floor');
  assert.ok(body.metrics()[0] < before + 1.4, 'hop has bounded height');
  run(body, 8);
  bounded(body);
  assert.equal(body.state, 'resting', 'it rests again after landing');
});

test('stands at any firmness, stays down once toppled, and wakes when poked', () => {
  // Creeping as fast as before, a body would never count as still, and never rest.
  for (const firmness of [0, 0.45, 1]) {
    const body = new Body(mesh);
    body.drop(true);
    const settings = { ...controls, firmness };
    rest(body, settings);
    assert.equal(body.state, 'resting', `firmness ${firmness}: ${body.metrics()[1]} m/s`);
    body.poke(0);
    assert.ok(!body.asleep, 'a poke wakes it');
    run(body, 0.5, settings);
    assert.ok(body.metrics()[1] > 0, 'and it moves');
  }
  // Pulled past its tipping point, it lies where it fell.
  const body = new Body(mesh);
  body.drop(true);
  rest(body);
  let top = 0;
  for (let i = 1; i < mesh.count; i++)
    if (mesh.positions[i * 3 + 2]! > mesh.positions[top * 3 + 2]!) top = i;
  body.grab(top, [3, 0, 0.6]);
  run(body, 2);
  body.release();
  rest(body);
  assert.equal(body.state, 'toppled');
});

test('pop gathers under zero, Earth, and high gravity, without a mesh snap', () => {
  for (const gravity of [0, 9.81, 24.8]) {
    const body = new Body(mesh);
    body.pop();
    run(body, 0.2, { ...controls, gravity });
    assert.ok(body.burst.active);
    assert.ok(Number.isNaN(body.metrics()[2]), 'disconnected pieces have no body volume');
    for (let i = 0; i < 20; i++) body.pop();
    let steps = 0;
    while (body.burst.active && steps++ < 1440) {
      body.advance(STEP, { ...controls, gravity });
      bounded(body);
    }
    assert.ok(!body.burst.active, `gathers at gravity ${gravity}`);
    for (const chunk of body.burst.chunks)
      for (let j = 0; j < chunk.piece.vertices.length; j++) {
        for (let a = 0; a < 3; a++) {
          const target = [...chunk.piece.vertices[j]!.weights].reduce(
            (sum, [row, w]) => sum + body.x[row * 3 + a]! * w,
            0,
          );
          assert.ok(
            Math.abs(body.burst.x[(chunk.offset + j) * 3 + a]! - target) < 0.02,
            'seam closes before restoring mesh',
          );
        }
      }
    assert.ok(Number.isFinite(body.metrics()[2]));
    body.pop();
    run(body, 0.2);
    body.drop(true);
    assert.ok(!body.burst.active, 'drop cancels burst');
  }
});

test('pop lifts every piece and visibly separates before gathering', () => {
  const body = new Body(mesh);
  run(body, 2);
  body.pop();
  assert.ok(body.burst.active, 'a pop starts at once');
  const launch = body.burst.chunks.map((chunk) => [...chunk.position]);
  assert.ok(
    body.burst.chunks.every((chunk) => chunk.velocity[2] > 2),
    'every piece clears the floor',
  );
  run(body, 0.6);
  const separated = body.burst.chunks.filter(
    (chunk, i) =>
      Math.hypot(chunk.position[0] - launch[i]![0]!, chunk.position[1] - launch[i]![1]!) > 0.8,
  );
  assert.ok(separated.length >= 20, `${separated.length}/24 pieces left the original silhouette`);
  run(body, 0.6);
  assert.ok(!body.burst.gathering, 'the full scatter has time to read before automatic return');
  run(body, 4);
  assert.ok(!body.burst.active, 'automatic assembly still completes');

  body.pop();
  for (let i = 0; i < 20; i++) body.pop();
  run(body, 0.4);
  assert.ok(!body.burst.gathering, 'repeat presses cannot abort separation');
  run(body, 3);
  assert.ok(!body.burst.active, 'the early gather request completes after separation');
});

test('large grabs, cancellation, and material extremes stay bounded', () => {
  const body = new Body(mesh);
  run(body, 1);
  let ear = 0;
  for (let i = 1; i < mesh.count; i++)
    if (mesh.positions[i * 3 + 2]! > mesh.positions[ear * 3 + 2]!) ear = i;
  body.grab(ear, Array.from(body.x.subarray(ear * 3, ear * 3 + 3)));
  body.drag([100, -100, 100]);
  run(body, 1);
  bounded(body);
  body.release(true);
  assert.equal(body.metrics()[1], 0, 'cancelled drag does not throw');
  for (const firmness of [0, 1])
    for (const inflate of [0.5, 1.8]) {
      run(body, 1, { ...controls, firmness, inflate, wind: true });
      bounded(body);
    }
});

test('held squash releases, and a gentle pop of an inflated body completes', () => {
  const body = new Body(mesh);
  run(body, 2);
  body.squash(true);
  run(body, 1);
  assert.equal(body.state, 'squashed');
  bounded(body);
  body.endSquash();
  run(body, 1);
  assert.notEqual(body.state, 'squashed');
  const settings = { ...controls, inflate: 1.8 };
  body.wake();
  run(body, 2, settings);
  body.pop(true);
  run(body, 0.2, settings);
  assert.ok(body.burst.active);
  run(body, 4, settings);
  assert.ok(!body.burst.active);
  bounded(body);
  assert.ok(Math.abs(body.metrics()[2] - settings.inflate) < 0.08);
  run(body, 8, settings);
  assert.equal(body.state, 'resting', 'with nothing acting on it, it rests');
});
