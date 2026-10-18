/**
 * The characterization: per scenario, a row per phase and measure, a column per size, and the
 * exponent each grows by; against the old packages' times, where they were measured, the ratio.
 */
import type { Listed } from './page/main.ts';
import type { Summary, TimeBaseline, Verdict } from './judge.ts';

const ms = (v: number) => v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0);
const bytes = (v: number) =>
  v < 2 ** 20 ? `${(v / 1024).toFixed(0)}K` : `${(v / 2 ** 20).toFixed(v < 10 * 2 ** 20 ? 1 : 0)}M`;
const count = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${n}`;

/** Each scenario's phases at each size, the exponent each grows by, and against the old packages. */
export function report(
  list: Listed[],
  { summaries, exponents }: Verdict,
  old?: TimeBaseline,
): string {
  const out: string[] = [];
  for (const scenario of list) {
    const bySize = summaries[scenario.name];
    if (!bySize) continue;
    const sizes = Object.keys(bySize)
      .map(Number)
      .sort((a, b) => a - b);
    out.push('', `${scenario.name}: ${scenario.about}`);
    out.push(
      `${scenario.unit.padEnd(26)}${sizes.map((n) => count(n).padStart(9)).join('')}   grows`,
    );
    for (const phase of Object.keys(bySize[sizes[0]!]!)) {
      const e = exponents[scenario.name]?.[phase];
      const steady = bySize[sizes[0]!]![phase]!.steady;
      type Row = [string, (s: Summary) => number, (v: number) => string, number | undefined];
      const rows: Row[] = [
        [steady ? 'cpu ms/frame' : 'ms', (s) => s.time, ms, e?.time],
        ['gpu ms/frame', (s) => s.gpu, ms, e?.gpu],
        ['longest gap ms', (s) => s.gap, ms, undefined],
        ['uploaded', (s) => s.work.uploaded, bytes, e?.uploaded],
        ...(phase === 'load'
          ? [['resident', (s: Summary) => s.work.resident, bytes, e?.resident] as Row]
          : []),
      ];
      for (const [label, read, format, grows] of rows) {
        const cells = sizes.map((n) => bySize[n]?.[phase]);
        const time = label.includes('ms') && !label.startsWith('gpu');
        if (!time && cells.every((s) => !s || !read(s))) continue;
        const values = cells.map((s) => (s ? format(read(s)) : '-').padStart(9)).join('');
        const exponent = grows === undefined ? '' : `n^${grows.toFixed(2)}`;
        out.push(`  ${`${phase} ${label}`.padEnd(24)}${values}   ${exponent}`);
      }
      const then = sizes.map((n) => old?.times[scenario.name]?.[n]?.[phase]);
      if (then.some(Boolean)) {
        const ratios = sizes.map((n, i) => {
          const now = bySize[n]?.[phase];
          return (then[i] && now ? `${(now.time / then[i]!.time).toFixed(2)}×` : '-').padStart(9);
        });
        out.push(`  ${`${phase} vs old`.padEnd(24)}${ratios.join('')}`);
      }
    }
  }
  return out.join('\n');
}
