type Child = Node | string | null | undefined | false;
type Attributes = Record<string, string | number | boolean | undefined>;

/** Creates an element with `attributes` and `children`. Attributes that are `false` or `undefined`
 * are omitted, `true` sets an empty attribute, and falsy children are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== false && value !== undefined)
      element.setAttribute(name, value === true ? '' : String(value));
  }
  element.append(...children.filter((child): child is Node | string => !!child));
  return element;
}
