// Tooltips that show at once, unlike the browser's `title`, which waits a
// second or so and draws one plain line. An element given one (setTooltip)
// shows it while the mouse is over it or it has keyboard focus, above it, or
// below where there is no room, kept inside the window; moving from one such
// element to the next switches at once, so a row of minutes reads as fast as
// the pointer runs over them. Touch has no hover: there, as with `title`, it
// does not show.
//
// The content is text, a line per line (the first one bold when there are
// more), or a function building it when shown. Plain text is the element's
// accessible description too (aria-description).

export type TooltipContent = string | (() => Node);

const ATTRIBUTE = 'data-tooltip';
const SELECTOR = `[${ATTRIBUTE}]`;
const GAP = 6;
const MARGIN = 8;

const contents = new WeakMap<Element, TooltipContent>();
const installed = new WeakSet<Document>();

// Gives an element its tooltip, or takes it away (null, empty).
export function setTooltip(element: Element, content: TooltipContent | null | undefined | false) {
  element.removeAttribute('title');
  if (!content) {
    contents.delete(element);
    element.removeAttribute(ATTRIBUTE);
    element.removeAttribute('aria-description');
    return;
  }
  contents.set(element, content);
  element.setAttribute(ATTRIBUTE, '');
  if (typeof content === 'string') element.setAttribute('aria-description', content.split('\n').join('. '));
  else element.removeAttribute('aria-description');
  install(element.ownerDocument);
}

// What an element's tooltip says, as text (for tests and the like).
export function tooltipText(element: Element | null | undefined) {
  const content = element && contents.get(element);
  if (!content) return null;
  return typeof content === 'string' ? content : (content().textContent ?? '');
}

function render(tip: HTMLElement, content: TooltipContent) {
  tip.replaceChildren();
  if (typeof content !== 'string') {
    tip.appendChild(content());
    return;
  }
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const row = tip.ownerDocument.createElement('div');
    if (index === 0 && lines.length > 1) row.className = 'tooltip-head';
    row.textContent = line;
    tip.appendChild(row);
  }
}

// Above the element, centred on it; below it where the window has no room
// above; never past the window's edges.
export function tooltipPosition(
  target: { left: number; top: number; width: number; bottom: number },
  tip: { width: number; height: number },
  view: { width: number; height: number },
) {
  const above = target.top - GAP - tip.height;
  const top = above >= MARGIN ? above : Math.min(target.bottom + GAP, view.height - MARGIN - tip.height);
  const centred = target.left + target.width / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(centred, view.width - MARGIN - tip.width));
  return { left, top: Math.max(MARGIN, top), below: above < MARGIN };
}

function install(doc: Document) {
  if (installed.has(doc)) return;
  installed.add(doc);
  const view = doc.defaultView;
  const tip = doc.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  let current: Element | null = null;
  let watch: ReturnType<typeof setInterval> | undefined;

  const hide = () => {
    current = null;
    tip.hidden = true;
    clearInterval(watch);
  };
  const show = (target: Element) => {
    const content = contents.get(target);
    if (!content) return hide();
    current = target;
    if (!tip.isConnected) doc.body.appendChild(tip);
    render(tip, content);
    tip.hidden = false;
    const box = tip.getBoundingClientRect();
    const place = tooltipPosition(
      target.getBoundingClientRect(),
      { width: box.width, height: box.height },
      { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    );
    tip.style.left = `${place.left}px`;
    tip.style.top = `${place.top}px`;
    tip.classList.toggle('tooltip-below', place.below);
    // A view redrawn under the pointer (a click, data coming in) takes the
    // element away without a pointer event.
    clearInterval(watch);
    watch = setInterval(() => {
      if (!current?.isConnected) hide();
    }, 300);
  };
  const tooltipOf = (node: EventTarget | null) =>
    node instanceof Element ? (node.closest(SELECTOR) as Element | null) : null;

  doc.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const target = tooltipOf(event.target);
    if (target === current) return;
    if (target) show(target);
    else hide();
  });
  doc.addEventListener('pointerout', (event) => {
    // Out of the window
    if (!event.relatedTarget && current) hide();
  });
  doc.addEventListener('focusin', (event) => {
    const target = tooltipOf(event.target);
    if (target && target === event.target && target.matches(':focus-visible')) show(target);
  });
  doc.addEventListener('focusout', (event) => {
    if (event.target === current) hide();
  });
  doc.addEventListener('pointerdown', hide);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  doc.addEventListener('scroll', hide, true);
}
