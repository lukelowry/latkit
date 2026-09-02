import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, toArrayBuffer } from '../src/frame.js';

/** The frame's bytes as a buffer of their own, as a channel would deliver them. */
function buffer(frame: Uint8Array): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

/** A frame with a caller-written header, for exercising the decoder's checks. */
function forge(header: string, payload = new Uint8Array(8)): ArrayBuffer {
  const encoded = new TextEncoder().encode(header);
  const start = Math.ceil((12 + encoded.byteLength) / 8) * 8;
  const frame = new Uint8Array(start + payload.byteLength);
  frame.set([0x4c, 0x4b, 0x50, 0x46], 0);
  frame[4] = 1;
  new DataView(frame.buffer).setUint32(8, encoded.byteLength, true);
  frame.set(encoded, 12);
  frame.set(payload, start);
  return frame.buffer;
}

describe('frame', () => {
  it('round-trips JSON values with typed arrays anywhere, viewing the frame in place', () => {
    const message = {
      svc: 'source',
      kind: 'reply',
      id: 7,
      body: {
        time: Float64Array.of(0.5, 1.5),
        values: Float32Array.of(1, 2, 3, 4),
        bytes: Uint8Array.of(9, 8, 7),
        nested: [{ signed: Int32Array.of(-1, -2) }, 'text', null, true, [Uint16Array.of(1)]],
        empty: new Uint8Array(0),
      },
    };
    const received = buffer(encodeFrame(message));
    const decoded = decodeFrame(received) as typeof message;
    expect(decoded).toEqual(message);
    expect(decoded.body.time.buffer).toBe(received);
    expect(decoded.body.time.byteOffset % 8).toBe(0);
    expect(decoded.body.values.byteOffset % 8).toBe(0);
    expect(decoded.body.nested[4]).toEqual([Uint16Array.of(1)]);
  });

  it('carries a typed array as the whole message, and arrays of arrays', () => {
    expect(decodeFrame(buffer(encodeFrame(Uint8Array.of(1, 2))))).toEqual(Uint8Array.of(1, 2));
    expect(decodeFrame(buffer(encodeFrame([Float32Array.of(1), Float32Array.of(2)])))).toEqual([
      Float32Array.of(1),
      Float32Array.of(2),
    ]);
  });

  it('carries plain JSON, null, and an undefined message', () => {
    const plain = { a: 1, b: 'two', c: [null, false], d: { e: {} } };
    expect(decodeFrame(buffer(encodeFrame(plain)))).toEqual(plain);
    expect(decodeFrame(buffer(encodeFrame(null)))).toBeNull();
    expect(decodeFrame(buffer(encodeFrame(undefined)))).toBeUndefined();
  });

  it('refuses binary it cannot carry and objects that are not plain', () => {
    expect(() => encodeFrame({ view: new DataView(new ArrayBuffer(8)) })).toThrow(
      'a frame cannot carry DataView',
    );
    expect(() => encodeFrame(new ArrayBuffer(8))).toThrow('a frame cannot carry ArrayBuffer');
    expect(() => encodeFrame({ big: new BigInt64Array(1) })).toThrow(
      'a frame cannot carry BigInt64Array',
    );
    expect(() => encodeFrame({ when: new Date(0) })).toThrow('a frame cannot carry Date');
    expect(() => encodeFrame(new Map())).toThrow('a frame cannot carry Map');
  });

  it('rejects a frame that is truncated, foreign, or from another version', () => {
    expect(() => decodeFrame(new ArrayBuffer(2))).toThrow('frame is truncated');
    expect(() => decodeFrame(new ArrayBuffer(16))).toThrow('frame is not a latkit port frame');
    const frame = encodeFrame({ ok: true });
    frame[4] = 2;
    expect(() => decodeFrame(buffer(frame))).toThrow('frame version 2 is not supported');
  });

  it('rejects a header or an array that overruns the frame', () => {
    const frame = encodeFrame({ values: Float32Array.of(1, 2) });
    expect(() => decodeFrame(buffer(frame).slice(0, 14))).toThrow(
      'frame header overruns the frame',
    );
    expect(() => decodeFrame(buffer(frame).slice(0, frame.byteLength - 4))).toThrow(
      'frame array overruns the frame',
    );
  });

  it('rejects a header that is not JSON or names arrays badly', () => {
    expect(() => decodeFrame(forge('not json'))).toThrow('frame header is not JSON');
    expect(() => decodeFrame(forge('[]'))).toThrow('frame header is malformed');
    expect(() => decodeFrame(forge('{"body":{},"arrays":{}}'))).toThrow(
      'frame header is malformed',
    );
    expect(() =>
      decodeFrame(forge('{"body":{"x":null},"arrays":[{"path":["x"],"kind":"f99","bytes":8}]}')),
    ).toThrow('frame header is malformed');
    expect(() =>
      decodeFrame(forge('{"body":{"x":null},"arrays":[{"path":[true],"kind":"f64","bytes":8}]}')),
    ).toThrow('frame header is malformed');
    expect(() =>
      decodeFrame(
        forge(
          '{"body":{"x":null},"arrays":[{"path":["x"],"kind":"f64","bytes":12}]}',
          new Uint8Array(16),
        ),
      ),
    ).toThrow('frame array is not whole elements');
  });

  it('rejects an array path that does not point at a placeholder', () => {
    expect(() =>
      decodeFrame(forge('{"body":{"x":1},"arrays":[{"path":["x"],"kind":"f64","bytes":8}]}')),
    ).toThrow('frame array path is invalid');
    expect(() =>
      decodeFrame(forge('{"body":{},"arrays":[{"path":["missing"],"kind":"f64","bytes":8}]}')),
    ).toThrow('frame array path is invalid');
    expect(() =>
      decodeFrame(forge('{"body":[null],"arrays":[{"path":[1],"kind":"f64","bytes":8}]}')),
    ).toThrow('frame array path is invalid');
    expect(() =>
      decodeFrame(
        forge('{"body":{"a":null},"arrays":[{"path":["a","b"],"kind":"f64","bytes":8}]}'),
      ),
    ).toThrow('frame array path is invalid');
    expect(() =>
      decodeFrame(forge('{"body":1,"arrays":[{"path":[],"kind":"f64","bytes":8}]}')),
    ).toThrow('frame array path is invalid');
  });

  it('defines a __proto__ array as an own property and leaves the prototype alone', () => {
    const decoded = decodeFrame(
      forge(
        '{"body":{"__proto__":null},"arrays":[{"path":["__proto__"],"kind":"u8","bytes":1}]}',
        Uint8Array.of(1),
      ),
    ) as object;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toEqual(Uint8Array.of(1));
  });
});

describe('toArrayBuffer', () => {
  it('passes a buffer through, unwraps a whole view, slices a window, and drops the rest', () => {
    const whole = new ArrayBuffer(16);
    expect(toArrayBuffer(whole)).toBe(whole);
    expect(toArrayBuffer(new Uint8Array(whole))).toBe(whole);
    const window = toArrayBuffer(new Uint8Array(whole, 4, 8));
    expect(window).not.toBe(whole);
    expect(window?.byteLength).toBe(8);
    expect(toArrayBuffer('text')).toBeNull();
    expect(toArrayBuffer(null)).toBeNull();
    expect(toArrayBuffer({})).toBeNull();
  });
});
