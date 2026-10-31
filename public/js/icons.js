import { h } from './util.js';
import { ROLE_HINTS, roleLabel } from './roles.js';

/** Контурні іконки ролей (24×24, stroke = currentColor), у стилі Lucide. Колір завжди успадковується від тексту. */
const ROLE_ICON_PARTS = {
  owner: ['M3 7l4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7z', 'M5 21h14'],
  admin: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M8.5 12l2.5 2.5 5-5'],
  manager: ['M3 9a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z', 'M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2', 'M3 13h18'],
  translator: ['M4 5h8', 'M8 3v2', 'M5.5 5c.8 3 2.7 5.5 5.5 7', 'M10.5 5c-.8 3-3 5.5-6.5 7', 'M13 20l4-9 4 9', 'M14.5 17h5'],
  editor: ['M17 3l4 4L8 20H4v-4L17 3z', 'M14 6l4 4'],
  reviewer: ['M12 3l2.3 1.7 2.8-.1.9 2.7 2.3 1.6-.9 2.7.9 2.7-2.3 1.6-.9 2.7-2.8-.1L12 21l-2.3-1.7-2.8.1-.9-2.7-2.3-1.6.9-2.7-.9-2.7 2.3-1.6.9-2.7 2.8.1L12 3z', 'M8.5 12l2.5 2.5 4.5-5'],
  observer: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 100 6 3 3 0 000-6z'],
  user: ['M12 4a4 4 0 100 8 4 4 0 000-8z', 'M4 21c0-4 3.6-7 8-7s8 3 8 7'],
};

const NS = 'http://www.w3.org/2000/svg';

/** SVG-іконка ролі; декоративна (підпис завжди поруч), тому aria-hidden. */
export function roleIcon(role, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'role-ic',
  })) svg.setAttribute(k, v);
  for (const d of ROLE_ICON_PARTS[role] ?? ROLE_ICON_PARTS.user) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Плашка ролі: іконка + підпис. Кольору ролі немає — лише форма й текст. */
export function roleBadge(role, { admin = false, title, style } = {}) {
  return h('span', { class: `pill role${admin ? ' admin' : ''}`, title: title ?? ROLE_HINTS[role] ?? null, style: style ?? null },
    roleIcon(role, 14), h('span', null, roleLabel(role)));
}

/**
 * Вибір ролі з іконками (звичайний <select> не вміє показувати SVG). Поводиться як select:
 * властивості value / disabled / title і подія 'change'; клавіатура: ↑ ↓ Enter Esc, Home/End.
 */
export function roleSelect({ value, roles, disabled = false, label = 'Роль у проєкті' }) {
  let current = value;
  let open = false;
  let panel = null;
  const trigger = h('button', { type: 'button', class: 'role-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label, disabled });
  const root = h('span', { class: 'role-select' }, trigger);

  const paint = () => {
    trigger.replaceChildren(roleIcon(current, 16), h('span', { class: 'role-name' }, roleLabel(current)), h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
    root.title = ROLE_HINTS[current] ?? '';
  };
  const close = (focus = true) => {
    if (!open) return;
    open = false; panel?.remove(); panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focus) trigger.focus();
  };
  const onOutside = (e) => { if (!root.contains(e.target)) close(false); };
  const choose = (r) => {
    close();
    if (r === current) return;
    current = r; paint();
    root.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const show = () => {
    if (open || trigger.disabled) return;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    const list = roles.includes(current) ? roles : [...roles, current];
    panel = h('div', { class: 'menu-panel left role-panel', role: 'listbox', 'aria-label': label },
      list.map((r) => h('button', {
        type: 'button', role: 'option', class: 'menu-item role-opt', 'aria-selected': r === current ? 'true' : 'false', title: ROLE_HINTS[r] ?? '',
        onclick: () => choose(r),
      }, roleIcon(r, 16), h('span', { class: 'role-name' }, roleLabel(r)), r === current && h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'))));
    panel.addEventListener('keydown', (e) => {
      const items = [...panel.querySelectorAll('[role=option]')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items.at(-1).focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close(false);
    });
    root.append(panel);
    document.addEventListener('pointerdown', onOutside, true);
    (panel.querySelector('[aria-selected=true]') ?? panel.querySelector('[role=option]')).focus();
  };
  trigger.addEventListener('click', () => (open ? close() : show()));
  trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); } });

  Object.defineProperties(root, {
    value: { get: () => current, set: (v) => { current = v; paint(); } },
    disabled: { get: () => trigger.disabled, set: (v) => { trigger.disabled = !!v; } },
  });
  paint();
  return root;
}

/** Службові іконки інтерфейсу (той самий стиль, що й у ролей). */
const UI_ICON_PARTS = {
  // лупа з двома стрілками всередині: «знайти й замінити»
  replace: ['M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13z', 'M15.5 16l5.5 5.5', 'M7.5 9.5h6l-1.8-1.8', 'M13.5 12.5h-6l1.8 1.8'],
};

export function uiIcon(name, size = 18) {
  const svg = roleIcon('user', size);
  svg.replaceChildren();
  svg.setAttribute('class', 'ui-ic');
  for (const d of UI_ICON_PARTS[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
