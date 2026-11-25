// Merkez sahte API'sinin araç uçları araçtan bağımsız (`src/mocks/hub.ts`, KALANLAR 6.24): araç listesi ve kapılar kayıttan,
// yanıtlar örnek üreticiden, yoksa aracın gerçek yanıt kaydından (`e2e/fixtures/<anahtar>-real/`), yoksa boş sözleşme yanıtından.
// Yeni araç = kayıt girdisi + kayıt klasörü; kod değişmez. Kayıtlı sağlayıcıyı DeciShip'in gerçek kaydıyla sınar (yeni araç gibi).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emptyHubActivityPage, emptyHubAnalytics, emptyHubDatasetList, emptyHubOverview, PRODUCT_KEYS, PRODUCTS } from '@sellerondata/contracts';
import { emptyProvider, fillStamps, groupRecordings, hubPermissions, hubProvider, recordedProvider, usesRecordings } from '../src/mocks/hub.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../e2e/fixtures');
/** Vite glob'unun verdiği biçimde (yol → içerik) bir kayıt klasörü. */
function readDir(dir) {
  const out = {};
  for (const f of fs.readdirSync(path.join(FIXTURES, dir)).filter((x) => x.endsWith('.json'))) {
    out[`../../e2e/fixtures/${dir}/${f}`] = JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, f), 'utf8'));
  }
  return out;
}
const ctx = (locale = 'tr') => ({ locale, can: () => true, empty: false });
const q = { from: '2026-10-01', to: '2026-10-31', compare: false, filters: {} };
const params = { page: 1, pageSize: 4, q: '', filters: {} };

describe('Merkez sahte API: araç uçları kayıttan', () => {
  test('kayıt klasörleri: her `<ad>-real` ya bir araç anahtarı ya Hesap kaydı (yazım hatası klasörü sessizce boşa düşmesin)', () => {
    const dirs = fs.readdirSync(FIXTURES).filter((d) => d.endsWith('-real'));
    for (const d of dirs) assert.ok(d === 'account-real' || PRODUCT_KEYS.includes(d.slice(0, -5)), `bilinmeyen kayıt klasörü: ${d}`);
  });

  test('kapılar kayıttaki `hub` izinleri (DeciShip: Genel Bakış/Analiz/Etkinlik rapor, veri fatura, CSV dışa aktarma)', () => {
    assert.deepEqual(hubPermissions('deciship'), { view: 'deciship.reports.view', data: 'deciship.invoices.view', export: 'deciship.data.export' });
    for (const k of PRODUCT_KEYS) {
      const hub = PRODUCTS[k].hub;
      assert.deepEqual(hubPermissions(k), hub ? { view: hub.analytics, data: hub.data, export: hub.export } : null, k);
    }
  });

  test('sağlayıcı seçimi: DeciShip örnek üretici; kaydı olmayan araç boş sözleşme yanıtı', () => {
    assert.equal(hubProvider('deciship').source, 'generator');
    assert.equal(usesRecordings('deciship'), false);
    for (const k of PRODUCT_KEYS.filter((x) => usesRecordings(x))) {
      const p = hubProvider(k, {});
      assert.equal(p.source, 'empty', k);
      assert.deepEqual(p.overview(q, ctx()).body, emptyHubOverview(k, q));
      assert.deepEqual(p.analytics(q, ctx()).body, emptyHubAnalytics(k, q));
      assert.deepEqual(p.datasets(ctx()).body, emptyHubDatasetList(k));
      assert.deepEqual(p.activity(2, 10, ctx()).body, emptyHubActivityPage(2, 10));
      assert.equal(p.dataset('x', params, ctx()).status, 404);
    }
  });

  test('glob yolları araç başına bölünür; klasör dışı dosya sayılmaz', () => {
    const g = groupRecordings({
      '../../e2e/fixtures/orderloom-real/overview.tr.json': { status: 200, body: 1 },
      '../../e2e/fixtures/account-real/me.owner.tr.json': { status: 200, body: 2 },
      '../../e2e/other/x.json': { status: 200, body: 3 },
    });
    assert.deepEqual(Object.keys(g).sort(), ['account', 'orderloom']);
    assert.deepEqual(g.orderloom, { 'overview.tr': { status: 200, body: 1 } });
  });

  test('kayıtlı sağlayıcı: yanıt kayıttan aynen (yer tutucu an geçerli ana çevrilir), dil yoksa Türkçe, olmayan veri kümesi 404', () => {
    const files = groupRecordings(readDir('deciship-real')).deciship;
    const p = recordedProvider('deciship', files);
    assert.equal(hubProvider('orderloom', files).source, 'recorded');
    const body = (name) => fillStamps(files[name].body);
    assert.deepEqual(p.overview(q, ctx()).body, body('overview.tr'));
    assert.deepEqual(p.overview(q, ctx('en')).body, body('overview.en'));
    assert.deepEqual(p.analytics(q, ctx('en')).body, body('analytics.tr'));
    assert.deepEqual(p.datasets(ctx()).body, body('datasets.tr'));
    assert.deepEqual(p.activity(1, 5, ctx()).body, body('activity.tr'));
    for (const d of body('datasets.tr').datasets) assert.deepEqual(p.dataset(d.id, params, ctx()), { status: 200, body: body(`dataset.${d.id}.tr`) }, d.id);
    assert.deepEqual(p.dataset('yok', params, ctx()), { status: 404 });
    // Yanıt kopyadır: Merkez'in (ya da test kancasının) değiştirmesi kaydı bozmaz.
    p.overview(q, ctx()).body.sample = true;
    assert.equal('sample' in files['overview.tr'].body, false);
  });

  test('kayıttaki `<zaman>` geçerli ISO an olur: sıra korunur (yeniden eskiye), belirlenimci; Etkinlik sonraki sayfası boş', () => {
    const files = groupRecordings(readDir('deciship-real')).deciship;
    const raw = files['activity.tr'].body;
    assert.ok(JSON.stringify(raw).includes('<zaman>'), 'kayıtta yer tutucu var');
    const p = recordedProvider('deciship', files);
    const first = p.activity(1, 5, ctx()).body;
    assert.equal(JSON.stringify(first).includes('<zaman>'), false);
    const at = first.items.map((i) => i.at);
    for (const a of at) assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual([...at].sort().reverse(), at);
    assert.deepEqual(p.activity(1, 5, ctx()).body, first);
    const second = p.activity(2, 5, ctx()).body;
    assert.deepEqual(second.items, []);
    assert.equal(second.page, 2);
    assert.equal(second.total, raw.total);
  });

  test('boş firma (`ctx.empty`): kurulum kayıttan ama hiçbir adımı yapılmamış, rakam yok; analiz ve Etkinlik boş; veri kümesi satırsız', () => {
    const files = groupRecordings(readDir('tagpress-real')).tagpress;
    const p = recordedProvider('tagpress', files);
    const fresh = { ...ctx(), empty: true };
    const rec = files['overview.tr'].body;
    const o = p.overview(q, fresh).body;
    assert.deepEqual({ ...o, setup: undefined }, { ...emptyHubOverview('tagpress', q), setup: undefined });
    assert.equal(o.setup.completed, false);
    assert.deepEqual(o.setup.steps.map((s) => s.id), rec.setup.steps.map((s) => s.id));
    assert.ok(o.setup.steps.every((s) => s.done === false));
    assert.deepEqual(p.analytics(q, fresh).body, emptyHubAnalytics('tagpress', q));
    assert.deepEqual(p.activity(1, 5, fresh).body, emptyHubActivityPage(1, 5));
    assert.deepEqual(p.datasets(fresh).body, fillStamps(files['datasets.tr'].body));
    for (const d of files['datasets.tr'].body.datasets) {
      const page = p.dataset(d.id, params, fresh).body;
      assert.deepEqual(page.rows, [], d.id);
      assert.equal(page.total, 0, d.id);
      assert.deepEqual(page.columns, files[`dataset.${d.id}.tr`].body.columns, d.id);
    }
    // Dolu firmada kayıt olduğu gibi.
    assert.deepEqual(p.overview(q, ctx()).body, fillStamps(rec));
  });

  test('kayıtlı sağlayıcı CSV: başlık kolon adları, satır başına bir kayıt satırı', () => {
    const files = groupRecordings(readDir('deciship-real')).deciship;
    const p = recordedProvider('deciship', files);
    const page = files['dataset.invoices.tr'].body;
    const r = p.datasetCsv('invoices', params, ctx());
    assert.equal(r.status, 200);
    const lines = r.csv.replace(/^\uFEFF/, '').split('\r\n');
    assert.equal(lines.length, 1 + page.rows.length);
    assert.equal(lines[0], page.columns.map((c) => c.label).join(';'));
    assert.equal(p.datasetCsv('yok', params, ctx()).status, 404);
  });

  test('boş sağlayıcının veri kümesi ve CSV yanıtı 404', () => {
    const p = emptyProvider('orderloom');
    assert.equal(p.datasetCsv('x', params, ctx()).status, 404);
  });
});

describe('Merkez sahte API işleyicileri (Node, msw): araç uçları kayıttan kurulur', async () => {
  const { freshMock, call, closeMock, RECORDINGS } = await import('./lib/mock-server.mjs');
  const signIn = (identifier) => call('POST', '/api/account/auth/login', { body: { identifier, password: 'Test12345!' } });
  const period = 'from=2026-10-01&to=2026-10-31';

  test('kaydı olmayan araç boş yanıt, kaydı olan araç kayıttan, tanınmayan araç 404', async () => {
    freshMock();
    assert.equal((await signIn('sahip@ornek.test')).status, 200);
    const bare = PRODUCT_KEYS.filter((x) => usesRecordings(x) && !RECORDINGS[x]);
    const recorded = PRODUCT_KEYS.filter((x) => usesRecordings(x) && RECORDINGS[x]);
    // Klasör adları gerçek: OrderLoom'un kaydı yok, TagPress'in var (`e2e/fixtures/tagpress-real/`).
    assert.ok(bare.includes('orderloom'), 'OrderLoom kaydı olmayan araç');
    assert.ok(recorded.includes('tagpress'), 'TagPress kaydı olan araç');
    for (const k of bare) {
      assert.deepEqual(
        await call('GET', `/api/${k}/platform/overview?${period}`),
        { status: 200, body: emptyHubOverview(k, { from: '2026-10-01', to: '2026-10-31' }) },
        k,
      );
      assert.equal((await call('GET', `/api/${k}/platform/datasets/yok`)).status, 404, k);
    }
    for (const k of recorded) {
      const rec = (name) => fillStamps(RECORDINGS[k][name].body);
      assert.deepEqual(await call('GET', `/api/${k}/platform/overview?${period}`), { status: 200, body: rec('overview.tr') }, k);
      assert.deepEqual(await call('GET', `/api/${k}/platform/overview?${period}`, { locale: 'en' }), { status: 200, body: rec('overview.en') }, `${k} en`);
      assert.deepEqual(await call('GET', `/api/${k}/platform/datasets`), { status: 200, body: rec('datasets.tr') }, k);
      for (const d of rec('datasets.tr').datasets) {
        assert.deepEqual(await call('GET', `/api/${k}/platform/datasets/${d.id}?page=1`), { status: 200, body: rec(`dataset.${d.id}.tr`) }, `${k} ${d.id}`);
      }
      assert.equal((await call('GET', `/api/${k}/platform/datasets/yok`)).status, 404, k);
    }
    assert.equal((await call('GET', `/api/yokarac/platform/overview?${period}`)).status, 404);
  });

  test('kapı kayıttaki izinden: DeciShip ölçüm rolü Genel Bakış 403, yönetici 200; test kancası araç anahtarlı', async () => {
    freshMock();
    await signIn('+905320000004');
    const measure = await call('GET', `/api/deciship/platform/overview?${period}`);
    assert.deepEqual([measure.status, measure.body.error.code], [403, 'FORBIDDEN']);
    freshMock();
    await signIn('sahip@ornek.test');
    assert.equal((await call('GET', `/api/deciship/platform/overview?${period}`)).status, 200);
    localStorage.setItem('sod_mock_fail', JSON.stringify(['deciship.overview']));
    assert.equal((await call('GET', `/api/deciship/platform/overview?${period}`)).status, 500);
    closeMock();
  });
});
