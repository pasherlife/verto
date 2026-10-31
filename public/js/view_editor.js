import { h, clear, fmt, pct, plural, toast, debounce, menu, avatar } from './util.js';
import { get, post, patch, api, ApiError } from './api.js';
import { topbar } from './app.js';
import { pickAndImportTranslations, clearTranslations } from './translation_import.js';
import { openExportDialog } from './export_dialog.js';
import { openFindReplace } from './find_replace.js';
import { createStrip } from './strip.js';

const PAGE = 100;
const mobileMq = matchMedia('(max-width: 760px)');
let ROW_H = mobileMq.matches ? 66 : 54;
const TOKEN = /\{[^}]*\}|<[^>]+>/g;
const STATUS_NAME = ['Без статусу', 'На вичитку', 'Затверджено'];

const SVG_NS = 'http://www.w3.org/2000/svg';
function glyph(status) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'glyph');
  const add = (tag, attrs) => { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); s.append(e); };
  if (status === 0) add('circle', { cx: 8, cy: 8, r: 5, fill: 'none', stroke: 'var(--none)', 'stroke-width': 1.5 });
  else if (status === 1) { add('circle', { cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'var(--review)', 'stroke-width': 1.5 }); add('path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', fill: 'var(--review)' }); }
  else { add('circle', { cx: 8, cy: 8, r: 6.5, fill: 'var(--done)' }); add('path', { d: 'M5 8.2l2 2 4-4.4', fill: 'none', stroke: '#fff', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); }
  return s;
}

/** Текст із підсвіченими змінними {Name} та тегами <b>. */
function tokens(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: 'tok' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tokenDiff(source, translation) {
  const count = (t) => { const m = new Map(); for (const x of t.match(TOKEN) ?? []) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const a = count(source), b = count(translation);
  const missing = [], extra = [];
  for (const [k, n] of a) if ((b.get(k) ?? 0) < n) missing.push(k);
  for (const [k, n] of b) if ((a.get(k) ?? 0) < n) extra.push(k);
  return { missing, extra };
}

function chooseStatus(count) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const pick = (v) => dlg.close(String(v));
    dlg.append(h('h3', null, 'Змінити статус'),
      h('p', { class: 'muted' }, `Буде змінено статус для ${fmt(count)} ${plural(count, 'рядка', 'рядків', 'рядків')} за поточним фільтром.`),
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати'),
        h('button', { class: 'btn', onclick: () => pick(0) }, 'Скинути'),
        h('button', { class: 'btn review', onclick: () => pick(1) }, 'На вичитку'),
        h('button', { class: 'btn done', onclick: () => pick(2) }, 'Затвердити')));
    dlg.addEventListener('close', () => { const v = dlg.returnValue; dlg.remove(); resolve(v === 'cancel' || v === '' ? null : Number(v)); });
    document.body.append(dlg); dlg.showModal();
  });
}

export async function editorView(root, fileId) {
  const info = await get(`/api/files/${fileId}`);
  const { file, perms } = info;
  const base = file.name.split('/').pop();

  // ── Стан ──
  const st = {
    rev: info.rev ?? file.rev, stats: info.stats, filter: 'all', q: '', total: 0, gen: 0,
    cache: new Map(), inflight: new Map(), active: null, activeIndex: -1, selection: new Set(), anchor: -1,
    peers: [], conflict: null, saving: false, destroyed: false, pollTimer: null,
  };

  // ── Елементи ──
  const statsBox = h('div', { class: 'editor-stats num' });
  const strip = createStrip({ tall: true, onJump: (pos) => jumpToPos(pos) });
  const legend = h('div', { class: 'legend', style: 'margin-top:6px' },
    h('span', null, h('i', { class: 'k-done' }), 'затверджено'), h('span', null, h('i', { class: 'k-review' }), 'на вичитку'), h('span', null, h('i', { class: 'k-none' }), 'без статусу'),
    h('span', { class: 'dim hint-click' }, 'Клацніть по смузі, щоб перейти до місця у файлі'));

  const FILTERS = [['all', 'Усі'], ['untranslated', 'Без статусу'], ['review', 'На вичитку'], ['approved', 'Затверджені'], ['notapproved', 'Не затверджені'], ['changed', 'З перекладом'], ['mine', 'Мої правки']];
  const chipEls = new Map();
  const chips = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Фільтр рядків' }, FILTERS.map(([v, l]) => {
    const c = h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-selected': v === 'all', onclick: () => setFilter(v) }, l, h('span', { class: 'n num' }));
    chipEls.set(v, c);
    return c;
  }));
  function setFilter(v) {
    st.filter = v;
    for (const [k, el] of chipEls) el.setAttribute('aria-selected', String(k === v));
    resetList();
  }
  const searchInp = h('input', { type: 'search', placeholder: 'Пошук за текстом або ID', 'aria-label': 'Пошук', enterKeyHint: 'search' });
  const gotoInp = h('input', { type: 'number', class: 'goto', min: 1, placeholder: '№ рядка', 'aria-label': 'Перейти до рядка', inputMode: 'numeric' });
  const countLbl = h('span', { class: 'count num' });
  const selBox = h('div', { class: 'sel-actions hidden' });
  const reloadAll = () => { st.cache.clear(); st.gen++; resetList(); };
  function openReplace() {
    const filterLabels = { untranslated: 'без статусу', review: 'на вичитку', approved: 'затверджені', notapproved: 'незатверджені', changed: 'з перекладом', mine: 'мої' };
    const q = searchInp.value.trim();
    const label = [filterLabels[st.filter], q && `пошук «${q}»`].filter(Boolean).join(', ');
    openFindReplace({ fileId, fileName: base, canApprove: perms.canApprove, getScope: () => ({ active: !!label, label, filter: st.filter, q }), onDone: reloadAll });
  }
  const moreMenu = menu([
    perms.canEdit && !perms.archived && { label: 'Знайти й замінити…', onclick: openReplace },
    perms.canEdit && { label: 'Змінити статус для всіх за фільтром…', onclick: () => bulkAll() },
    perms.canImport && !perms.archived && { label: 'Імпортувати переклад (.locres / .csv / .txt / .json)…', onclick: () => pickAndImportTranslations({ fileId, fileName: base, canApprove: perms.canApprove, onDone: reloadAll }) },
    perms.canExport && { label: 'Скачати…', onclick: () => openExportDialog({ fileId, fileName: base, sourceFormat: file.format }) },
    perms.canClear && !perms.archived && { sep: true },
    perms.canClear && !perms.archived && { label: 'Очистити переклад…', danger: true, onclick: () => clearTranslations({ id: fileId, name: file.name }, reloadAll) },
  ], { label: 'Дії з файлом' });

  const spacer = h('div', { class: 'grid-spacer' });
  const body = h('div', { class: 'grid-body', tabIndex: 0, role: 'grid', 'aria-label': 'Рядки файлу' }, spacer);
  const emptyNote = h('div', { class: 'empty hidden' }, h('strong', null, 'Нічого не знайдено'), 'Змініть фільтр або пошуковий запит.');

  const srcBox = h('div', { class: 'src-box' });
  const idLbl = h('span', { class: 'id' });
  const posLbl = h('span', null);
  const area = h('textarea', { rows: 3, 'aria-label': 'Переклад', placeholder: perms.canEdit ? 'Введіть переклад…' : '', readOnly: !perms.canEdit, spellcheck: true, lang: 'uk' });
  const warnBox = h('div', { class: 'warnings', 'aria-live': 'polite' });
  const conflictBox = h('div', { class: 'conflict hidden' });
  const statusLbl = h('span', { class: 'muted', style: 'font-size:13px' });
  const btnNext = h('button', { class: 'btn primary', onclick: () => saveActive({ advance: true }) }, 'Зберегти й далі');
  const btnReview = h('button', { class: 'btn review', onclick: () => saveActive({ status: 1 }) }, 'На вичитку');
  const btnApprove = h('button', { class: 'btn done', onclick: () => saveActive({ status: 2 }) }, 'Затвердити');
  const btnReset = h('button', { class: 'btn ghost', onclick: () => saveActive({ status: 0 }) }, 'Скинути статус');
  const btnCopy = h('button', { class: 'btn ghost', onclick: () => { if (!st.active) return; area.value = st.active.source; onInput(); area.focus(); } }, 'Скопіювати оригінал');
  const btnRevert = h('button', { class: 'btn ghost', onclick: revert }, 'Скасувати зміни');
  const btnClose = h('button', { class: 'btn ghost sheet-close', type: 'button', 'aria-label': 'Закрити редагування', onclick: closeSheet }, 'Закрити');

  const dock = h('section', { class: 'dock', 'aria-label': 'Редагування рядка' },
    h('div', { class: 'dock-grid' },
      h('div', null, h('div', { class: 'dock-label' }, h('span', null, 'Оригінал'), posLbl, idLbl, btnClose), srcBox),
      h('div', null, h('div', { class: 'dock-label' }, h('span', null, 'Переклад'), statusLbl), area, warnBox)),
    conflictBox,
    perms.canEdit
      ? h('div', { class: 'dock-actions' }, btnNext, btnReview, perms.canApprove && btnApprove, btnReset, btnCopy, btnRevert,
        h('span', { class: 'hint' }, 'Ctrl+Enter — зберегти й далі' + (perms.canApprove ? ' · Ctrl+Shift+Enter — затвердити й далі' : '') + ' · Alt+↑/↓ — між рядками'))
      : h('p', { class: 'ro-note' }, perms.archived ? 'Проєкт заархівовано — лише перегляд.'
        : perms.role === 'observer' ? 'Ви спостерігач: лише перегляд.'
        : 'Лише перегляд: вам не призначено цей файл для редагування.'));

  const editorEl = h('div', { class: 'editor' },
    topbar([{ label: 'Проєкти', href: '#/' }, { label: file.project, href: `#/p/${file.projectId}` }, { label: base }]),
    h('div', { class: 'editor-top' }, statsBox, h('div', { class: 'editor-strip-row' }, strip.el), legend),
    h('div', { class: 'toolbar' },
      h('div', { class: 'toolbar-row' }, searchInp, gotoInp, chips, countLbl, selBox, moreMenu)),
    h('div', { class: 'grid' },
      h('div', { class: 'grid-head', 'aria-hidden': 'true' }, h('div', null, '№'), h('div', null, 'ID'), h('div', null, 'Оригінал'), h('div', null, 'Переклад'), h('div', null, '')),
      emptyNote, body),
    dock);
  clear(root).append(editorEl);

  // ── Завантаження сторінок ──
  async function loadPage(p) {
    if (st.cache.has(p)) return st.cache.get(p);
    if (st.inflight.has(p)) return st.inflight.get(p);
    const gen = st.gen;
    const qs = new URLSearchParams({ offset: p * PAGE, limit: PAGE, filter: st.filter, q: st.q });
    const pr = get(`/api/files/${fileId}/rows?${qs}`).then((r) => {
      st.inflight.delete(p);
      if (gen !== st.gen) return null;
      st.cache.set(p, r.rows);
      st.total = r.total;
      renderRows();
      return r.rows;
    }).catch((e) => { st.inflight.delete(p); if (!st.destroyed) toast(e.message, true); return null; });
    st.inflight.set(p, pr);
    return pr;
  }

  const rowAt = (i) => st.cache.get(Math.floor(i / PAGE))?.[i % PAGE] ?? null;

  async function ensureRow(i) {
    const rows = await loadPage(Math.floor(i / PAGE));
    return rows ? rows[i % PAGE] ?? null : rowAt(i);
  }

  function resetList() {
    st.gen++;
    st.cache.clear(); st.inflight.clear(); st.selection.clear(); st.anchor = -1; st.activeIndex = -1;
    body.scrollTop = 0;
    return loadPage(0).then(() => { updateCount(); renderRows(); });
  }

  function updateCount() {
    spacer.style.height = `${st.total * ROW_H}px`;
    emptyNote.classList.toggle('hidden', st.total !== 0);
    body.classList.toggle('hidden', st.total === 0);
    countLbl.textContent = st.filter === 'all' && !st.q ? `${fmt(st.total)} ${plural(st.total, 'рядок', 'рядки', 'рядків')}` : `знайдено ${fmt(st.total)} з ${fmt(file.rowCount)}`;
  }

  // ── Віртуальна таблиця ──
  let raf = 0;
  function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderRows(); }); }
  body.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender);
  const bodyRo = new ResizeObserver(() => scheduleRender());
  bodyRo.observe(body);
  const onMq = () => { ROW_H = mobileMq.matches ? 66 : 54; renderRows(); };
  mobileMq.addEventListener('change', onMq);

  function renderRows() {
    if (st.destroyed) return;
    updateCount();
    const first = Math.max(0, Math.floor(body.scrollTop / ROW_H) - 4);
    const last = Math.min(st.total - 1, Math.ceil((body.scrollTop + body.clientHeight) / ROW_H) + 4);
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last) / PAGE); p++) if (last >= 0) loadPage(p);
    const peerByRow = new Map(st.peers.filter((p) => p.rowId).map((p) => [p.rowId, p.username]));
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const r = rowAt(i);
      const el = h('div', { class: 'grid-row', role: 'row', style: `top:${i * ROW_H}px;height:${ROW_H}px`, dataset: { i } });
      if (!r) { el.classList.add('loading'); el.append(h('div', { class: 'c-n' }, ''), h('div', { class: 'c-id' }, ''), h('div', null, '…'), h('div', { class: 'c-tr' }, '…'), h('div', null)); frag.append(el); continue; }
      el.classList.add(`st-${r.status}`);
      if (st.selection.has(r.id)) el.classList.add('sel');
      if (st.active && st.active.id === r.id) el.classList.add('active');
      el.append(
        h('div', { class: 'c-n num' }, r.pos + 1),
        h('div', { class: 'c-id', title: r.key }, r.key),
        h('div', { class: 'c-src', title: r.source }, tokens(r.source)),
        h('div', { class: 'c-tr', title: r.translation }, r.translation ? tokens(r.translation) : ''),
        h('div', { class: 'c-st', title: STATUS_NAME[r.status] + (r.by ? ` · ${r.by}` : '') }, glyph(r.status)));
      const peer = peerByRow.get(r.id);
      if (peer) el.append(h('span', { class: 'peer-tag' }, peer));
      frag.append(el);
    }
    spacer.replaceChildren(frag);
    renderSelection();
  }

  function renderSelection() {
    clear(selBox);
    const n = st.selection.size;
    selBox.classList.toggle('hidden', n === 0 || !perms.canEdit);
    if (n === 0 || !perms.canEdit) return;
    selBox.append(h('span', { class: 'count' }, `Виділено: ${n}`),
      h('button', { class: 'btn small review', onclick: () => bulkSelected(1) }, 'На вичитку'),
      perms.canApprove && h('button', { class: 'btn small done', onclick: () => bulkSelected(2) }, 'Затвердити'),
      h('button', { class: 'btn small', onclick: () => bulkSelected(0) }, 'Скинути'),
      h('button', { class: 'btn small ghost', onclick: () => { st.selection.clear(); renderRows(); } }, 'Зняти виділення'));
  }

  body.addEventListener('click', async (e) => {
    const el = e.target.closest('.grid-row');
    if (!el) return;
    const i = Number(el.dataset.i);
    const r = rowAt(i);
    if (!r) return;
    if (e.shiftKey && st.anchor >= 0) {
      const [a, b] = [Math.min(st.anchor, i), Math.max(st.anchor, i)];
      for (let k = a; k <= b; k++) { const rr = rowAt(k); if (rr) st.selection.add(rr.id); }
      renderRows();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (st.selection.has(r.id)) st.selection.delete(r.id); else st.selection.add(r.id);
      st.anchor = i; renderRows();
      return;
    }
    st.anchor = i;
    if (st.selection.size) st.selection.clear();
    await go(i);
  });
  body.addEventListener('dblclick', () => area.focus());

  // ── Активний рядок ──
  const isDirty = () => !!st.active && perms.canEdit && area.value !== st.active.translation;

  function showActive() {
    const r = st.active;
    st.conflict = null; conflictBox.classList.add('hidden');
    editorEl.classList.toggle('has-active', !!r);
    if (!r) { srcBox.textContent = ''; area.value = ''; idLbl.textContent = ''; posLbl.textContent = ''; statusLbl.textContent = ''; warnBox.replaceChildren(); return; }
    srcBox.replaceChildren(...tokens(r.source));
    area.value = r.translation;
    idLbl.textContent = r.key;
    posLbl.textContent = `№ ${fmt(r.pos + 1)} з ${fmt(file.rowCount)}`;
    updateStatusLabel();
    updateWarnings();
    strip.setCursor(r.pos);
  }

  function updateStatusLabel() {
    const r = st.active;
    if (!r) return;
    const next = predictedStatus(r);
    statusLbl.textContent = next !== r.status
      ? `${STATUS_NAME[r.status]} → ${STATUS_NAME[next]} (після збереження)`
      : `${STATUS_NAME[r.status]}${r.by ? ` · ${r.by}` : ''}`;
  }

  /** Той самий порядок, що й на сервері: переклад → «На вичитку», порожній/збігається з оригіналом → «Без статусу». */
  function predictedStatus(r) {
    if (!perms.canEdit || area.value === r.translation) return r.status;
    if (area.value === '' || area.value === r.source) return 0;
    if (r.status === 0) return 1;
    if (r.status === 2 && !perms.canApprove) return 1;
    return r.status;
  }

  function updateWarnings() {
    warnBox.replaceChildren();
    const r = st.active;
    if (!r || !area.value) return;
    const { missing, extra } = tokenDiff(r.source, area.value);
    for (const m of missing) warnBox.append(h('span', { class: 'w' }, `Бракує ${m}`));
    for (const x of extra) warnBox.append(h('span', { class: 'w' }, `Зайве ${x}`));
  }

  let autoTimer = null;
  function onInput() {
    updateWarnings(); updateStatusLabel();
    // Автозбереження після паузи в наборі: статус «На вичитку» виставляється одразу, а не лише при переході на інший рядок.
    clearTimeout(autoTimer);
    if (perms.canEdit && !st.conflict) autoTimer = setTimeout(() => { if (isDirty() && !st.saving && !st.destroyed) saveActive({}); }, 1200);
  }
  area.addEventListener('input', onInput);

  async function closeSheet() {
    if (isDirty()) { const ok = await saveActive({}); if (!ok) return; }
    st.active = null; st.activeIndex = -1;
    showActive(); renderRows(); strip.setCursor(null);
  }

  function revealActive() {
    if (st.activeIndex < 0) return;
    const top = st.activeIndex * ROW_H;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + ROW_H > body.scrollTop + body.clientHeight) body.scrollTop = top + ROW_H - body.clientHeight;
    renderRows();
  }

  async function setActive(r, i) {
    st.active = r; st.activeIndex = i;
    showActive();
    renderRows();
    requestAnimationFrame(revealActive);
    pollSoon();
  }

  async function go(i) {
    if (st.total === 0) return;
    i = Math.min(st.total - 1, Math.max(0, i));
    if (isDirty()) { const ok = await saveActive({}); if (!ok) return; }
    const r = await ensureRow(i);
    if (!r) return;
    await setActive(r, i);
    const top = i * ROW_H;
    if (top < body.scrollTop) body.scrollTop = top - ROW_H;
    else if (top + ROW_H > body.scrollTop + body.clientHeight) body.scrollTop = top - body.clientHeight + ROW_H * 2;
  }

  async function jumpToPos(pos) {
    const qs = new URLSearchParams({ pos, filter: st.filter, q: st.q });
    try {
      const { offset } = await get(`/api/files/${fileId}/offset?${qs}`);
      if (st.total === 0) return;
      const idx = Math.min(offset, st.total - 1);
      body.scrollTop = Math.max(0, idx * ROW_H - ROW_H * 3);
      await go(idx);
    } catch (e) { toast(e.message, true); }
  }

  function revert() { if (st.active) { area.value = st.active.translation; updateWarnings(); area.focus(); } }

  function patchCache(row) {
    for (const rows of st.cache.values()) {
      const k = rows.findIndex((x) => x.id === row.id);
      if (k >= 0) rows[k] = row;
    }
    if (st.active && st.active.id === row.id) st.active = row;
  }

  /** Зберігає активний рядок. opts.status — явний статус; opts.advance — перейти до наступного. Повертає true, якщо все гаразд. */
  async function saveActive(opts = {}) {
    const r = st.active;
    if (!r || !perms.canEdit) { if (opts.advance) await go(st.activeIndex + 1); return true; }
    if (st.saving) return false;
    const body_ = { ver: r.ver };
    const changedText = area.value !== r.translation;
    if (changedText) body_.translation = area.value;
    if (opts.status !== undefined && opts.status !== r.status) body_.status = opts.status;
    if (!changedText && body_.status === undefined) {
      if (opts.advance) await go(st.activeIndex + 1);
      return true;
    }
    st.saving = true;
    try {
      const res = await patch(`/api/files/${fileId}/rows/${r.id}`, body_);
      patchCache(res.row);
      st.conflict = null; conflictBox.classList.add('hidden');
      if (opts.advance) { st.saving = false; showActive(); await go(st.activeIndex + 1); } else { showActive(); renderRows(); }
      pollSoon();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.row) { showConflict(e.data.row); return false; }
      toast(e.message, true);
      return false;
    } finally { st.saving = false; }
  }

  function showConflict(serverRow) {
    st.conflict = serverRow;
    patchCache(serverRow);
    const mine = area.value;
    clear(conflictBox).append(h('div', { class: 'notice warn' },
      h('strong', null, `Цей рядок щойно змінив ${serverRow.by ?? 'інший користувач'}. `),
      'Ваш текст ще не збережено. ',
      h('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
        h('button', { class: 'btn small', onclick: () => { st.active = serverRow; st.conflict = null; showActive(); area.value = mine; updateWarnings(); renderRows(); } }, 'Залишити мій текст'),
        h('button', { class: 'btn small', onclick: () => { st.active = serverRow; showActive(); renderRows(); } }, 'Взяти їхній текст'))));
    conflictBox.classList.remove('hidden');
    renderRows();
  }

  // ── Масові зміни ──
  async function bulkSelected(status) {
    try {
      const r = await post(`/api/files/${fileId}/status`, { rowIds: [...st.selection], status });
      toast(`Змінено: ${fmt(r.changed)}`);
      st.selection.clear();
      st.cache.clear(); st.gen++;
      await loadPage(0); renderRows(); await ensureVisible();
      pollSoon();
    } catch (e) { toast(e.message, true); }
  }
  async function ensureVisible() { await refreshActive(); }

  async function bulkAll() {
    if (st.total === 0) return;
    const status = await chooseStatus(st.total);
    if (status === null) return;
    if (status === 2 && !perms.canApprove) { toast('Затверджувати може лише рецензент.', true); return; }
    try {
      const r = await post(`/api/files/${fileId}/status`, { all: true, filter: st.filter, q: st.q, status });
      toast(`Змінено: ${fmt(r.changed)}`);
      st.cache.clear(); st.gen++;
      await loadPage(0); renderRows(); await refreshActive();
      pollSoon();
    } catch (e) { toast(e.message, true); }
  }

  async function refreshActive() {
    if (!st.active) return;
    // перечитуємо активний рядок з сервера, якщо його статус міг змінитися масово
    try {
      const qs = new URLSearchParams({ offset: st.active.pos, limit: 1, filter: 'all', q: '' });
      const r = await get(`/api/files/${fileId}/rows?${qs}`);
      if (r.rows[0] && r.rows[0].id === st.active.id && !isDirty()) { st.active = r.rows[0]; showActive(); renderRows(); }
    } catch { /* ignore */ }
  }

  // ── Опитування змін ──
  let pollingNow = false;
  const pollSoon = debounce(() => poll(true), 150);

  function renderStats() {
    const s = st.stats;
    const untr = s.totalRows - s.translatedRows, rev = s.translatedRows - s.approvedRows;
    chipEls.get('untranslated')?.querySelector('.n').replaceChildren(fmt(untr));
    chipEls.get('review')?.querySelector('.n').replaceChildren(fmt(rev));
    chipEls.get('approved')?.querySelector('.n').replaceChildren(fmt(s.approvedRows));
    chipEls.get('notapproved')?.querySelector('.n').replaceChildren(fmt(untr + rev));
    clear(statsBox).append(
      h('div', { class: 'stat-main' }, h('span', { class: 'big-pct num' }, pct(s.translatedRows, s.totalRows), h('small', null, '%')),
        h('span', { class: 'stat-sub' }, `перекладено ${fmt(s.translatedRows)} з ${fmt(s.totalRows)} ${plural(s.totalRows, 'рядка', 'рядків', 'рядків')}`)),
      h('div', { class: 'stat-extra' },
        h('span', null, h('i', { class: 'k-done' }), h('b', null, fmt(s.approvedRows)), ' затверджено · ', fmt(s.approvedWords), ' слів'),
        h('span', null, h('i', { class: 'k-review' }), h('b', null, fmt(rev)), ' на вичитці'),
        h('span', { class: 'dim' }, `слів: ${fmt(s.translatedWords)} з ${fmt(s.totalWords)}`)),
      h('span', { class: 'peers' }, st.peers.length === 0 ? h('span', { class: 'dim' }, 'Окрім вас, у файлі нікого немає')
        : st.peers.map((p) => h('span', { class: 'peer', title: p.rowPos != null ? `${p.username} · рядок ${p.rowPos + 1}` : p.username }, avatar(p.username, { size: 24, title: '' }), h('span', { class: 'peer-name' }, p.username)))));
  }

  async function poll(force = false) {
    if (st.destroyed || (pollingNow && !force)) return;
    pollingNow = true;
    try {
      const qs = new URLSearchParams({ since: st.rev, strip: 200 });
      if (st.active) qs.set('row', st.active.id);
      const r = await get(`/api/files/${fileId}/changes?${qs}`);
      if (st.destroyed) return;
      st.stats = r.stats; st.peers = r.online;
      if (r.rowCount != null) file.rowCount = r.rowCount;
      strip.set(r.strip, file.rowCount, r.online.map((o) => ({ username: o.username, rowPos: o.rowPos })));
      strip.setCursor(st.active?.pos ?? null);
      if (r.reset) { st.rev = r.rev; await resetList(); }
      else if (r.changes.length) {
        let activeChanged = null;
        for (const row of r.changes) {
          patchCache(row);
          if (st.active && row.id === st.active.id) activeChanged = row;
        }
        st.rev = r.rev;
        if (activeChanged) {
          if (isDirty() && area.value !== activeChanged.translation && activeChanged.by !== null && activeChanged.ver !== st.active.ver) {
            // чужа правка того самого рядка, поки текст не збережено — не перезаписуємо мовчки
            if (!st.conflict) showConflict(activeChanged);
          } else { st.active = activeChanged; if (!isDirty()) showActive(); }
        }
      } else st.rev = Math.max(st.rev, r.rev);
      renderStats(); renderRows();
    } catch (e) {
      if (e.status === 404 || e.status === 401) return;
    } finally { pollingNow = false; }
  }

  function schedulePoll() {
    if (st.destroyed) return;
    st.pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, document.hidden ? 15000 : 3000);
  }

  // ── Керування ──
  searchInp.addEventListener('input', debounce(() => { st.q = searchInp.value.trim(); resetList(); }, 300));
  gotoInp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = Number(gotoInp.value);
    if (n >= 1 && n <= file.rowCount) jumpToPos(n - 1);
  });

  function onKey(e) {
    const inArea = e.target === area;
    const typing = inArea || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
    if (inArea && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey && perms.canApprove) saveActive({ status: 2, advance: true }); else saveActive({ advance: true });
      return;
    }
    if (inArea && e.key === 'Escape') { revert(); body.focus(); return; }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); go(st.activeIndex + (e.key === 'ArrowDown' ? 1 : -1)); return; }
    if (typing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(st.activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(Math.max(0, st.activeIndex - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); go(st.activeIndex + 10); }
    else if (e.key === 'PageUp') { e.preventDefault(); go(st.activeIndex - 10); }
    else if (e.key === 'Enter') { e.preventDefault(); if (st.active) area.focus(); else go(0); }
    else if (e.key === '/') { e.preventDefault(); searchInp.focus(); }
  }
  document.addEventListener('keydown', onKey);

  const beforeUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // ── Старт ──
  renderStats();
  await resetList();
  await poll(true);
  schedulePoll();
  if (st.total > 0 && !mobileMq.matches) { // на телефоні панель редагування відкривається лише дотиком до рядка
    const first = await ensureRow(0);
    if (first) await setActive(first, 0);
  }

  return {
    destroy() {
      clearTimeout(autoTimer);
      mobileMq.removeEventListener('change', onMq);
      bodyRo.disconnect();
      // не губимо незбережений текст при виході з редактора
      if (isDirty() && st.active) {
        fetch(`/api/files/${fileId}/rows/${st.active.id}`, {
          method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-UELT': '1' },
          body: JSON.stringify({ ver: st.active.ver, translation: area.value }),
        }).catch(() => {});
      }
      st.destroyed = true;
      clearTimeout(st.pollTimer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('resize', scheduleRender);
      strip.destroy();
      fetch(`/api/files/${fileId}/leave`, { method: 'POST', keepalive: true, headers: { 'X-UELT': '1' } }).catch(() => {});
    },
  };
}
