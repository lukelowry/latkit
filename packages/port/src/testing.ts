/**
 * `@latkit/port/testing` — the in-memory port pair a host's tests serve across, and the microtask
 * settle that lets its deliveries land. Every message crosses as a frame, so a payload that would
 * not survive a byte port fails in the unit lane.
 *
 * @packageDocumentation
 */

import { decodeFrame, encodeFrame } from './frame.js';
import type { Port } from './port.js';

/** One end of a loopback pair: a port plus the transport failure a test injects. */
export interface LoopbackPort extends Port {
  /** Deliver a transport failure to this end's subscribers, as a crashed peer would. */
  fail(reason: string): void;
}

interface Subscriber {
  readonly message: (value: unknown) => void;
  readonly close?: (reason: string) => void;
}

/** Two ports wired to each other; each delivers on a microtask like a real message channel. */
export function loopback(): [LoopbackPort, LoopbackPort] {
  const subscribers = [new Set<Subscriber>(), new Set<Subscriber>()] as const;
  const end = (mine: 0 | 1): LoopbackPort => {
    const peer = subscribers[mine === 0 ? 1 : 0];
    return {
      post(message) {
        const frame = encodeFrame(message);
        queueMicrotask(() => {
          const decoded = decodeFrame(frame.buffer as ArrayBuffer);
          for (const subscriber of [...peer]) subscriber.message(decoded);
        });
      },
      subscribe(onMessage, onClose) {
        const subscriber: Subscriber = { message: onMessage, close: onClose };
        subscribers[mine].add(subscriber);
        return () => void subscribers[mine].delete(subscriber);
      },
      fail(reason) {
        for (const subscriber of [...subscribers[mine]]) subscriber.close?.(reason);
      },
    };
  };
  return [end(0), end(1)];
}

/** Let every queued microtask-delivered message land. */
export async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}
