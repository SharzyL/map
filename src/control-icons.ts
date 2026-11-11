// Swaps the glyphs of MapLibre's own control buttons for Lucide icons, so every
// toolbar button shares one icon set, size and stroke (style.css). The compass
// keeps MapLibre's needle, which turns with the map.
import createIconElement from 'lucide/dist/esm/createElement.mjs';
import LocateFixedIcon from 'lucide/dist/esm/icons/locate-fixed.mjs';
import MaximizeIcon from 'lucide/dist/esm/icons/maximize.mjs';
import MinimizeIcon from 'lucide/dist/esm/icons/minimize.mjs';
import MinusIcon from 'lucide/dist/esm/icons/minus.mjs';
import PlusIcon from 'lucide/dist/esm/icons/plus.mjs';

const CONTROL_ICONS: Array<[string, LucideIcon[]]> = [
  ['.maplibregl-ctrl-zoom-in', [PlusIcon]],
  ['.maplibregl-ctrl-zoom-out', [MinusIcon]],
  // The button turns into .maplibregl-ctrl-shrink in fullscreen; style.css
  // shows the icon that matches.
  ['.maplibregl-ctrl-fullscreen', [MaximizeIcon, MinimizeIcon]],
  ['.maplibregl-ctrl-geolocate', [LocateFixedIcon]],
];

// Call after the controls are added; MapLibre creates their icon spans in onAdd.
export function installControlIcons(map: { getContainer(): HTMLElement }) {
  for (const [selector, icons] of CONTROL_ICONS) {
    const span = map.getContainer().querySelector(`${selector} > .maplibregl-ctrl-icon`);
    if (!span) continue;
    span.classList.add('ctrl-lucide-icon');
    span.replaceChildren(
      ...icons.map((icon) => createIconElement(icon, { 'aria-hidden': 'true', focusable: 'false' })),
    );
  }
}
