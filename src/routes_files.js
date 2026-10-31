import path from 'node:path';
import { HttpError, RawResponse, readJson, readBody, contentDisposition } from './http.js';
import { updateLocres, importTranslations } from './importer.js';
import { requireUser, fileAccess, requireFileCan } from './perm.js';
import { tx } from './db.js';
import { parseCsvTranslations, delimiterName, normalizeDelimiter, MAX_CSV_BYTES } from './csv_import.js';
import { buildCsv, buildTxt, buildJson, buildLocresExport, EXPORT_SCOPES } from './exporter.js';
import { parseTranslationsFile, normalizeTxtSeparator, txtSeparatorName } from './formats.js';

const MAX_TRANSLATION = 50_000;
const FILTERS = new Set(['all', 'untranslated', 'review', 'approved', 'notapproved', 'mine', 'changed']);

function toApiRow(r) {
  return {
    id: r.id, pos: r.pos, key: r.row_key, source: r.source, translation: r.translation,
    status: r.status, ver: r.ver, by: r.by ?? null, at: r.updated_at ?? null,
  };
}

/** WHERE-умова для фільтра/пошуку. Пошук по lower-case колонках, бо SQLite LIKE не вміє кирилицю без регістру. */
function filterClause(query, user) {
  const filter = FILTERS.has(query.get('filter')) ? query.get('filter') : 'all';
  const params = [];
  let where = '';
  switch (filter) {
    case 'untranslated': where += ' AND r.status = 0'; break;
    case 'review': where += ' AND r.status = 1'; break;
    case 'approved': where += ' AND r.status = 2'; break;
    case 'notapproved': where += ' AND r.status < 2'; break;
    case 'changed': where += " AND r.translation != ''"; break;
    case 'mine': where += ' AND r.updated_by = ?'; params.push(user.id); break;
    default: break;
  }
  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (q) {
    where += ' AND (instr(r.src_lc, ?) > 0 OR instr(r.tr_lc, ?) > 0 OR instr(r.key_lc, ?) > 0)';
    params.push(q, q, q);
  }
  return { where, params };
}

export function registerFileRoutes(router, app) {
  const { db, presence, stats, strips } = app;

  function nextState(row, input, canApprove) {
    let tr = row.translation;
    let st = row.status;
    if (input.translation !== undefined && input.translation !== tr) {
      tr = input.translation;
      if (tr === '' || tr === row.source) st = 0;
      else if (st === 0) st = 1;
      else if (st === 2 && !canApprove) st = 1; // змінений переклад більше не затверджений
    }
    if (input.status !== undefined) st = input.status;
    return { tr, st };
  }

  function checkStatusInput(row, status, canApprove) {
    if (![0, 1, 2].includes(status)) throw new HttpError(400, 'Некоректний статус.');
    if (status === 2 && !canApprove) throw new HttpError(403, 'Затверджувати рядки може лише рецензент.');
    if (row && row.status === 2 && status !== 2 && !canApprove) throw new HttpError(403, 'Статус затвердженого рядка може змінити лише рецензент.');
  }

  /** Застосовує зміну до рядка (всередині транзакції). Повертає true, якщо щось змінилося. */
  function applyChange(file, row, input, user, canApprove, rev) {
    const { tr, st } = nextState(row, input, canApprove);
    if (tr === row.translation && st === row.status) return false;
    const now = Date.now();
    db.prepare(`UPDATE rows SET translation = ?, tr_lc = ?, status = ?, ver = ver + 1, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(tr, tr.toLowerCase(), st, rev, user.id, now, row.id);
    db.prepare('INSERT INTO edits(file_id, row_id, user_id, at, old_translation, new_translation, old_status, new_status) VALUES(?,?,?,?,?,?,?,?)')
      .run(file.id, row.id, user.id, now, row.translation, tr, row.status, st);
    return true;
  }

  const bumpRev = (fileId) => {
    db.prepare('UPDATE files SET rev = rev + 1 WHERE id = ?').run(fileId);
    return db.prepare('SELECT rev FROM files WHERE id = ?').get(fileId).rev;
  };

  const loadRow = (fileId, rowId) => db.prepare(`SELECT r.*, u.username AS by FROM rows r LEFT JOIN users u ON u.id = r.updated_by
                                                 WHERE r.id = ? AND r.file_id = ?`).get(rowId, fileId);

  function touchUser(user, fileId) {
    const now = Date.now();
    if (!app.lastSeenWrite) app.lastSeenWrite = new Map();
    if (now - (app.lastSeenWrite.get(user.id) ?? 0) > 30_000) {
      app.lastSeenWrite.set(user.id, now);
      db.prepare('UPDATE users SET last_seen_at = ?, last_file_id = ? WHERE id = ?').run(now, fileId, user.id);
    }
  }

  router.get('/api/files/:id', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    return {
      file: { format: a.file.format, cv2: JSON.parse(a.file.meta).cv2 ?? null, id: a.file.id, name: a.file.name, projectId: a.project.id, project: a.project.name, rowCount: a.file.row_count, rev: a.file.rev, version: a.file.version },
      perms: {
        canEdit: a.canEdit, canApprove: a.canApprove, canImport: a.canImport, archived: !!a.project.archived, role: a.role,
        canExport: a.can('file.export'), canUpdate: a.can('file.update'), canClear: a.can('file.clear'),
      },
      stats: stats.get(a.file.id, a.file.rev),
      online: presence.list(a.file.id).map((e) => ({ userId: e.userId, username: e.username, rowPos: e.rowPos })),
    };
  });

  router.get('/api/files/:id/strip', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    const buckets = Math.min(Math.max(Number(ctx.query.get('buckets')) || 200, 20), 400);
    return { rev: a.file.rev, rowCount: a.file.row_count, strip: strips.get(a.file, buckets) };
  });

  router.get('/api/files/:id/rows', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    const { where, params } = filterClause(ctx.query, user);
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const limit = Math.min(Math.max(1, Number(ctx.query.get('limit')) || 100), 500);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM rows r WHERE r.file_id = ?${where}`).get(a.file.id, ...params).n;
    const rows = db.prepare(`SELECT r.*, u.username AS by FROM rows r LEFT JOIN users u ON u.id = r.updated_by
                             WHERE r.file_id = ?${where} ORDER BY r.pos LIMIT ? OFFSET ?`).all(a.file.id, ...params, limit, offset);
    return { total, offset, rev: a.file.rev, rows: rows.map(toApiRow) };
  });

  /** Зсув у відфільтрованому списку для рядка з позицією pos (перехід до рядка №). */
  router.get('/api/files/:id/offset', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    const { where, params } = filterClause(ctx.query, user);
    const pos = Math.max(0, Number(ctx.query.get('pos')) || 0);
    const offset = db.prepare(`SELECT COUNT(*) AS n FROM rows r WHERE r.file_id = ? AND r.pos < ?${where}`).get(a.file.id, pos, ...params).n;
    return { offset };
  });

  router.patch('/api/files/:id/rows/:rowId', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canEdit) throw new HttpError(403, 'У вас немає доступу до редагування цього файлу.');
    const body = await readJson(ctx.req, 512 * 1024);

    const input = {};
    if (body.translation !== undefined) {
      if (typeof body.translation !== 'string') throw new HttpError(400, 'Переклад має бути рядком.');
      if (body.translation.length > MAX_TRANSLATION) throw new HttpError(400, 'Переклад задовгий.');
      input.translation = body.translation;
    }
    if (body.status !== undefined) input.status = Number(body.status);

    return tx(db, () => {
      const row = loadRow(a.file.id, Number(ctx.params.rowId));
      if (!row) throw new HttpError(404, 'Рядок не знайдено.');
      if (body.ver !== row.ver) {
        throw new HttpError(409, 'Рядок уже змінив інший користувач.', { row: toApiRow(row) });
      }
      if (input.status !== undefined) checkStatusInput(row, input.status, a.canApprove);
      const rev = db.prepare('SELECT rev FROM files WHERE id = ?').get(a.file.id).rev + 1;
      if (applyChange(a.file, row, input, user, a.canApprove, rev)) {
        bumpRev(a.file.id);
        touchUser(user, a.file.id);
      }
      return { row: toApiRow(loadRow(a.file.id, row.id)), rev: db.prepare('SELECT rev FROM files WHERE id = ?').get(a.file.id).rev };
    });
  });

  /** Масова зміна статусу: за списком rowIds або для всіх рядків поточного фільтра. */
  router.post('/api/files/:id/status', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canEdit) throw new HttpError(403, 'У вас немає доступу до редагування цього файлу.');
    const body = await readJson(ctx.req, 2 * 1024 * 1024);
    const status = Number(body.status);
    checkStatusInput(null, status, a.canApprove);

    let ids;
    if (Array.isArray(body.rowIds)) {
      if (body.rowIds.length > 5000) throw new HttpError(400, 'Забагато рядків за раз.');
      ids = body.rowIds.map(Number);
    } else if (body.all) {
      const q = new URLSearchParams();
      if (body.filter) q.set('filter', body.filter);
      if (body.q) q.set('q', body.q);
      const { where, params } = filterClause(q, user);
      ids = db.prepare(`SELECT r.id FROM rows r WHERE r.file_id = ?${where}`).all(a.file.id, ...params).map((r) => r.id);
    } else {
      throw new HttpError(400, 'Вкажіть rowIds або all.');
    }

    return tx(db, () => {
      const rev = db.prepare('SELECT rev FROM files WHERE id = ?').get(a.file.id).rev + 1;
      let changed = 0;
      const sel = db.prepare('SELECT * FROM rows WHERE id = ? AND file_id = ?');
      for (const id of ids) {
        const row = sel.get(id, a.file.id);
        if (!row) continue;
        if (row.status === 2 && status !== 2 && !a.canApprove) continue; // лише рецензент знімає затвердження
        if (applyChange(a.file, row, { status }, user, a.canApprove, rev)) changed++;
      }
      if (changed) { bumpRev(a.file.id); touchUser(user, a.file.id); }
      return { changed, rev: db.prepare('SELECT rev FROM files WHERE id = ?').get(a.file.id).rev };
    });
  });

  /**
   * Знайти й замінити в перекладах файлу. apply=false (за замовчуванням) — лише попередній перегляд.
   * Тіло: { find, replace, matchCase, wholeWord, scope: 'all'|'filter', filter, q, includeApproved, apply }.
   * Змінюються лише переклади (не оригінал). Затверджені рядки пропускаються, якщо includeApproved не ввімкнено
   * (і лише рецензент може їх змінити; вони стають «На вичитку»).
   */
  router.post('/api/files/:id/replace', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canEdit) throw new HttpError(403, 'У вас немає доступу до редагування цього файлу.');
    const body = await readJson(ctx.req, 64 * 1024);
    const find = typeof body.find === 'string' ? body.find : '';
    const replace = typeof body.replace === 'string' ? body.replace : '';
    if (!find) throw new HttpError(400, 'Вкажіть, що шукати.');
    if (find.length > 500 || replace.length > 5000) throw new HttpError(400, 'Текст пошуку або заміни задовгий.');
    const matchCase = body.matchCase === true;
    const wholeWord = body.wholeWord === true;
    const includeApproved = body.includeApproved === true;
    if (includeApproved && !a.canApprove) throw new HttpError(403, 'Змінювати затверджені рядки може лише рецензент.');

    const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, matchCase ? 'gu' : 'giu');

    let where = '';
    let params = [];
    if (body.scope === 'filter') ({ where, params } = filterClause(new URLSearchParams({ filter: body.filter || 'all', q: body.q || '' }), user));
    const needle = matchCase ? find : find.toLowerCase();
    const col = matchCase ? 'r.translation' : 'r.tr_lc';
    const candidates = db.prepare(`SELECT r.* FROM rows r WHERE r.file_id = ? AND r.translation != '' AND instr(${col}, ?) > 0${where} ORDER BY r.pos`)
      .all(a.file.id, needle, ...params);

    const plan = [];
    let occurrences = 0, skippedApproved = 0, tooLong = 0;
    for (const row of candidates) {
      let n = 0;
      const next = row.translation.replace(re, () => { n++; return replace; });
      if (!n || next === row.translation) continue;
      if (row.status === 2 && !includeApproved) { skippedApproved++; continue; }
      if (next.length > MAX_TRANSLATION) { tooLong++; continue; }
      occurrences += n;
      plan.push({ row, next });
    }
    const summary = { rows: plan.length, occurrences, skippedApproved, tooLong };

    if (body.apply !== true) {
      return { ...summary, applied: false, samples: plan.slice(0, 15).map(({ row, next }) => ({ rowId: row.id, key: row.row_key, before: row.translation, after: next })) };
    }

    const changed = tx(db, () => {
      if (!plan.length) return 0;
      const rev = bumpRev(a.file.id);
      let n = 0;
      for (const { row, next } of plan) {
        const fresh = db.prepare('SELECT * FROM rows WHERE id = ? AND file_id = ?').get(row.id, a.file.id);
        if (!fresh || fresh.translation !== row.translation || fresh.status !== row.status) continue; // змінився після перегляду
        const input = { translation: next };
        if (fresh.status === 2) input.status = next === '' || next === fresh.source ? 0 : 1;
        if (applyChange(a.file, fresh, input, user, a.canApprove, rev)) n++;
      }
      touchUser(user, a.file.id);
      return n;
    });
    if (changed) { stats.drop(a.file.id); strips.drop(a.file.id); }
    return { ...summary, applied: true, changed };
  });

  /** Опитування: зміни після ревізії since + хто зараз у файлі + статистика. Це ж і heartbeat присутності. */
  router.get('/api/files/:id/changes', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    const since = Number(ctx.query.get('since')) || 0;
    const rowId = Number(ctx.query.get('row')) || null;
    let rowPos = null;
    if (rowId) rowPos = db.prepare('SELECT pos FROM rows WHERE id = ? AND file_id = ?').get(rowId, a.file.id)?.pos ?? null;
    presence.touch(a.file.id, user, rowId, rowPos);
    touchUser(user, a.file.id);

    const rev = a.file.rev;
    let changes = [];
    let reset = since < a.file.struct_rev; // змінився набір рядків (оновлення оригіналу)
    if (!reset && rev > since) {
      const rows = db.prepare(`SELECT r.*, u.username AS by FROM rows r LEFT JOIN users u ON u.id = r.updated_by
                               WHERE r.file_id = ? AND r.rev > ? ORDER BY r.rev LIMIT 2001`).all(a.file.id, since);
      if (rows.length > 2000) reset = true; else changes = rows.map(toApiRow);
    }
    return {
      rev, reset, changes, rowCount: a.file.row_count,
      stats: stats.get(a.file.id, rev),
      strip: ctx.query.get('strip') ? strips.get(a.file, Math.min(Math.max(Number(ctx.query.get('strip')) || 200, 20), 400)) : undefined,
      online: presence.list(a.file.id).filter((e) => e.userId !== user.id)
        .map((e) => ({ userId: e.userId, username: e.username, rowId: e.rowId, rowPos: e.rowPos })),
    };
  });

  router.post('/api/files/:id/leave', (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    presence.leave(a.file.id, user.id);
    return { ok: true };
  });

  /**
   * Експорт файлу (лише адмін): ?format=locres|csv (за замовчуванням — формат джерела).
   * csv: scope (all|untranslated|review|approved|notapproved|changed), delimiter (semicolon|comma|tab), bom=0|1, safe=1.
   * locres із CSV-джерела: version=0|1|2.
   */
  router.get('/api/files/:id/export', (ctx) => {
    const user = requireUser(ctx);
    const a = requireFileCan(db, Number(ctx.params.id), user, 'file.export');
    const format = ctx.query.get('format') || a.file.format;
    if (!['locres', 'csv', 'txt', 'json'].includes(format)) throw new HttpError(400, 'Формат експорту: locres, csv, txt або json.');
    const origName = path.posix.basename(a.file.name);
    const base = origName.replace(/\.(locres|csv|txt|json)$/i, '');

    if (format !== 'locres') {
      const scope = ctx.query.get('scope') || 'all';
      if (!EXPORT_SCOPES.has(scope)) throw new HttpError(400, 'Невідомий набір рядків для експорту.');
      const { where, params } = filterClause(new URLSearchParams({ filter: scope }), user);
      const rows = db.prepare(`SELECT r.* FROM rows r WHERE r.file_id = ?${where} ORDER BY r.pos`).all(a.file.id, ...params);
      const bom = ctx.query.get('bom') !== '0';
      if (format === 'csv') {
        const delimiter = normalizeDelimiter(ctx.query.get('delimiter') || 'semicolon') ?? ';';
        const buf = buildCsv(rows, { delimiter, bom, safe: ctx.query.get('safe') === '1' });
        return new RawResponse(200, buf, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': contentDisposition(`${base}.csv`) });
      }
      if (format === 'txt') {
        const separator = normalizeTxtSeparator(ctx.query.get('delimiter')) ?? '=';
        const column = ctx.query.get('column') === 'source' ? 'source' : 'translation';
        const buf = buildTxt(rows, { separator, column, bom: ctx.query.get('bom') === '1' });
        return new RawResponse(200, buf, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': contentDisposition(`${base}.txt`) });
      }
      const shape = ctx.query.get('shape') === 'object' ? 'object' : 'records';
      return new RawResponse(200, buildJson(rows, { shape }), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': contentDisposition(`${base}.json`) });
    }

    const rows = db.prepare('SELECT * FROM rows WHERE file_id = ? ORDER BY pos').all(a.file.id);
    const buf = buildLocresExport(a.file, rows, ctx.query.get('version'));
    return new RawResponse(200, buf, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(a.file.format === 'locres' ? origName : `${base}.locres`),
    });
  });

  // CSV-імпорт перекладів у наявні рядки: спершу preview, потім підтвердження вибраних дій.
  // Клієнт шле файл як csvBase64 (сирі байти; сервер сам визначає кодування). Поле csv (готовий текст) лишається для сумісності.
  async function readCsvRequest(ctx) {
    const body = await readJson(ctx.req, 30 * 1024 * 1024);
    let input;
    if (typeof body.csvBase64 === 'string') input = Buffer.from(body.csvBase64, 'base64');
    else if (typeof body.csv === 'string') input = body.csv;
    else throw new HttpError(400, 'Передайте CSV як csvBase64 (байти) або csv (текст).');
    const delimiter = body.delimiter ?? ctx.query.get('delimiter') ?? 'auto';
    const unguard = body.safe === true || ctx.query.get('safe') === '1';
    const format = body.format ?? ctx.query.get('format') ?? 'csv';
    if (!['csv', 'txt', 'json'].includes(format)) throw new HttpError(400, 'Формат імпорту: csv, txt або json.');
    const parsed = format === 'csv' ? parseCsvTranslations(input, { delimiter, unguard }) : parseTranslationsFile(input, format, { delimiter });
    return { parsed, actions: body.actions ?? {} };
  }

  function csvPreview(fileId, parsed, canApprove = false) {
    const rows = db.prepare('SELECT id, row_key, source, translation, status FROM rows WHERE file_id = ?').all(fileId);
    const byKey = new Map(rows.map((r) => [r.row_key, r]));
    const items = parsed.entries.map((entry) => {
      const r = byKey.get(entry.key);
      if (!r) return { ...entry, state: 'unknown', currentTranslation: '', source: '', status: null, defaultAction: 'skip' };
      const same = entry.translation === '' || entry.translation === r.source || entry.translation === r.translation;
      const approvedBlocked = r.status === 2;
      return {
        ...entry, rowId: r.id, source: r.source, currentTranslation: r.translation, status: r.status,
        state: same ? 'same' : (approvedBlocked ? 'approved' : (r.translation ? 'existing' : 'empty')),
        defaultAction: same || approvedBlocked ? 'skip' : (r.translation ? 'skip' : 'fill'),
      };
    });
    return {
      format: parsed.format ?? 'csv',
      shape: parsed.shape ?? null,
      delimiter: parsed.delimiter == null ? null : (parsed.format === 'txt' ? txtSeparatorName(parsed.delimiter) : delimiterName(parsed.delimiter)),
      encoding: parsed.encoding,
      hasStatus: !!parsed.hasStatus,
      statusApplies: !!parsed.hasStatus && canApprove,
      total: items.length,
      matched: items.filter((x) => x.rowId).length,
      unknown: items.filter((x) => x.state === 'unknown').length,
      existing: items.filter((x) => x.state === 'existing').length,
      empty: items.filter((x) => x.state === 'empty').length,
      skipped: items.filter((x) => ['same', 'approved', 'unknown'].includes(x.state)).length,
      items,
    };
  }

  router.post('/api/files/:id/csv-preview', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canImport) throw new HttpError(403, 'У вас немає права імпортувати переклад у цей файл.');
    const { parsed } = await readCsvRequest(ctx);
    return csvPreview(a.file.id, parsed, a.canApprove);
  });

  router.post('/api/files/:id/csv-import', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canImport) throw new HttpError(403, 'У вас немає права імпортувати переклад у цей файл.');
    const { parsed, actions } = await readCsvRequest(ctx);
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw new HttpError(400, 'Некоректні дії імпорту.');
    const preview = csvPreview(a.file.id, parsed, a.canApprove);
    const allowed = new Set(['skip', 'replace', 'fill']);
    for (const item of preview.items) {
      const action = actions[item.key] ?? item.defaultAction;
      if (!allowed.has(action)) throw new HttpError(400, `Некоректна дія для ключа «${item.key}».`);
      if (action !== 'skip' && !item.rowId) throw new HttpError(400, `Ключ «${item.key}» відсутній у файлі.`);
      if (action === 'fill' && item.currentTranslation !== '') throw new HttpError(409, `Рядок «${item.key}» уже має переклад; оновіть попередній перегляд.`);
      if (action === 'replace' && item.currentTranslation === '') throw new HttpError(400, `Рядок «${item.key}» порожній — виберіть «Заповнити порожній».`);
      if (item.status === 2 && action !== 'skip' && !a.canApprove) throw new HttpError(403, `Затверджений рядок «${item.key}» може змінити лише рецензент.`);
    }
    const changed = tx(db, () => {
      const todo = [];
      for (const item of preview.items) {
        const action = actions[item.key] ?? item.defaultAction;
        if (action === 'skip') continue;
        const row = db.prepare('SELECT * FROM rows WHERE id = ? AND file_id = ?').get(item.rowId, a.file.id);
        if (!row) throw new HttpError(409, 'Рядки файлу змінилися. Повторіть попередній перегляд.');
        if (row.translation !== item.currentTranslation || row.status !== item.status) throw new HttpError(409, `Рядок «${item.key}» змінився після попереднього перегляду. Повторіть імпорт.`);
        if (action === 'fill' && row.translation !== '') throw new HttpError(409, `Рядок «${item.key}» уже має переклад; повторіть попередній перегляд.`);
        if (row.status === 2 && !a.canApprove) throw new HttpError(403, `Затверджений рядок «${item.key}» може змінити лише рецензент.`);
        const value = item.translation;
        if (value === '' || value === row.source || value === row.translation) continue;
        todo.push({ row, value, csvStatus: item.csvStatus });
      }
      if (!todo.length) return 0;
      const rev = bumpRev(a.file.id);
      const now = Date.now();
      const upd = db.prepare("UPDATE rows SET translation = ?, tr_lc = ?, status = ?, ver = ver + 1, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?");
      const log = db.prepare("INSERT INTO edits(file_id, row_id, user_id, at, old_translation, new_translation, old_status, new_status) VALUES(?,?,?,?,?,?,?,?)");
      for (const { row, value, csvStatus } of todo) {
        // статус із колонки status береться лише з правом затверджувати; інакше — «На вичитку»
        const status = value === '' || value === row.source ? 0 : (a.canApprove && (csvStatus === 1 || csvStatus === 2) ? csvStatus : 1);
        upd.run(value, value.toLowerCase(), status, rev, user.id, now, row.id);
        log.run(a.file.id, row.id, user.id, now, row.translation, value, row.status, status);
      }
      touchUser(user, a.file.id);
      return todo.length;
    });
    if (changed) { stats.drop(a.file.id); strips.drop(a.file.id); }
    return { applied: changed };
  });

  // Імпорт готового перекладу з locres (адмін або користувач із правом редагування файлу).
  router.post('/api/files/:id/translations', async (ctx) => {
    const user = requireUser(ctx);
    const a = fileAccess(db, Number(ctx.params.id), user);
    if (!a.canImport) throw new HttpError(403, 'У вас немає права імпортувати переклад у цей файл.');
    const buffer = await readBody(ctx.req, 256 * 1024 * 1024);
    const apply = ctx.query.get('apply') === '1';
    const rep = importTranslations(db, {
      file: a.file, buffer, user, canApprove: a.canApprove, apply,
      overwrite: ctx.query.get('overwrite') === '1', approve: ctx.query.get('approve') === '1',
    });
    if (apply) { stats.drop(a.file.id); strips.drop(a.file.id); }
    return { ...rep, done: apply };
  });

  // Оновлення оригіналу (адмін): ?apply=1 застосувати, інакше лише звіт.
  router.post('/api/files/:id/update', async (ctx) => {
    const user = requireUser(ctx);
    const a = requireFileCan(db, Number(ctx.params.id), user, 'file.update');
    const buffer = await readBody(ctx.req, a.file.format !== 'locres' ? MAX_CSV_BYTES : 256 * 1024 * 1024);
    const report = updateLocres(db, { file: a.file, buffer, userId: user.id, apply: ctx.query.get('apply') === '1', delimiter: ctx.query.get('delimiter') ?? 'auto', unguard: ctx.query.get('safe') === '1' });
    if (ctx.query.get('apply') === '1') { stats.drop(a.file.id); strips.drop(a.file.id); }
    return { ...report, applied: ctx.query.get('apply') === '1' };
  });

  // Очищення всього стовпця перекладу у файлі (лише адмін). Кожна зміна пишеться в журнал правок.
  router.post('/api/files/:id/clear-translations', (ctx) => {
    const user = requireUser(ctx);
    const a = requireFileCan(db, Number(ctx.params.id), user, 'file.clear');
    const cleared = tx(db, () => {
      const rows = db.prepare("SELECT id, translation, status FROM rows WHERE file_id = ? AND (translation != '' OR status != 0)").all(a.file.id);
      if (rows.length === 0) return 0;
      const rev = bumpRev(a.file.id);
      const now = Date.now();
      const upd = db.prepare("UPDATE rows SET translation = '', tr_lc = '', status = 0, ver = ver + 1, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?");
      const log = db.prepare("INSERT INTO edits(file_id, row_id, user_id, at, old_translation, new_translation, old_status, new_status) VALUES(?,?,?,?,?,'',?,0)");
      for (const r of rows) { upd.run(rev, user.id, now, r.id); log.run(a.file.id, r.id, user.id, now, r.translation, r.status); }
      return rows.length;
    });
    stats.drop(a.file.id); strips.drop(a.file.id);
    return { cleared };
  });

  router.delete('/api/files/:id', (ctx) => {
    const user = requireUser(ctx);
    const a = requireFileCan(db, Number(ctx.params.id), user, 'file.delete');
    stats.drop(a.file.id); strips.drop(a.file.id);
    db.prepare('DELETE FROM files WHERE id = ?').run(a.file.id);
    return { ok: true };
  });
}
