import { h, fmt, toast, debounce } from './util.js';
import { api } from './api.js';

/** Діалог «Знайти й замінити» для перекладів файлу: попередній перегляд змін, потім застосування. */
export function openFindReplace({ fileId, fileName, canApprove, getScope, onDone }) {
  const dlg = h('dialog', { class: 'fr-dialog', style: 'width:min(760px,96vw);max-height:92vh;overflow:auto' });
  const find = h('input', { type: 'text', placeholder: 'Що знайти в перекладах', 'aria-label': 'Що знайти', autocomplete: 'off', spellcheck: false });
  const repl = h('input', { type: 'text', placeholder: 'Чим замінити (можна залишити порожнім)', 'aria-label': 'Чим замінити', autocomplete: 'off', spellcheck: false });
  const matchCase = h('input', { type: 'checkbox' });
  const wholeWord = h('input', { type: 'checkbox' });
  const incApproved = h('input', { type: 'checkbox' });
  const scope = getScope();
  const scopeSel = h('select', { 'aria-label': 'Де замінювати' },
    h('option', { value: 'all' }, 'Увесь файл'),
    h('option', { value: 'filter' }, scope.active ? `Поточний список (${scope.label})` : 'Поточний список (без фільтра — як увесь файл)'));
  const out = h('div', { class: 'fr-out', 'aria-live': 'polite' });
  const msg = h('p', { class: 'error-text', role: 'alert' });
  const apply = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Замінити');
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Закрити');
  let last = null, seq = 0;

  const payload = (applyNow) => ({
    find: find.value, replace: repl.value, matchCase: matchCase.checked, wholeWord: wholeWord.checked,
    includeApproved: incApproved.checked, scope: scopeSel.value, filter: scope.filter, q: scope.q, apply: applyNow,
  });

  const show = (text, cls = 'dim') => { out.replaceChildren(h('p', { class: cls }, text)); };

  async function preview() {
    const my = ++seq;
    msg.textContent = ''; apply.disabled = true; last = null;
    if (!find.value) { show('Введіть текст для пошуку — тут з’явиться перегляд змін.'); return; }
    try {
      const r = await api('POST', `/api/files/${fileId}/replace`, payload(false));
      if (my !== seq) return;
      last = r;
      const notes = [];
      if (r.skippedApproved) notes.push(`пропущено затверджених рядків: ${fmt(r.skippedApproved)}`);
      if (r.tooLong) notes.push(`пропущено через завелику довжину: ${fmt(r.tooLong)}`);
      out.replaceChildren(...[
        h('p', { class: r.rows ? '' : 'dim' }, r.rows
          ? `Буде змінено рядків: ${fmt(r.rows)}, збігів: ${fmt(r.occurrences)}.`
          : 'Збігів не знайдено.'),
        notes.length > 0 && h('p', { class: 'dim' }, notes.join(' · ')),
        r.samples.length > 0 && h('div', { class: 'fr-samples' }, r.samples.map((s) => h('div', { class: 'fr-sample' },
          h('div', { class: 'dim fr-key', title: s.key }, s.key),
          h('div', { class: 'fr-before' }, s.before),
          h('div', { class: 'fr-after' }, s.after)))),
        r.rows > r.samples.length && h('p', { class: 'dim' }, `Показано перші ${r.samples.length} із ${fmt(r.rows)}.`),
      ].filter(Boolean));
      apply.disabled = !r.rows;
    } catch (e) { if (my === seq) { out.replaceChildren(); msg.textContent = e.message; } }
  }
  const debounced = debounce(preview, 350);
  for (const el of [find, repl]) el.addEventListener('input', debounced);
  for (const el of [matchCase, wholeWord, incApproved, scopeSel]) el.addEventListener('change', preview);

  apply.addEventListener('click', async () => {
    if (!last?.rows) return;
    if (!confirm(`Замінити «${find.value}» на «${repl.value}» у ${fmt(last.rows)} рядках (${fmt(last.occurrences)} збігів)? Зміни потраплять у журнал правок, статус рядків стане «На вичитку».`)) return;
    apply.disabled = true; msg.textContent = '';
    try {
      const r = await api('POST', `/api/files/${fileId}/replace`, payload(true));
      dlg.close('ok');
      toast(`Замінено в рядках: ${fmt(r.changed)}`);
      onDone?.();
    } catch (e) { msg.textContent = e.message; apply.disabled = false; }
  });

  const check = (box, text, title) => h('label', { class: 'check', title: title ?? null }, box, ` ${text}`);
  dlg.append(
    h('h3', null, 'Знайти й замінити'),
    h('p', { class: 'muted', style: 'margin:4px 0 14px' }, `Файл «${fileName}». Заміна діє лише на переклад, оригінал не змінюється. Службові маркери (<lf>, <tb>…) шукаються як звичайний текст.`),
    h('label', { class: 'fr-field' }, h('span', { class: 'dim' }, 'Знайти'), find),
    h('label', { class: 'fr-field' }, h('span', { class: 'dim' }, 'Замінити на'), repl),
    h('div', { class: 'fr-opts' },
      check(matchCase, 'Враховувати регістр'), check(wholeWord, 'Лише цілі слова'),
      canApprove && check(incApproved, 'Змінювати й затверджені', 'Змінені затверджені рядки стануть «На вичитку»')),
    h('label', { class: 'fr-field' }, h('span', { class: 'dim' }, 'Де'), scopeSel),
    out, msg,
    h('div', { class: 'row', style: 'margin-top:14px' }, cancel, apply));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  show('Введіть текст для пошуку — тут з’явиться перегляд змін.');
  find.focus();
}
