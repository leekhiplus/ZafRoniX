/** Small DOM helpers. */

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{ className: string; text: string; attrs: Record<string, string> }> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Fills a <dl> with term/description pairs. */
export function fillDl(dl: HTMLElement, rows: Array<[string, string]>): void {
  clear(dl);
  for (const [term, desc] of rows) {
    const wrap = document.createElement('div');
    wrap.append(el('dt', { text: term }), el('dd', { text: desc }));
    dl.append(wrap);
  }
}

/** Fills a <ul> with list items. `tone` colours the item (info, warn, block). */
export function fillNotes(ul: HTMLElement, notes: Array<{ text: string; tone: 'info' | 'warn' | 'block' }>): void {
  clear(ul);
  for (const n of notes) ul.append(el('li', { className: `note note-${n.tone}`, text: n.text }));
  ul.hidden = notes.length === 0;
}

export function readRadio(name: string): string {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return input ? input.value : '';
}

export function setRadio(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

export function setRadioDisabled(name: string, value: string, disabled: boolean, title = ''): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (!input) return;
  input.disabled = disabled;
  const label = input.closest('label');
  if (label) {
    if (title) label.setAttribute('title', title);
    else label.removeAttribute('title');
  }
}
