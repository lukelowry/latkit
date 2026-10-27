/** Returns the `q` quantile of `values`, from 0 (the least) to 1 (the greatest): the value that
 * fraction of the way through them in order, rounding down. Returns 0 when there are none. The
 * benchmark's page and runner use it too, so it imports nothing. */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))]!;
}
