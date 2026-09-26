import type { RGBA } from '@latkit/model';

/**
 * An RGBA in `[0, 1]` from a CSS color: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`),
 * `rgb()`/`rgba()` in either syntax, `oklab()`, `oklch()`, `color(srgb …)`,
 * `color(srgb-linear …)`, or `transparent`. With `context`, any other color is resolved as that
 * element computes it, so custom properties, named colors, and `color-mix()` work too. Colors
 * outside sRGB clamp into it.
 *
 * @param css - A CSS color.
 * @param context - The element whose custom properties the color reads.
 * @returns The color, or null when it is not one; with `context`, also when a `var()` it reads is
 * undefined.
 *
 * @example
 * ```ts
 * parseColor('#e8e8e8'); // [0.91, 0.91, 0.91, 1]
 * parseColor('var(--edge)', document.body) ?? fallback;
 * ```
 */
export function parseColor(css: string, context?: Element): RGBA | null {
  const literal = parse(css);
  if (literal || !context) return literal;
  const resolved = computed(css, context);
  return resolved === null ? null : parse(resolved);
}

function parse(css: string): RGBA | null {
  const value = css.trim().toLowerCase();
  if (value === 'transparent') return [0, 0, 0, 0];
  return value.startsWith('#') ? hex(value.slice(1)) : functional(value);
}

/**
 * The color a probe inside `context` computes, or null when it is none. The probe reads the color
 * through a custom property, which computes empty when a `var()` in it is undefined.
 */
function computed(css: string, context: Element): string | null {
  const view = context.ownerDocument.defaultView;
  if (!view) return null;
  const probe = context.ownerDocument.createElement('span');
  probe.style.setProperty('--latkit-color', css);
  probe.style.setProperty('color', 'var(--latkit-color)');
  probe.style.display = 'none';
  context.append(probe);
  const style = view.getComputedStyle(probe);
  const resolved = style.getPropertyValue('--latkit-color').trim();
  const color = style.color;
  probe.remove();
  if (resolved === '' || view.CSS?.supports?.('color', resolved) === false) return null;
  return color;
}

function hex(digits: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  const short = digits.length === 3 || digits.length === 4;
  if (!short && digits.length !== 6 && digits.length !== 8) return null;
  const width = short ? 1 : 2;
  const channel = (i: number): number => {
    const part = digits.slice(i * width, i * width + width);
    return Number.parseInt(short ? part + part : part, 16) / 255;
  };
  const alpha = digits.length === 4 || digits.length === 8 ? channel(3) : 1;
  return [channel(0), channel(1), channel(2), alpha];
}

/** A color function: its name, three components, and an optional alpha. */
function functional(value: string): RGBA | null {
  const match = /^([a-z-]+)\((.*)\)$/.exec(value);
  if (!match) return null;
  const [, name, body] = match as unknown as [string, string, string];
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const parts = components(body, true);
      if (!parts) return null;
      const [r, g, b] = parts.channels.map((part) => number(part, 255));
      return color(r! / 255, g! / 255, b! / 255, parts.alpha);
    }
    case 'oklab': {
      const parts = components(body, false);
      if (!parts) return null;
      const [l, a, b] = parts.channels;
      return oklab(number(l!, 1), number(a!, 0.4), number(b!, 0.4), parts.alpha);
    }
    case 'oklch': {
      const parts = components(body, false);
      if (!parts) return null;
      const [l, c, h] = parts.channels;
      const hue = angle(h!) * (Math.PI / 180);
      const chroma = number(c!, 0.4);
      return oklab(number(l!, 1), chroma * Math.cos(hue), chroma * Math.sin(hue), parts.alpha);
    }
    case 'color': {
      const [space, ...rest] = body.trim().split(/\s+/);
      if (space !== 'srgb' && space !== 'srgb-linear') return null;
      const parts = components(rest.join(' '), false);
      if (!parts) return null;
      const [r, g, b] = parts.channels.map((part) => number(part, 1));
      return space === 'srgb'
        ? color(r!, g!, b!, parts.alpha)
        : color(gamma(r!), gamma(g!), gamma(b!), parts.alpha);
    }
    default:
      return null;
  }
}

/** Three channel tokens and the alpha, from the space- or (with `legacy`) comma-separated form. */
function components(
  body: string,
  legacy: boolean,
): { readonly channels: readonly string[]; readonly alpha: string | null } | null {
  if (legacy && body.includes(',')) {
    const parts = body.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    return { channels: parts.slice(0, 3), alpha: parts[3] ?? null };
  }
  const [head, alpha, extra] = body.split('/');
  if (extra !== undefined) return null;
  const channels = head!.trim().split(/\s+/);
  return channels.length === 3 ? { channels, alpha: alpha?.trim() ?? null } : null;
}

/** A number or percentage token, a percentage scaled so 100% is `percent`; NaN when neither. */
function number(token: string, percent: number): number {
  if (token === 'none') return 0;
  if (token.endsWith('%')) return (strict(token.slice(0, -1)) / 100) * percent;
  return strict(token);
}

/** A hue in degrees from a number or an angle token. */
function angle(token: string): number {
  if (token === 'none') return 0;
  const match = /^(.*?)(deg|rad|grad|turn)?$/.exec(token)!;
  const value = strict(match[1]!);
  switch (match[2]) {
    case 'rad':
      return (value * 180) / Math.PI;
    case 'grad':
      return value * 0.9;
    case 'turn':
      return value * 360;
    default:
      return value;
  }
}

function strict(token: string): number {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(token) ? Number(token) : Number.NaN;
}

/** Oklab to sRGB, by Björn Ottosson's closed form. */
function oklab(l: number, a: number, b: number, alpha: string | null): RGBA | null {
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return color(
    gamma(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
    gamma(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
    gamma(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
    alpha,
  );
}

/** Linear light to the sRGB transfer curve. */
function gamma(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055;
}

/** Clamped channels and alpha, or null when any is not a number. */
function color(r: number, g: number, b: number, alpha: string | null): RGBA | null {
  const a = alpha === null ? 1 : number(alpha, 1);
  const rgba: RGBA = [clamp(r), clamp(g), clamp(b), clamp(a)];
  return rgba.every(Number.isFinite) ? rgba : null;
}

function clamp(x: number): number {
  return Math.min(1, Math.max(0, x));
}
