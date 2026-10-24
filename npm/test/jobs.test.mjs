import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { jobs } = await import(
  process.env.LATKIT_TEST_PACKAGE
    ? pathToFileURL(path.join(process.env.LATKIT_TEST_PACKAGE, 'dist/jobs.js')).href
    : new URL('../src/jobs.ts', import.meta.url).href
);

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

class Worker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  sent = [];
  terminated = false;
  postMessage(message) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer(data) {
    this.onmessage?.({ data });
  }
}

test('workers start on demand, handshake, retire when idle, and restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  const run = jobs(module, () => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  });
  assert.equal(workers.length, 0);
  const result = run(new Uint8Array([1]));
  const worker = workers[0];
  assert.deepEqual(worker.sent, [module]);
  worker.answer({ ready: true });
  assert.deepEqual(worker.sent[1], new Uint8Array([1]));
  worker.answer({ bytes: new Uint8Array([2]) });
  assert.deepEqual(await result, new Uint8Array([2]));
  t.mock.timers.tick(30_000);
  assert(worker.terminated);
  const next = run(new Uint8Array([3]));
  assert.equal(workers.length, 2);
  workers[1].answer({ ready: true });
  workers[1].answer({ bytes: new Uint8Array([4]) });
  await next;
  t.mock.timers.tick(30_000);
});

test('failed startup, malformed messages, and timeouts reject instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  const run = jobs(module, () => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  });
  const startup = assert.rejects(run(new Uint8Array()), /bad module/);
  workers[0].answer({ error: 'bad module' });
  await startup;
  assert(workers[0].terminated);
  const message = assert.rejects(run(new Uint8Array()), /read worker/);
  workers[1].onmessageerror();
  await message;
  const timeout = assert.rejects(run(new Uint8Array()), /timed out/);
  t.mock.timers.tick(60_000);
  await timeout;
  assert(workers.every((worker) => worker.terminated));
});

test('worker construction failure rejects, and later calls can recover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new Worker();
  let failed = false;
  const run = jobs(module, () => {
    if (!failed) {
      failed = true;
      throw new Error('blocked by CSP');
    }
    return worker;
  });
  await assert.rejects(run(new Uint8Array()), /CSP/);
  const next = run(new Uint8Array());
  worker.answer({ ready: true });
  worker.answer({ bytes: new Uint8Array() });
  await next;
  t.mock.timers.tick(30_000);
});

test('jobs at once get a worker each; a failed one rejects only its job; idle ones are reused', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  const run = jobs(module, () => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  });
  const lost = assert.rejects(run(new Uint8Array([0])), /lost worker/);
  const kept = run(new Uint8Array([1]));
  assert.equal(workers.length, 2, 'nothing waits in the page: latkit hands over only what runs');
  workers[0].onerror({ preventDefault() {}, message: 'lost worker' });
  await lost;
  workers[1].answer({ ready: true });
  workers[1].answer({ bytes: new Uint8Array([1]) });
  assert.deepEqual(await kept, new Uint8Array([1]));
  const again = run(new Uint8Array([2]));
  assert.equal(workers.length, 2, 'the idle worker takes the next job');
  assert.deepEqual(workers[1].sent.at(-1), new Uint8Array([2]));
  workers[1].answer({ bytes: new Uint8Array([3]) });
  assert.deepEqual(await again, new Uint8Array([3]));
  t.mock.timers.tick(30_000);
  assert(workers.every((worker) => worker.terminated));
});
