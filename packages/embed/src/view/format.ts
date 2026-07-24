/** Format chrome numbers compactly without losing useful precision. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/** Convert a canonical camelCase or kebab-case name into a display label. */
export function humanizeName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/-/g, ' ')
    .trim();
  return words.length === 0 ? '' : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}
