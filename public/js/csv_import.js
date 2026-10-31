import { h, fmt, toast } from './util.js';
import { api } from './api.js';

const DELIMITERS = [
  ['auto', 'Авто'], ['comma', 'Кома (,)'], ['semicolon', 'Крапка з комою (;)'], ['tab', 'Табуляція'], ['pipe', 'Вертикальна риска (|)'],
];
const TXT_DELIMITERS = [['auto', 'Авто'], ['equals', 'Дорівнює (=)'], ['tab', 'Табуляція'], ['pipe', 'Вертикальна риска (|)'], ['semicolon', 'Крапка з комою (;)']];
const DELIMITER_LABEL = { comma: 'кома', semicolon: 'крапка з комою', tab: 'табуляція', pipe: 'вертикальна риска', equals: 'дорівнює (=)' };
const FORMAT_LABEL = { csv: 'CSV', txt: 'TXT', json: 'JSON' };

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** CSV-імпорт з уже вибраного файлу: байти йдуть на сервер, кодування й роздільник визначає сервер (роздільник можна змінити вручну). */
export async function importCsvFile(file, { fileId, fileName, canApprove, onDone, format = 'csv' }) {
  const csvBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
  await openPreview({ fileId, fileName, csvBase64, delimiter: 'auto', safe: false, canApprove, onDone, format });
}

/** Окремий вибір CSV (лишається для сумісності; основний вхід — pickAndImportTranslations). */
export function pickAndImportCsv(opts) {
  const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try { await importCsvFile(file, opts); } catch (e) { toast(e.message, true); }
  });
  input.click();
}

async function openPreview(ctx) {
  const preview = await api('POST', `/api/files/${ctx.fileId}/csv-preview`, { csvBase64: ctx.csvBase64, delimiter: ctx.delimiter, safe: ctx.safe, format: ctx.format ?? 'csv' });
  showPreview({ ...ctx, preview });
}

function showPreview({ fileId, fileName, csvBase64, delimiter, safe, preview, canApprove, onDone, format = 'csv' }) {
  const dlg = h('dialog', { class: 'import-dialog', style: 'width:min(1240px,96vw);max-height:92vh;overflow:auto' });
  const actions = new Map();
  const tableRows = preview.items.map((item) => {
    let choices = [{ value: 'skip', label: 'Пропустити' }];
    if (item.rowId && item.state !== 'same' && item.state !== 'unknown' && (item.status !== 2 || canApprove)) {
      if (!item.currentTranslation) choices.push({ value: 'fill', label: 'Заповнити' });
      else choices.push({ value: 'replace', label: 'Замінити' });
    }
    const select = h('select', { style: 'width:100%' }, choices.map((c) => h('option', { value: c.value }, c.label)));
    select.value = item.defaultAction;
    actions.set(item.key, select);
    return h('tr', null,
      h('td', { class: 'col-key' }, h('code', { title: item.key }, item.key), h('div', { class: 'dim' }, `${FORMAT_LABEL[format]}: ${item.csvRow}`)),
      h('td', null, h('div', { class: 'cell-text' }, item.translation || h('span', { class: 'dim' }, '—'))),
      h('td', null, h('div', { class: 'cell-text' }, item.currentTranslation || h('span', { class: 'dim' }, '—'))),
      h('td', { class: 'col-state' }, item.state === 'unknown' ? 'Ключ не знайдено' : item.state === 'same' ? 'Без змін' : item.state === 'approved' ? 'Затверджено' : item.state === 'existing' ? 'Є переклад' : 'Порожній'),
      h('td', { class: 'col-act' }, select));
  });
  const summary = h('p', { class: 'muted', style: 'margin:8px 0 16px' },
    `Файл «${fileName}». ${preview.delimiter ? `Роздільник: ${DELIMITER_LABEL[preview.delimiter] ?? preview.delimiter}; ` : ''}кодування: ${preview.encoding ?? 'utf-8'}. Рядків: ${fmt(preview.total)}; збігів за ключем: ${fmt(preview.matched)}; невідомих ключів: ${fmt(preview.unknown)}; уже перекладено: ${fmt(preview.existing)}.`);
  const safeBox = h('input', { type: 'checkbox', checked: !!safe });
  safeBox.addEventListener('change', async () => {
    try { await openPreview({ fileId, fileName, csvBase64, delimiter: delimSel.value, safe: safeBox.checked, canApprove, onDone, format }); dlg.close('redo'); }
    catch (e) { toast(e.message, true); safeBox.checked = !safeBox.checked; }
  });
  const delimSel = h('select', { title: 'Роздільник стовпців' }, (format === 'txt' ? TXT_DELIMITERS : DELIMITERS).map(([v, l]) => h('option', { value: v }, l)));
  delimSel.value = delimiter;
  delimSel.addEventListener('change', async () => {
    try { await openPreview({ fileId, fileName, csvBase64, delimiter: delimSel.value, safe: safeBox.checked, canApprove, onDone, format }); dlg.close('redo'); }
    catch (e) { toast(e.message, true); delimSel.value = delimiter; }
  });
  const msg = h('p', { class: 'error-text', role: 'alert' });
  const cancel = h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати');
  const apply = h('button', { class: 'btn primary', onclick: async () => {
    apply.disabled = true; msg.textContent = '';
    const selected = Object.fromEntries([...actions].map(([key, el]) => [key, el.value]));
    try {
      const result = await api('POST', `/api/files/${fileId}/csv-import`, { csvBase64, delimiter, safe: !!safe, format, actions: selected });
      dlg.close('ok');
      toast(`Імпортовано перекладів: ${fmt(result.applied)}`);
      onDone?.();
    } catch (e) { msg.textContent = e.message; apply.disabled = false; }
  } }, 'Застосувати вибрані дії');
  dlg.append(...[h('h3', null, `Попередній перегляд ${FORMAT_LABEL[format]}`),
    summary,
    format !== 'json' && h('label', { class: 'row', style: 'gap:8px;margin-bottom:8px' }, 'Роздільник:', delimSel),
    format === 'csv' && h('label', { class: 'check', style: 'display:block;margin-bottom:12px', title: 'Увімкніть, якщо файл скачано з опцією «Безпечний режим для Excel»: початковий апостроф перед = + - @ буде знято' }, safeBox, ' Файл у «безпечному режимі для Excel»'),
    h('div', { style: 'overflow:auto;max-height:55vh' },
      h('table', { class: 'plain import-table' },
        h('colgroup', null, h('col', { class: 'c-key' }), h('col'), h('col'), h('col', { class: 'c-state' }), h('col', { class: 'c-act' })),
        h('thead', null, h('tr', null, h('th', null, 'Ключ'), h('th', null, `З ${FORMAT_LABEL[format]}`), h('th', null, 'Поточний переклад'), h('th', null, 'Стан'), h('th', null, 'Дія'))),
        h('tbody', null, tableRows))),
    msg,
    h('div', { class: 'row', style: 'position:sticky;bottom:-24px;background:var(--raised);padding-top:12px' }, cancel, apply)].filter(Boolean));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
