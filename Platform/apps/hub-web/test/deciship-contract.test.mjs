// Sahte API ile gerçek DeciShip Merkez uçları ayrılmasın (Mesaj 10, 15-B2). Tarayıcısız: `npm test` ile her gönderimde koşar.
// Gerçek yanıtlar `e2e/fixtures/deciship-real/*.json`: DeciShip API veritabanı testi üretir ve denetler
// (Deciship/apps/api/test/hub/hubWebFixtures.test.ts; yenileme orada `-u`). Kimlikler `<id>`, kayıt anları `<zaman>` yazılı.
// Kayıt yenilenince bu test kırılır: sahte API (`src/mocks/deciship.ts`) gerçeğe uydurulur, test gevşetilmez.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareShape, shapeOf } from '../../../../scripts/lib/shape.mjs';
import { daysUntil } from '../src/lib/period.ts';
import { activityPage, aiCalls, aiUsage, analytics, datasetDefs, datasetPage, overview } from '../src/mocks/deciship.ts';

const DIR = path.resolve(import.meta.dirname, '../e2e/fixtures/deciship-real');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const real = (name) => fixture(name).body;
/** Sahte API yanıtı tarayıcıya JSON olarak gider: `undefined` alanlar düşer (gerçek yanıtla aynı karşılaştırma). */
const json = (v) => JSON.parse(JSON.stringify(v));

const ADMIN = ['deciship.web.access', 'deciship.settings.manage', 'deciship.tariffs.edit', 'deciship.invoices.upload', 'deciship.lines.decide', 'deciship.disputes.manage', 'deciship.invoices.view', 'deciship.reports.view', 'deciship.data.export', 'deciship.measurements.capture', 'deciship.measurements.view_all', 'deciship.measurements.manage', 'deciship.prices.view'];

/** İtiraz takibi (Deciship/spec/itiraz.md) ile gelen kimlikler. */
const DISPUTE_KPIS = new Set(['recovered', 'disputePending']);
const ctx = { locale: 'tr', can: (p) => ADMIN.includes(p), empty: false };
const today = new Date().toISOString().slice(0, 10);
const from30 = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

const keys = (o) => Object.keys(o).sort();
const prefix = (id) => id.split(':')[0];
const uniq = (a) => [...new Set(a)];
const widgetSig = (w) => {
  if (w.kind === 'table') return `${w.id}|table|${w.columns.map((c) => `${c.id}:${c.format}`).join(',')}`;
  if (w.kind === 'breakdown') return `${w.id}|breakdown|${w.format}`;
  if (w.kind === 'timeseries') return `${w.id}|timeseries|${w.chart}|${w.format}|${w.series.map((s) => `${s.id}/${s.role}`).join(',')}`;
  if (w.kind === 'kpis') return `${w.id}|kpis|${w.items.map((k) => k.id).join(',')}`;
  return `${w.id}|empty`;
};
/** Bağlantının süzgeç yapısı: dönem ve para birimi dışındaki süzgeçler, değerleriyle (kimlik değerleri `*`). */
const ID_PARAMS = new Set(['filter.carrier', 'filter.invoiceId', 'filter.user', 'carrier', 'id', 'userId', 'line']);
const SCOPE_PARAMS = new Set(['filter.from', 'filter.to', 'filter.currency']);
const hrefSig = (href) => {
  if (!href) return String(href);
  const [p, q = ''] = href.split('?');
  const params = [...new URLSearchParams(q)].filter(([k]) => !SCOPE_PARAMS.has(k)).map(([k, v]) => `${k}=${ID_PARAMS.has(k) ? '*' : v}`);
  return `${p.replace(/\/(invoices|tariffs)\/(?!upload$)[^/]+$/, '/$1/*')}?${params.sort().join('&')}`;
};

/** Bağlantı biçimleri: links.ts. Eski mock uydurmaları burada yakalanır. */
const GOOD_HREF = [
  /^\/analytics\/deciship(\?filter\.currency=[A-Z]{3})?$/,
  /^\/data\/deciship\/(invoices|invoice-lines|measurements|tariffs|carriers|audit-log)(\?filter\.[a-zA-Z]+=[^&]*(&filter\.[a-zA-Z]+=[^&]*)*)?$/,
  /^\/deciship\/invoices\/[^/?]+\?tab=[A-Z_]+(&line=[^&]+)?$/,
  /^\/deciship\/measurements\?id=[^&]+$/,
  /^\/deciship\/measurements\?userId=[^&]+(&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2})?$/,
  /^\/deciship\/tariffs\/[^/?]+$/,
  /^\/deciship\/tariffs(\?carrier=[^&]+)?$/,
  /^\/deciship\/setup(\?adim=[a-z]+)?$/,
  /^\/deciship\/measurements$/,
  /^\/deciship\/invoices\/upload$/,
  /^\/deciship\/settings$/,
  /^\/deciship\/invoices$/,
  /^\/deciship\/disputes(\?status=(UNSENT|SENT|CLOSED))?$/,
];
function allHrefs(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allHrefs(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (k === 'href' && typeof v === 'string' ? out.push(v) : allHrefs(v, out));
  return out;
}
const expectHrefs = (v, name) => {
  for (const h of allHrefs(v)) assert.ok(GOOD_HREF.some((r) => r.test(h)), `${name}: ${h}`);
};
const includes = (list, item, msg) => assert.ok(list.includes(item), `${msg ?? ''} ${JSON.stringify(item)} yok: ${JSON.stringify(list)}`);

describe('mock = gerçek şekil', () => {
  test('gerçek fikstürün bağlantıları da bilinen biçimde (test kendini doğrular)', () => {
    expectHrefs(real('overview.tr'), 'real overview');
    expectHrefs(real('analytics.tr'), 'real analytics');
    expectHrefs(real('dataset.invoice-lines.tr'), 'real lines');
    expectHrefs(real('dataset.measurements.tr'), 'real measurements');
    expectHrefs(real('ai-usage-calls.tr'), 'real ai calls');
  });

  test('overview: KPI kimlikleri, alanları, bekleyen türleri, split parçaları', () => {
    const r = real('overview.tr');
    const m = json(overview(from30, today, ctx));
    for (const k of keys(r).filter((x) => x !== 'split')) includes(keys(m), k, 'mock alanı');
    // Mock başka alan uydurmaz (`leaders` artık gerçek uçta da var: istisna kalktı).
    for (const k of keys(m)) includes(keys(r), k, 'gerçek alanı');

    const realIds = r.kpis.map((k) => k.id);
    const mockIds = m.kpis.map((k) => k.id);
    assert.deepEqual(mockIds, realIds);
    for (const rk of r.kpis) {
      const mk = m.kpis.find((k) => k.id === rk.id);
      assert.equal(mk.format, rk.format, rk.id);
      assert.equal(mk.goodDirection, rk.goodDirection, rk.id);
      assert.equal(mk.label, rk.label, rk.id);
      assert.deepEqual(keys(mk).filter((k) => k !== 'previous' && k !== 'tone'), keys(rk).filter((k) => k !== 'previous' && k !== 'tone'), rk.id);
      assert.equal(hrefSig(mk.href), hrefSig(rk.href), `${rk.id} bağlantısı`);
    }
    assert.deepEqual(
      m.kpis[0].trend.map((s) => `${s.id}/${s.role}`),
      r.kpis[0].trend.map((s) => `${s.id}/${s.role}`),
    );

    // Mock'taki her bekleyen türü gerçek kodda var; gerçek fikstürdekiler mockta da var
    const KNOWN = ['deadline', 'deadline-more', 'open', 'unmatched', 'no-tariff', 'fx-missing', 'flagged', 'tariff-none', 'tariff-expiry', 'no-photo'];
    for (const a of m.alerts) includes(KNOWN, prefix(a.id), a.id);
    for (const p of uniq(r.alerts.map((a) => prefix(a.id)))) includes(uniq(m.alerts.map((a) => prefix(a.id))), p, p);
    for (const a of r.alerts) {
      const twin = m.alerts.find((x) => prefix(x.id) === prefix(a.id));
      assert.deepEqual(keys(twin).filter((k) => k !== 'amount' && k !== 'at' && k !== 'dueAt'), keys(a).filter((k) => k !== 'amount' && k !== 'at' && k !== 'dueAt'), a.id);
      assert.equal(twin.amount?.format, a.amount?.format);
      assert.equal(hrefSig(twin.href), hrefSig(a.href), `${a.id} bağlantısı`);
    }

    assert.deepEqual(m.split.parts.map((p) => p.key), r.split.parts.map((p) => p.key));
    assert.deepEqual(m.split.parts.map((p) => p.tone), r.split.parts.map((p) => p.tone));
    // Parça adı, açıklaması ve bağlantının süzgeci birebir ("Fark var" uyumlu sayılanları dışarıda bırakır).
    assert.deepEqual(
      m.split.parts.map((p) => ({ key: p.key, label: p.label, note: p.note, href: hrefSig(p.href) })),
      r.split.parts.map((p) => ({ key: p.key, label: p.label, note: p.note, href: hrefSig(p.href) })),
    );
    // En çok kaçıran: grup adları, kimlik biçimi ve bağlantı süzgeci gerçek uçla aynı.
    // Fark türü örnek veriye göre değişir: türün kendisi değil, süzgeç yapısı karşılaştırılır.
    const leaderSig = (l) => JSON.stringify({ group: l.label, kind: prefix(l.id), href: hrefSig(l.href).replace(/filter\.diff=[^&]+/, 'filter.diff=*'), format: l.value.format, share: typeof l.share });
    assert.deepEqual(uniq(m.leaders.map(leaderSig)), uniq(r.leaders.map(leaderSig)));
    // Kurulum listesi birebir: adım kimlikleri, etiketler, bağlantılar, zorunluluk (örnek veride hepsi yapılmış).
    assert.deepEqual(m.setup, r.setup);
    expectHrefs(m, 'mock overview');
  });

  test('analytics: bölüm ve widget sırası, kolonlar, süzgeçler', () => {
    const r = real('analytics.tr');
    const m = json(analytics(from30, today, true, {}, ctx));
    assert.deepEqual(m.filters.map((f) => `${f.id}:${f.kind}`), r.filters.map((f) => `${f.id}:${f.kind}`));
    assert.deepEqual(m.sections.map((s) => s.id), r.sections.map((s) => s.id));
    // Gerçek kayıtta artık tarife sapması da var (K-3): bütün widget'lar birebir, seçimli istisna kalktı.
    for (const rs of r.sections) {
      const ms = m.sections.find((s) => s.id === rs.id);
      assert.equal(ms.title, rs.title);
      assert.deepEqual(ms.widgets.map(widgetSig), rs.widgets.map(widgetSig), rs.id);
    }
    expectHrefs(m, 'mock analytics');
  });

  test('veri setleri: kimlikler, süzgeç değerleri, kolonlar, sıralanabilirlik, hücre anahtarları', () => {
    const r = real('datasets.tr');
    const m = json(datasetDefs(ctx));
    assert.deepEqual(m.datasets.map((d) => d.id), r.datasets.map((d) => d.id));
    for (const rd of r.datasets) {
      const md = m.datasets.find((d) => d.id === rd.id);
      assert.equal(md.label, rd.label);
      assert.equal(md.exportable, rd.exportable);
      assert.deepEqual(md.filters.map((f) => `${f.id}:${f.kind}`), rd.filters.map((f) => `${f.id}:${f.kind}`), rd.id);
      for (const rf of rd.filters) {
        if (rf.kind !== 'select' || ['carrier', 'user', 'currency'].includes(rf.id)) continue;
        const mf = md.filters.find((f) => f.id === rf.id);
        assert.deepEqual(mf.kind === 'select' ? mf.options.map((o) => o.value) : [], rf.options.map((o) => o.value), `${rd.id}.${rf.id}`);
      }
      const page = real(`dataset.${rd.id}.tr`);
      const mine = json(datasetPage(rd.id, { page: 1, pageSize: 4, q: '', filters: {} }, ctx));
      // Tek para biriminde kolon biçimi değişir; ikisi de karışık sayfa üretir.
      // Sıra API'den gelecek (tutarlar öne): küme aynı olmalı.
      assert.deepEqual(
        mine.columns.map((c) => `${c.id}:${c.format}:${c.sortable ?? false}`).sort(),
        page.columns.map((c) => `${c.id}:${c.format}:${c.sortable ?? false}`).sort(),
        rd.id,
      );
      if (page.rows[0]) {
        assert.deepEqual(keys(mine.rows[0].cells), keys(page.rows[0].cells), rd.id);
        expectHrefs(mine.rows, `mock ${rd.id}`);
      }
    }
  });

  test('izinsiz kapılar: muhasebe gerçek listeyle aynı; ölçüm rolü fikstürde 403', () => {
    const accounting = ['deciship.web.access', 'deciship.invoices.view', 'deciship.reports.view', 'deciship.data.export', 'deciship.measurements.view_all', 'deciship.prices.view'];
    const r = real('datasets.accounting.tr');
    const m = datasetDefs({ ...ctx, can: (p) => accounting.includes(p) });
    assert.deepEqual(m.datasets.map((d) => d.id), r.datasets.map((d) => d.id));
    assert.equal(fixture('overview.measure.tr').status, 403);
  });

  test('etkinlik: öğe alanları', () => {
    const r = real('activity.tr');
    const m = json(activityPage(1, 5, ctx));
    assert.deepEqual(keys(m), ['items', 'page', 'pageSize', 'total']);
    assert.deepEqual(keys(m.items[0]), keys(r.items[0]));
    expectHrefs(m, 'mock activity');
  });

  test('yapay zekâ kullanımı: alanlar, tür ve kişi dökümü', () => {
    const r = real('ai-usage.tr');
    const m = json(aiUsage(ctx));
    assert.deepEqual(keys(m), keys(r));
    assert.deepEqual(keys(m.tokens), keys(r.tokens));
    assert.deepEqual(keys(m.byKind[0]), keys(r.byKind[0]));
    assert.deepEqual(keys(m.byMember[0]), keys(r.byMember[0]));
    // Tür etiketi gerçek sözlükten: gerçek kayıttaki her türün etiketi mockta aynı.
    for (const rk of r.byKind) {
      const mk = m.byKind.find((k) => k.kind === rk.kind);
      assert.ok(mk, `mockta ${rk.kind} türü yok`);
      assert.equal(mk.label, rk.label, rk.kind);
    }
    // Ayrıntılı dökümün özet alanları: sonuç dağılımı, geçen ayın aynı süresi, seçilebilir aylar (yeniden eskiye).
    assert.deepEqual(keys(m.statusCounts), keys(r.statusCounts));
    assert.deepEqual(keys(m.previous), keys(r.previous));
    assert.deepEqual(keys(m.months[0]), keys(r.months[0]));
    assert.equal(m.months[0].period, m.period);
    assert.equal(m.months.at(-1).period, m.firstPeriod);
    assert.equal(Object.values(m.statusCounts).reduce((a, b) => a + b, 0), m.calls);
  });

  test('yapay zekâ dökümü: alanlar, sonuçlar, tür etiketleri, kayıt bağlantısı', () => {
    const r = real('ai-usage-calls.tr');
    const m = json(aiCalls({ page: 1, pageSize: 50 }, ctx));
    assert.deepEqual(keys(m), keys(r));
    assert.equal(m.pageSize, r.pageSize);
    const withRecord = (list) => list.find((c) => c.record && c.href);
    assert.ok(withRecord(m.items), 'mockta kayıt bağlantılı satır yok');
    assert.deepEqual(keys(withRecord(m.items)), keys(withRecord(r.items)));
    const STATUSES = ['ok', 'refused', 'truncated', 'failed'];
    for (const c of m.items) includes(STATUSES, c.status, c.id);
    for (const s of uniq(r.items.map((c) => c.status))) includes(uniq(m.items.map((c) => c.status)), s, 'mockta sonuç yok');
    // Tür etiketi gerçek sözlükten; silinmiş kişi sunucunun etiketiyle.
    for (const rc of r.items) {
      const mc = m.items.find((c) => c.kind === rc.kind);
      if (mc) assert.equal(mc.label, rc.label, rc.kind);
    }
    assert.equal(m.items.find((c) => c.memberId === null)?.person, r.items.find((c) => c.memberId === null).person);
    expectHrefs(m, 'mock ai calls');
    // Sayfa boyu ve sıra: en yeni önce, ikinci sayfa ilkini tekrar etmez.
    const p1 = json(aiCalls({ page: 1, pageSize: 3 }, ctx));
    const p2 = json(aiCalls({ page: 2, pageSize: 3 }, ctx));
    assert.equal(p1.total, m.total);
    assert.ok(p1.items.every((c, i, a) => i === 0 || a[i - 1].at >= c.at));
    assert.ok(!p2.items.some((c) => p1.items.some((x) => x.id === c.id)));
    // Fiyat izni yoksa para alanları yok (gerçek uçta MONEY_KEY süzer).
    const cheap = json(aiCalls({ page: 1, pageSize: 50 }, { ...ctx, can: (p) => p !== 'deciship.prices.view' && ADMIN.includes(p) }));
    for (const c of cheap.items) for (const k of ['amount', 'priceVersion', 'priceUsdRate']) assert.ok(!(k in c), `${c.id}.${k}`);
  });

  test('alan adı ve türü: her uçta sahte yanıt gerçek şekle uyar (scripts/lib/shape.mjs)', () => {
    // Gerçekte boş olabilen ama kayıttaki sayfaya düşmeyen değer: ülkesiz satır (gerçek uç `countryName` boşta null;
    // services/hub/datasets.ts, analytics.ts "En çok fark" tablosu `destCountry`). Kayıtta yalnız ülkeli satır görünüyor.
    const COUNTRY_NULL = { ignore: ['$.sections[].widgets[].rows[].cells.country', '$.rows[].cells.country'] };
    const pairs = [
      ['overview.tr', overview(from30, today, ctx)],
      ['overview.en', overview(from30, today, { ...ctx, locale: 'en' })],
      ['analytics.tr', analytics(from30, today, true, {}, ctx), COUNTRY_NULL],
      ['datasets.tr', datasetDefs(ctx)],
      ['activity.tr', activityPage(1, 5, ctx)],
      ['ai-usage.tr', aiUsage(ctx)],
      ['ai-usage-calls.tr', aiCalls({ page: 1, pageSize: 50 }, ctx)],
      ...real('datasets.tr').datasets.map((d) => [`dataset.${d.id}.tr`, datasetPage(d.id, { page: 1, pageSize: 4, q: '', filters: {} }, ctx), COUNTRY_NULL]),
    ];
    const problems = pairs.flatMap(([name, mock, opts]) => compareShape(shapeOf(json(mock)), shapeOf(real(name)), opts).map((d) => `${name} ${d}`));
    assert.deepEqual(problems, []);
  });

  test('itiraz: geri alınan ve itirazda bekleyen, İtiraz listesinde ile tahmini arasında, gerçek sözlük etiketiyle', () => {
    const m = overview(from30, today, ctx);
    const ids = m.kpis.map((k) => k.id);
    assert.deepEqual(ids.slice(ids.indexOf('verified'), ids.indexOf('verified') + 3), ['verified', 'recovered', 'disputePending']);
    const recovered = m.kpis.find((k) => k.id === 'recovered');
    const pending = m.kpis.find((k) => k.id === 'disputePending');
    const pick = (o, sample) => Object.fromEntries(Object.keys(sample).map((k) => [k, o[k]]));
    const RECOVERED = { label: 'Geri alınan', format: 'money', currency: 'TRY', goodDirection: 'up', href: '/deciship/disputes' };
    const PENDING = { label: 'İtirazda bekleyen', format: 'money', currency: 'TRY', goodDirection: 'none', href: '/deciship/disputes?status=SENT' };
    assert.deepEqual(pick(recovered, RECOVERED), RECOVERED);
    assert.deepEqual(pick(pending, PENDING), PENDING);
    assert.deepEqual(overview(from30, today, { ...ctx, locale: 'en' }).kpis.filter((k) => DISPUTE_KPIS.has(k.id)).map((k) => k.label), ['Recovered', 'Pending in disputes']);
    // Örnek veride ikisi de sıfırdan büyük; para izni yoksa ikisi de yok (stripMoney ile aynı sonuç).
    const longer = overview(new Date(Date.now() - 119 * 86_400_000).toISOString().slice(0, 10), today, ctx);
    assert.ok(longer.kpis.find((k) => k.id === 'recovered').value > 0);
    assert.ok(longer.kpis.find((k) => k.id === 'disputePending').value > 0);
    const noMoney = overview(from30, today, { ...ctx, can: (p) => p !== 'deciship.prices.view' && ADMIN.includes(p) });
    assert.ok(!noMoney.kpis.map((k) => k.id).includes('recovered'));
    assert.ok(!noMoney.kpis.map((k) => k.id).includes('disputePending'));
    // Gerçek fikstür yenilenince birebir: etiket, biçim, yön ve anahtarlar.
    const r = real('overview.tr');
    for (const rk of r.kpis.filter((k) => DISPUTE_KPIS.has(k.id))) {
      const mk = m.kpis.find((k) => k.id === rk.id);
      assert.deepEqual({ label: mk.label, format: mk.format, goodDirection: mk.goodDirection, href: mk.href }, { label: rk.label, format: rk.format, goodDirection: rk.goodDirection, href: rk.href });
    }
  });

  test('karşılığı olmayan iade sayısı veya eski bağlantı yok', () => {
    const blob = JSON.stringify([overview(from30, today, ctx), analytics(from30, today, true, {}, ctx), datasetDefs(ctx), activityPage(1, 50, ctx)]);
    // "Geri alınan" artık alacak dekontuna dayanır (itiraz takibi); eski uydurma iade adları yine yok.
    assert.doesNotMatch(blob, /geri alınmayan|İtirazla|İtiraz edildi|İtiraz sonuçları|netOpen|iade edil/i);
    // `?status=` yalnız İtirazlar sayfasının kendi süzgecinde (links.ts deciship.disputes); veri setleri `filter.status`.
    assert.doesNotMatch(blob, /missingPhotos|(?<!\/deciship\/disputes)[?&]status=|[?&]by=|\/measurements\/[a-z]/);
    assert.ok(!blob.includes('"finding"'));
  });
});

test('kalan gün: takvim günü, firma saat dilimi', () => {
  // Europe/Istanbul UTC+3: 20:59Z = 23:59, 21:30Z = ertesi gün 00:30.
  assert.equal(daysUntil('2026-11-07', new Date('2026-11-06T20:59:00Z')), 1);
  assert.equal(daysUntil('2026-11-07', new Date('2026-11-06T21:30:00Z')), 0);
  assert.equal(daysUntil('2026-11-08', new Date('2026-11-06T09:00:00Z')), 2);
  assert.equal(daysUntil('2026-11-05', new Date('2026-11-06T09:00:00Z')), -1);
  // Yaz saati değişimi (29 Mart, Berlin) gün sayısını bozmaz: 23 saatlik gün de bir gündür.
  assert.equal(daysUntil('2026-03-30', new Date('2026-03-28T22:30:00Z'), 'Europe/Berlin'), 2);
});
