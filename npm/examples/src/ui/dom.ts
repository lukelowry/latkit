type Child = Node | string | null | undefined | false;
type Attributes = Record<string, string | number | boolean | undefined>;

/** An element with attributes and children; `false` and `undefined` attributes are left off. */
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
