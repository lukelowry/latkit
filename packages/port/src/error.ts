/**
 * The one error-to-text rule the wire uses when a handler fails, exported so a message shown
 * locally reads exactly as one that crossed a port.
 */

/**
 * The human-facing message of any thrown value.
 *
 * @remarks
 * An `AggregateError` lists its members in parentheses, so a failed cleanup that wrapped a failed
 * run keeps both causes visible.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = Array.from(error.errors, describeError).join('; ');
    return details ? `${error.message} (${details})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
