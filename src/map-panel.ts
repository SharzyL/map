// Shared markup for the map's settings panels (railway filter, map display).
// Each panel passes its own class prefix, e.g. `railway-filter` produces
// `railway-filter-panel`, `railway-filter-check`, ...; style.css styles the
// prefixes together.
import createIconElement from 'lucide/dist/esm/createElement.mjs';

export function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  parent?: Node,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

export function stopMapControlPropagation(node: Element) {
  node.addEventListener('contextmenu', (event) => event.stopPropagation());
  node.addEventListener('dblclick', (event) => event.stopPropagation());
  node.addEventListener('mousedown', (event) => event.stopPropagation());
  node.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
  node.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

// A MapLibre control group holding one icon button that toggles a panel.
export function createPanelButton(className: string, label: string, icon: LucideIcon, iconClass: string) {
  const control = el('div', 'maplibregl-ctrl maplibregl-ctrl-group');
  const button = el('button', className, control);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIconElement(icon, { class: iconClass, 'aria-hidden': 'true', focusable: 'false' }));
  return { control, button };
}

export function createPanelShell(
  container: HTMLElement,
  prefix: string,
  options: { title: string; label: string; closeLabel: string; onClose: () => void },
) {
  const panel = el('section', `${prefix}-panel`, container);
  panel.setAttribute('aria-label', options.label);
  panel.setAttribute('aria-hidden', 'true');
  stopMapControlPropagation(panel);

  const header = el('div', `${prefix}-header`, panel);
  const titleWrap = el('div', `${prefix}-title-wrap`, header);
  el('div', `${prefix}-title`, titleWrap).textContent = options.title;
  const summary = el('div', `${prefix}-summary`, titleWrap);
  const closeButton = el('button', `${prefix}-close`, header);
  closeButton.type = 'button';
  closeButton.title = options.closeLabel;
  closeButton.setAttribute('aria-label', options.closeLabel);
  closeButton.textContent = 'x';
  closeButton.addEventListener('click', options.onClose);

  const body = el('div', `${prefix}-body`, panel);
  return { panel, summary, body };
}

export function createPanelFields(prefix: string) {
  return {
    checkboxRow(parent: Element, label: string, hint?: string, type: 'checkbox' | 'radio' = 'checkbox') {
      const row = el('label', `${prefix}-check`, parent);
      const input = el('input', '', row);
      input.type = type;
      const text = el('span', `${prefix}-check-text`, row);
      el('span', `${prefix}-check-label`, text).textContent = label;
      if (hint) el('span', `${prefix}-check-hint`, text).textContent = hint;
      return input;
    },

    selectField(parent: Element, label: string, options: Array<[string, string]>) {
      const field = el('label', `${prefix}-field`, parent);
      el('span', `${prefix}-field-label`, field).textContent = label;
      const select = el('select', `${prefix}-select`, field);
      for (const [value, text] of options) {
        const option = el('option', '', select);
        option.value = value;
        option.textContent = text;
      }
      return select;
    },

    // A slider with its current value shown next to the label.
    rangeField(parent: Element, label: string, options: { min: number; max: number; step: number }) {
      const field = el('label', `${prefix}-field ${prefix}-range-field`, parent);
      const header = el('span', `${prefix}-range-header`, field);
      el('span', `${prefix}-field-label`, header).textContent = label;
      const value = el('span', `${prefix}-range-value`, header);
      const input = el('input', `${prefix}-range`, field);
      input.type = 'range';
      input.min = String(options.min);
      input.max = String(options.max);
      input.step = String(options.step);
      return { input, value };
    },

    group(parent: Element, title: string) {
      const fieldset = el('fieldset', `${prefix}-group`, parent);
      el('legend', `${prefix}-group-title`, fieldset).textContent = title;
      return fieldset;
    },
  };
}
