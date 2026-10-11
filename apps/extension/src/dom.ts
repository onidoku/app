/** Tiny element helper. Text is always set via textContent, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function button(label: string, className: string, onClick: () => unknown, title?: string): HTMLButtonElement {
  const el = h('button', { type: 'button', class: className, text: label, title });
  el.addEventListener('click', () => void onClick());
  return el;
}
