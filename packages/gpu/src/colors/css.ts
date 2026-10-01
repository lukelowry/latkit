import { validateRgba, type RGBA } from './color.js';
import type { Colormap } from './colormap.js';
import { toRgba } from './conversion.js';
import { colormapPixels, pixelColor } from './sampling.js';

/** Parse an absolute CSS color, without accessing the DOM. Unsupported/contextual syntax returns null. */
export function parseColor(css: string): RGBA | null {
  return toRgba(css.trim());
}
/** Resolve custom properties and currentColor against an element; no DOM work occurs in rendering. */
export function resolveColor(css: string, context: Element): RGBA | null {
  const literal = parseColor(css);
  if (literal) return literal;
  const document = context.ownerDocument,
    view = document.defaultView;
  if (!view) return null;
  const probe = document.createElement('span');
  probe.style.setProperty('--latkit-resolved-color', css);
  probe.style.setProperty(
    'color',
    'color-mix(in srgb, var(--latkit-resolved-color) 100%, transparent)',
  );
  probe.style.display = 'none';
  (context.shadowRoot ?? context).append(probe);
  try {
    const style = view.getComputedStyle(probe);
    const value = style.getPropertyValue('--latkit-resolved-color').trim();
    if (!value || !view.CSS.supports('color', value)) return null;
    return parseColor(style.color);
  } finally {
    probe.remove();
  }
}
/** Explicit sRGB prevents browser defaults from changing the color space. */
export function colorCss(color: RGBA): string {
  validateRgba(color);
  return `color(srgb ${color[0]} ${color[1]} ${color[2]} / ${color[3]})`;
}
/** All table samples are preserved. Categorical colors have hard boundaries; cyclic maps close the seam. */
export function colormapCss(
  map: Colormap,
  options: { readonly direction?: 'to right' | 'to top' } = {},
): string {
  const direction = options.direction ?? 'to top';
  if (direction !== 'to right' && direction !== 'to top')
    throw new TypeError('Invalid gradient direction');
  const data = colormapPixels(map),
    stops: string[] = [];
  for (let i = 0; i < data.width; i++) {
    const color = colorCss(pixelColor(data, i));
    stops.push(
      map.kind === 'categorical'
        ? `${color} ${(i / data.width) * 100}% ${((i + 1) / data.width) * 100}%`
        : `${color} ${(i / (data.width - 1)) * 100}%`,
    );
  }
  return `linear-gradient(${direction} in srgb, ${stops.join(', ')})`;
}
