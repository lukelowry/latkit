/** Cancellation observes late rejections without abandoning a borrowed operation's promise. */
export function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      // AbortSignal permits arbitrary reasons; preserve caller identity.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
