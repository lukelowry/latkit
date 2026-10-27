import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const directory = process.env.LATKIT_TEST_PACKAGE ?? path.resolve(import.meta.dirname, '..');
const { Video, Shot } = await import(pathToFileURL(path.join(directory, 'dist/shot.js')).href);

/** A bindings task of `promise`. Cancelling it rejects the promise, as the bindings' tasks do. */
function task(promise) {
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => reject(new Error('cancelled'));
  });
  return { promise: Promise.race([promise, cancelled]), cancel, free() {} };
}

/** A video over fake bindings, whose `frame` and `finish` promises can be replaced. */
function recording(sink = {}, { frame, finish } = {}) {
  const calls = { free: 0, cancel: 0, abort: 0, close: 0 };
  const stream = new WritableStream({
    abort() {
      calls.abort++;
    },
    close() {
      calls.close++;
    },
    ...sink,
  });
  const inner = {
    frames: 0,
    frame() {
      this.frames++;
      return task(frame?.() ?? Promise.resolve(Uint8Array.of(1)));
    },
    finish() {
      return task(finish?.() ?? Promise.resolve(Uint8Array.of(2)));
    },
    free() {
      calls.free++;
    },
    cancel() {
      calls.cancel++;
    },
  };
  return { video: Video.made(inner, stream.getWriter(), 30), stream, calls, inner };
}

test('finish retains counters and releases the output exactly once', async () => {
  const { video, stream, calls } = recording();
  await video.frame();
  const finished = video.finish();
  assert.equal(video.finish(), finished);
  await finished;
  await video.abort();
  assert.equal(video.frames, 1);
  assert.equal(video.time, 1 / 30);
  assert.equal(stream.locked, false);
  assert.deepEqual(calls, { free: 1, cancel: 0, abort: 0, close: 1 });
});

test('record aborts and unlocks on step and progress failures', async () => {
  for (const progress of [false, true]) {
    const { video, stream, calls } = recording();
    const error = new Error('record failed');
    await assert.rejects(
      video.record(
        () => {
          if (!progress) throw error;
          return true;
        },
        () => {
          throw error;
        },
      ),
      error,
    );
    assert.equal(stream.locked, false);
    assert.equal(calls.free, 1);
    assert.equal(calls.abort, 1);
  }
});

test('write failures close the encoder and release the output lock', async () => {
  const { video, stream, calls } = recording({
    write() {
      throw new Error('disk full');
    },
  });
  await assert.rejects(video.frame(), /disk full/);
  assert.equal(stream.locked, false);
  assert.equal(calls.free, 1);
  assert.equal(calls.cancel, 1);
});

test('abort interrupts a pending finish and is idempotent', async () => {
  const { video, stream, calls } = recording({}, { finish: () => new Promise(() => {}) });
  const finished = video.finish();
  await Promise.resolve();
  const rejected = assert.rejects(finished, /cancelled/);
  const aborted = video.abort('stop');
  assert.equal(video.abort(), aborted);
  await Promise.all([aborted, rejected]);
  assert.equal(stream.locked, false);
  assert.equal(calls.free, 1);
  await assert.rejects(video.frame(), { code: 'cancelled', cause: 'stop' });
});

test('an abort while a frame draws rejects the frame, even one that finished first', async () => {
  const { video, stream } = recording({}, { frame: () => Promise.resolve(new Uint8Array()) });
  const frame = video.frame();
  const aborted = video.abort('stop');
  await assert.rejects(frame, { code: 'cancelled', cause: 'stop' });
  await aborted;
  assert.equal(stream.locked, false);
});

test('concurrent frames reject without disrupting the frame already drawing', async () => {
  let resolveFrame;
  const { video } = recording(
    {},
    {
      frame: () =>
        new Promise((resolve) => {
          resolveFrame = resolve;
        }),
    },
  );
  const frame = video.frame();
  await assert.rejects(video.frame(), { code: 'invalid', message: /one frame/ });
  resolveFrame(new Uint8Array());
  await frame;
  await video.finish();
  await assert.rejects(video.frame(), { code: 'invalid' }, 'no frames after finish()');
});

test('locked outputs make no encoder, and failing to make one unlocks the output', () => {
  const shot = new Shot([64, 64]);
  const stream = new WritableStream();
  const writer = stream.getWriter();
  assert.throws(() => shot.video({ fps: 30, output: stream }), /locked/);
  writer.releaseLock();
  assert.throws(() => shot.video({ fps: 30, output: stream }), { code: 'unloaded' });
  assert.equal(stream.locked, false);
});
