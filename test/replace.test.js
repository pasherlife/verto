import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleLocres } from './helpers.js';

test('Знайти й замінити: перегляд, застосування, регістр, цілі слова, затверджені, права', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'own_rep', password: 'secret1' });
  const pid = (await owner.post('/api/projects', { name: 'Rep' })).data.id;
  const fid = (await owner.call('POST', `/api/projects/${pid}/files?name=r.locres`, sampleLocres().buffer)).data.id;
  const rows = (await owner.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  assert.ok(rows.length >= 2);

  const set = async (row, text, status) => {
    const cur = (await owner.get(`/api/files/${fid}/rows?limit=100`)).data.rows.find((r) => r.id === row.id);
    let r = await owner.patch(`/api/files/${fid}/rows/${row.id}`, { translation: text, ver: cur.ver });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (status) { r = await owner.patch(`/api/files/${fid}/rows/${row.id}`, { status, ver: r.data.row.ver }); assert.equal(r.status, 200); }
  };
  await set(rows[0], 'Меч і щит, мечі');
  await set(rows[1], 'МЕЧ дракона', 2);

  const rep = (extra) => owner.post(`/api/files/${fid}/replace`, { find: 'меч', replace: 'клинок', scope: 'all', ...extra });

  // перегляд нічого не змінює
  let r = await rep({});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.applied, false);
  assert.equal(r.data.rows, 1, 'затверджений рядок пропущено');
  assert.equal(r.data.skippedApproved, 1);
  assert.equal(r.data.occurrences, 2, 'без цілих слів збігається й у «мечі»');
  assert.equal((await owner.get(`/api/files/${fid}/rows?limit=100`)).data.rows.find((x) => x.id === rows[0].id).translation, 'Меч і щит, мечі');

  // регістр і цілі слова
  assert.equal((await rep({ matchCase: true })).data.occurrences, 1, 'з урахуванням регістру збігається лише «мечі»');
  assert.equal((await rep({ find: 'МЕЧІ', matchCase: true })).data.rows, 0);
  assert.equal((await rep({ wholeWord: true })).data.occurrences, 1);
  assert.equal((await rep({ find: '' })).status, 400);
  assert.equal((await rep({ find: 'a.b+(' , replace: 'x' })).data.rows, 0, 'спецсимволи шукаються буквально');

  // застосування; $ у заміні — буквальний
  r = await rep({ replace: 'клин$&ок', apply: true });
  assert.equal(r.data.changed, 1);
  const after = (await owner.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  assert.equal(after.find((x) => x.id === rows[0].id).translation, 'клин$&ок і щит, клин$&окі');
  assert.equal(after.find((x) => x.id === rows[1].id).translation, 'МЕЧ дракона');

  // затверджені: лише з includeApproved, і вони стають «На вичитку»
  r = await rep({ includeApproved: true, apply: true });
  assert.equal(r.data.changed, 1);
  const row1 = (await owner.get(`/api/files/${fid}/rows?limit=100`)).data.rows.find((x) => x.id === rows[1].id);
  assert.equal(row1.translation, 'клинок дракона');
  assert.equal(row1.status, 1);

  // журнал правок записав зміни
  const act = await owner.get(`/api/projects/${pid}/activity?q=${encodeURIComponent('клинок')}`);
  assert.ok(act.data.total >= 1);

  // права: спостерігач не може
  const obs = client(srv.base);
  await obs.post('/api/auth/register', { username: 'obs_rep', password: 'secret1' });
  await owner.post(`/api/projects/${pid}/members`, { username: 'obs_rep', role: 'observer' });
  assert.equal((await obs.post(`/api/files/${fid}/replace`, { find: 'а', replace: 'б' })).status, 403);
});
