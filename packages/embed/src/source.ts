import type { Channel, ChannelRange } from '@latkit/network';

import type { NetworkData } from './data/types.js';
import { parseNetwork } from './data/parse.js';
import { validateNetworkData } from './data/validate.js';

/** Effective input source selected by element precedence. */
export type NetworkSource =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'url'; readonly value: string }
  | { readonly kind: 'inline' };

/** Source identity and decoded cache retained across activations. */
export interface InputRevision {
  readonly source: NetworkSource;
  decoded?: NetworkData;
  /** Direct channel arrays are topology-dependent and live for one input revision. */
  readonly directChannels: Partial<Record<Channel, DirectChannelBinding>>;
  /** Programmatic or pointer selection retained through same-source recovery. */
  selected: readonly ['vertex' | 'edge', number] | null;
}

/** One direct Network-style channel binding retained by an input revision. */
export interface DirectChannelBinding {
  readonly values: Float32Array;
  readonly baseDomain?: ChannelRange | null;
  readonly outputRange?: ChannelRange;
}

/** Create a fresh input revision, clearing topology-dependent state. */
export function createInputRevision(source: NetworkSource): InputRevision {
  return { source, directChannels: {}, selected: null };
}

/** Select direct data, URL data, or inline data in deterministic precedence order. */
export function selectSource(host: HTMLElement, direct: unknown): NetworkSource {
  if (direct !== null) return { kind: 'data', value: direct };
  const src = host.getAttribute('src');
  return src === null ? { kind: 'inline' } : { kind: 'url', value: src };
}

/** Resolve, validate, and cache one input revision. */
export async function resolveInput(
  input: InputRevision,
  host: HTMLElement,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<NetworkData> {
  throwIfAborted(signal);
  if (input.decoded) return input.decoded;

  let data: NetworkData;
  switch (input.source.kind) {
    case 'data': {
      try {
        validateNetworkData(input.source.value);
      } catch (cause) {
        throw new Error(`@latkit/embed: invalid data property: ${message(cause)}`, { cause });
      }
      data = input.source.value;
      break;
    }
    case 'url':
      data = await fetchNetwork(input.source.value, host.baseURI, signal, fetcher);
      break;
    case 'inline':
      data = parseInlineNetwork(host);
      break;
    default:
      input.source satisfies never;
      throw new Error('@latkit/embed: unreachable network source');
  }

  throwIfAborted(signal);
  input.decoded = data;
  return data;
}

/** Fetch one serialized network using normal URL and CORS semantics. */
async function fetchNetwork(
  source: string,
  base: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<NetworkData> {
  let url: URL;
  try {
    url = new URL(source, base);
  } catch (cause) {
    throw new Error(`@latkit/embed: invalid src URL ${JSON.stringify(source)}`, { cause });
  }

  const response = await fetcher(url, { signal });
  if (!response.ok) {
    throw new Error(`@latkit/embed: ${url.href} returned HTTP ${response.status}`);
  }
  const serialized = (await response.json()) as unknown;
  return parseNetwork(serialized);
}

/** Parse the one direct-child JSON script used as an inline source. */
function parseInlineNetwork(host: HTMLElement): NetworkData {
  const scripts = Array.from(host.children).filter(
    (child) => child.localName === 'script' && child.getAttribute('type') === 'application/json',
  );
  if (scripts.length !== 1) {
    throw new Error(
      `@latkit/embed: expected one direct <script type="application/json">, found ${scripts.length}`,
    );
  }

  let serialized: unknown;
  try {
    serialized = JSON.parse(scripts[0]!.textContent ?? '') as unknown;
  } catch (cause) {
    throw new Error('@latkit/embed: inline network JSON is invalid', { cause });
  }
  return parseNetwork(serialized);
}

/** Stop decoded data from committing after its activation was cancelled. */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException('Activation superseded', 'AbortError');
}

/** Return a stable message for a caught validation failure. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
