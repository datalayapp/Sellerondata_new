import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyticsTools, canSeeHub, hubScope, isOrgAdmin, overviewTools } from '../access';
import { createHubCache } from '../cache';
import { assignColors, buildChart, niceMax, PREVIOUS_COLOR, pickIndex, SERIES_COLORS } from '../chart';
import { ago, axisValue, dateRange, hubValue, isoDay, kpiDelta, money, rangeDates, updatedAt } from '../format';
import { HubApiError, query, readJson, toHubError } from '../http';
import { APP_ROUTES, resolveHubLink, WEB_ORIGIN, WEB_ROUTES } from '../links';
import { emptyResource, resourceReducer, type ResourceState } from '../resource';
import { asMembers, overviewTool, overviewView, sortAlerts, stripContact, teamView, toolPickerItems, type OrgMember } from '../views';
import { PRODUCTS } from '../contracts';
import { ctxEn, ctxTr, makeMe, overview } from './fixtures';

/** Ekranda tutar ile simge/kod arası bölünmez boşluk (rapor Y72, Mesaj 12 D). */
const NB = String.fromCharCode(0xa0);

/* ── access ─────────────────────────────────────────────── */

const MEASURE = ['deciship.measurements.capture'];

test('canSeeHub: OWNER ve ADMIN görür, aracı olmasa da', () => {
  assert.equal(canSeeHub(makeMe({ orgRole: 'OWNER', role: null })), true);
  assert.equal(canSeeHub(makeMe({ orgRole: 'ADMIN', role: null })), true);
});

test('canSeeHub: çalışan yalnız rapor izniyle görür', () => {
  assert.equal(canSeeHub(makeMe({ orgRole: 'MEMBER', role: 'ACCOUNTING' })), true);
  assert.equal(canSeeHub(makeMe({ orgRole: 'MEMBER', role: 'MEASURE', permissions: MEASURE })), false);
  assert.equal(canSeeHub(makeMe({ orgRole: 'MEMBER', role: null })), false);
});

test('canSeeHub: aboneliksiz ürün, askı ve firmasızlık kapatır', () => {
  assert.equal(canSeeHub(makeMe({ orgRole: 'MEMBER', subscribed: false })), false);
  assert.equal(canSeeHub(makeMe({ orgRole: 'OWNER', suspended: true })), false);
  assert.equal(canSeeHub(makeMe({ org: false })), false);
});

test('araç listeleri ve yönetici', () => {
  assert.deepEqual(overviewTools(makeMe()), ['deciship']);
  assert.deepEqual(analyticsTools(makeMe({ orgRole: 'OWNER', role: null })), []);
  assert.deepEqual(overviewTools(makeMe({ orgRole: 'MEMBER', role: 'MEASURE', permissions: MEASURE })), []);
  assert.equal(isOrgAdmin(makeMe({ orgRole: 'MEMBER' })), false);
  assert.equal(isOrgAdmin(makeMe({ orgRole: 'ADMIN' })), true);
});

test('hubScope: kişi, firma, rol veya izin değişince değişir; izin sırası etkilemez', () => {
  const base = hubScope(makeMe());
  assert.equal(hubScope(makeMe()), base);
  assert.notEqual(hubScope(makeMe({ personId: 'p-2' })), base);
  assert.notEqual(hubScope(makeMe({ orgId: 'org-2' })), base);
  assert.notEqual(hubScope(makeMe({ orgRole: 'ADMIN' })), base);
  assert.notEqual(hubScope(makeMe({ role: 'AUDITOR' })), base);
  assert.notEqual(hubScope(makeMe({ permissions: ['deciship.reports.view'] })), base);
  const reversed = makeMe();
  reversed.products[0]!.permissions.reverse();
  assert.equal(hubScope(reversed), base);
});

/* ── format ─────────────────────────────────────────────── */

test('para: dil ve para birimine göre', () => {
  assert.equal(money(2143.2, 'TRY', 'tr'), `2.143,20${NB}₺`);
  assert.equal(money(2143.2, 'TRY', 'en'), '₺2,143.20');
  assert.equal(money(-5, 'USD', 'en'), '−$5.00');
  // EUR/GBP firmaları web gibi dar simgeyle (narrowSymbol); bilinmeyen kod olduğu gibi.
  assert.equal(money(10, 'EUR', 'en'), '€10.00');
  assert.equal(money(5, 'EUR', 'tr'), `5,00${NB}€`);
  assert.equal(money(7.5, 'GBP', 'en'), '£7.50');
  assert.equal(money(7.5, 'GBP', 'tr'), `7,50${NB}£`);
  assert.equal(money(10, 'CHF', 'en'), `CHF${NB}10.00`);
});

test('hubValue: her biçim, boş değer uzun çizgi', () => {
  assert.equal(hubValue({ value: 86.4, format: 'percent' }, ctxTr), '%86,4');
  assert.equal(hubValue({ value: 86.4, format: 'percent' }, ctxEn), '86.4%');
  assert.equal(hubValue({ value: 1234.5, format: 'number' }, ctxTr), '1.234,5');
  assert.equal(hubValue({ value: 4.2, format: 'duration_days' }, ctxTr), '4,2 gün');
  assert.equal(hubValue({ value: null, format: 'money' }, ctxTr), '—');
  assert.equal(hubValue({ value: Number.NaN, format: 'number' }, ctxTr), '—');
  assert.equal(hubValue({ value: 'FedEx', format: 'text' }, ctxTr), 'FedEx');
  assert.match(hubValue({ value: '2026-11-06', format: 'date' }, ctxTr), /^6 Kas 2026$/);
});

test('tarih yalnız gün olarak okunur, saat dilimi kaydırmaz', () => {
  assert.equal(dateRange('2026-10-08', '2026-11-06', 'tr'), '8 Eki – 6 Kas 2026');
  assert.equal(dateRange('2026-10-08', '2026-11-06', 'en'), '8 Oct – 6 Nov 2026');
});

test('eksen: 10 binden sonra kısa', () => {
  assert.equal(axisValue(5000, 'money', ctxTr), '5.000');
  assert.equal(axisValue(18500, 'money', ctxTr), '18,5 B');
  assert.equal(axisValue(2_500_000, 'number', ctxEn), '2.5 M');
  assert.equal(axisValue(50, 'percent', ctxTr), '%50');
  assert.equal(axisValue(0, 'number', ctxTr), '0');
});

test('kpiDelta: yön, iyi/kötü, yüzde puan olarak', () => {
  const up = kpiDelta({ value: 120, previous: 100, goodDirection: 'down', format: 'number' }, ctxTr)!;
  assert.deepEqual([up.dir, up.tone, up.amount], ['up', 'bad', '%20']);
  const good = kpiDelta({ value: 80, previous: 100, goodDirection: 'down', format: 'number' }, ctxTr)!;
  assert.deepEqual([good.dir, good.tone], ['down', 'good']);
  const pts = kpiDelta({ value: 84.6, previous: 81.2, goodDirection: 'up', format: 'percent' }, ctxTr)!;
  assert.equal(pts.amount, '3,4 puan');
  const fromZero = kpiDelta({ value: 50, previous: 0, goodDirection: 'none', format: 'money', currency: 'TRY' }, ctxTr)!;
  assert.deepEqual([fromZero.tone, fromZero.amount], ['neutral', `50,00${NB}₺`]);
  assert.equal(kpiDelta({ value: 5, previous: 5, goodDirection: 'up', format: 'number' }, ctxTr)!.dir, 'flat');
  assert.equal(kpiDelta({ value: 5, previous: null, format: 'number' }, ctxTr), null);
  assert.equal(kpiDelta({ value: null, previous: 5, format: 'number' }, ctxTr), null);
});

test('rangeDates: web ile aynı dönemler', () => {
  const now = new Date(2026, 10, 6);
  assert.deepEqual(rangeDates('7d', now), { from: '2026-10-31', to: '2026-11-06' });
  assert.deepEqual(rangeDates('30d', now), { from: '2026-10-08', to: '2026-11-06' });
  assert.deepEqual(rangeDates('mtd', now), { from: '2026-11-01', to: '2026-11-06' });
  assert.deepEqual(rangeDates('90d', now), { from: '2026-08-09', to: '2026-11-06' });
});

test('saat dilimi (Y132): dönem ve zamanlar firmanın saat diliminde, web Merkez ile aynı', () => {
  // İstanbul'da 7 Kasım 01:30 = UTC'de 6 Kasım 22:30: telefon saati değil firmanın günü sayılır.
  const at = new Date('2026-11-06T22:30:00Z');
  assert.equal(isoDay(at, 'Europe/Istanbul'), '2026-11-07');
  assert.equal(isoDay(at, 'UTC'), '2026-11-06');
  assert.deepEqual(rangeDates('7d', at, 'Europe/Istanbul'), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(rangeDates('mtd', at, 'UTC'), { from: '2026-11-01', to: '2026-11-06' });
  // ay dönümü: İstanbul'da 1 Aralık başladı
  assert.deepEqual(rangeDates('mtd', new Date('2026-11-30T22:30:00Z'), 'Europe/Istanbul'), { from: '2026-12-01', to: '2026-12-01' });
  // "son güncelleme": aynı gün firmanın gününe göre
  assert.equal(updatedAt(at.getTime(), 'tr', Date.parse('2026-11-07T05:00:00Z'), 'Europe/Istanbul'), '01:30');
  assert.equal(updatedAt(Date.parse('2026-11-06T20:30:00Z'), 'tr', Date.parse('2026-11-06T21:30:00Z'), 'Europe/Istanbul'), '6 Kas 23:30');
  // tarih-saat değeri ve eski olayın tarihi
  assert.equal(hubValue({ value: '2026-11-06T22:30:00Z', format: 'datetime' }, { ...ctxTr, timeZone: 'Europe/Istanbul' }), '7 Kas 2026 01:30');
  assert.deepEqual(ago('2026-09-30T22:30:00Z', 'tr', Date.parse('2026-11-07T00:00:00Z'), 'Europe/Istanbul'), { unit: 'date', text: '1 Eki 2026' });
});

/* ── views ──────────────────────────────────────────────── */

test('bekleyenler: tutara göre, tutarsızlar sonda önem sırasıyla', () => {
  assert.deepEqual(sortAlerts(overview.alerts).map((a) => a.id), ['big', 'small', 'urgent', 'tariff', 'photos']);
});

test('overviewView: baş rakam, kurulum, boş veri', () => {
  const v = overviewView(overview);
  assert.equal(v.lead?.id, 'overcharge');
  assert.equal(v.rest.length, 1);
  assert.equal(v.noData, false);
  assert.deepEqual(v.setup, { state: 'done' });
  const empty = overviewView({ ...overview, kpis: [{ id: 'x', label: 'x', value: null, format: 'money' }], alerts: [], setup: { completed: false, href: '/deciship/setup', label: 'Taşıyıcı ekleyin' } });
  assert.equal(empty.noData, true);
  assert.deepEqual(empty.setup, { state: 'open', href: '/deciship/setup', label: 'Taşıyıcı ekleyin' });
  assert.deepEqual(overviewView({ ...overview, setup: undefined }).setup, { state: 'none' });
});

const member = (over: Partial<OrgMember>): OrgMember => ({ id: 'x', name: 'X', orgRole: 'MEMBER', status: 'ACTIVE', lastActiveAt: null, ...over });

test('teamView: etkin üstte, sonra rol, ad; rol etiketi dile göre; yalnız açık araç', () => {
  const v = teamView(
    [
      member({ id: 'a', name: 'Zeynep', status: 'SUSPENDED', orgRole: 'OWNER' }),
      member({ id: 'b', name: 'Can', productRoles: { deciship: 'MEASURE' } }),
      member({ id: 'c', name: 'Ayşe', productRoles: { deciship: 'AUDITOR' } }),
      member({ id: 'd', name: 'Mert', orgRole: 'ADMIN', productRoles: { deciship: 'ADMIN' } }),
    ],
    'en',
  );
  assert.deepEqual(v.rows.map((r) => r.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual([v.active, v.suspended], [3, 1]);
  assert.equal(v.rows[0]!.orgRole, 'Company admin');
  assert.deepEqual(v.rows[2]!.tools, [{ key: 'deciship', name: 'DeciShip', role: 'Measurement' }]);
  assert.equal(v.rows[3]!.tools[0]!.role, null);
  assert.equal(teamView([member({ productRoles: { deciship: 'AUDITOR' } })], 'tr').rows[0]!.tools[0]!.role, 'Denetleyici');
  assert.equal(teamView([member({ productRoles: { deciship: 'YENI' } })], 'tr').rows[0]!.tools[0]!.role, 'YENI');
});

test('üye yanıtı: üç şekil, iletişim bilgisi düşer', () => {
  const raw = { ...member({ id: 'a' }), email: 'a@b.test', phone: '+905320000000' };
  assert.equal(asMembers({ members: [raw] }).length, 1);
  assert.equal(asMembers({ items: [raw] }).length, 1);
  assert.equal(asMembers([raw]).length, 1);
  assert.deepEqual(asMembers({}), []);
  const clean = stripContact(asMembers([raw]))[0]!;
  assert.equal('email' in clean, false);
  assert.equal('phone' in clean, false);
});

/* ── chart ──────────────────────────────────────────────── */

test('renk seriden gelir: önceki gri, diğerleri sabit sırayla, dördünden sonrası çizilmez', () => {
  const s = (id: string, role?: 'previous') => ({ id, label: id, points: [], ...(role ? { role } : {}) });
  const { plotted, omitted } = assignColors([s('prev', 'previous'), s('a'), s('b'), s('c'), s('d'), s('e')]);
  assert.equal(plotted[0]!.color, PREVIOUS_COLOR);
  assert.deepEqual(plotted.slice(1).map((p) => p.color), [...SERIES_COLORS]);
  assert.equal(omitted, 1);
  assert.equal(assignColors([s('a'), s('prev', 'previous')]).plotted[0]!.color, SERIES_COLORS[0]);
});

test('niceMax yuvarlar', () => {
  assert.deepEqual([0, 0.4, 7, 12, 23, 240, 18432].map(niceMax), [1, 0.5, 10, 20, 25, 250, 20000]);
});

const series = (ys: (number | null)[]) => [{ id: 'c', label: 'c', role: 'current' as const, points: ys.map((y, i) => ({ x: `2026-11-0${i + 1}`, y })) }];

test('çizgi: boşlukta kalem kalkar, son nokta boşu atlar, yatay etiketler uçta hizalı', () => {
  const g = buildChart({ series: series([1, null, 3, null]), chart: 'line', width: 344, height: 180 });
  assert.equal(g.n, 4);
  assert.equal(g.lines[0]!.line.match(/M/g)!.length, 2);
  assert.equal(g.lastIndex, 2);
  assert.equal(g.xTicks[0]!.anchor, 'start');
  assert.equal(g.xTicks[g.xTicks.length - 1]!.anchor, 'end');
  assert.equal(g.yTicks.length, 3);
  assert.equal(g.xAt(0), g.left);
  assert.equal(g.xAt(3), 344 - g.right);
});

test('alan yalnız güncel seride, önceki dönemde yok', () => {
  const g = buildChart({ series: [...series([1, 2]), { id: 'p', label: 'p', role: 'previous', points: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }] }], chart: 'area', width: 300, height: 180 });
  assert.ok(g.lines[0]!.area);
  assert.equal(g.lines[1]!.area, null);
});

test('çubuk: en çok 24 px, sıfır çizilmez, negatif tabandan aşağı, küçük değer görünür', () => {
  const wide = buildChart({ series: series([10, 0, 5]), chart: 'bar', width: 400, height: 180 });
  assert.ok(wide.bars[0]!.rects.every((r) => r.width <= 24));
  assert.equal(wide.bars[0]!.rects.length, 2);
  const neg = buildChart({ series: series([-10, 10]), chart: 'bar', width: 300, height: 180 });
  assert.ok(neg.yAt(-10) > neg.baseline);
  assert.ok(neg.yAt(10) < neg.baseline);
  const tiny = buildChart({ series: series([0.001, 1000]), chart: 'bar', width: 300, height: 180 });
  assert.equal(tiny.bars[0]!.rects.length, 2);
  const dense = buildChart({ series: series(Array.from({ length: 90 }, () => 1)), chart: 'bar', width: 320, height: 180 });
  assert.ok(dense.bars[0]!.rects[0]!.width >= 1.5);
});

test('veri ve genişlik yoksa geometri patlamaz', () => {
  for (const width of [0, 320]) {
    const g = buildChart({ series: [], chart: 'line', width, height: 180 });
    assert.equal(g.n, 0);
    assert.equal(g.lastIndex, -1);
    assert.deepEqual(g.xTicks, []);
    assert.equal(pickIndex(g, 'line', 100), null);
  }
  const allNull = buildChart({ series: series([null, null]), chart: 'area', width: 300, height: 180 });
  assert.equal(allNull.lastIndex, -1);
  assert.equal(allNull.lines[0]!.line, '');
  assert.equal(allNull.lines[0]!.area, '');
  assert.ok(Number.isFinite(allNull.yAt(0)));
  const single = buildChart({ series: series([5]), chart: 'line', width: 300, height: 180 });
  assert.equal(single.xTicks.length, 1);
  assert.ok(Number.isFinite(single.xAt(0)));
});

test('parmak en yakın noktaya, dışarı taşan uca oturur', () => {
  const g = { n: 5, width: 252, left: 44, right: 8 };
  assert.equal(pickIndex(g, 'line', 0), 0);
  assert.equal(pickIndex(g, 'line', 44 + 100), 2);
  assert.equal(pickIndex(g, 'line', 999), 4);
  assert.equal(pickIndex(g, 'bar', 44 + 199), 4);
  assert.equal(pickIndex(g, 'bar', 44 + 41), 1);
});

/* ── links ──────────────────────────────────────────────── */

const full = { team: true, measurements: true };

test('ölçüm adresi uygulamayı açar', () => {
  assert.deepEqual(resolveHubLink('/deciship/measurements/abc-1', full), { kind: 'app', path: APP_ROUTES.measurement('abc-1') });
  assert.deepEqual(resolveHubLink('/deciship/measurements', full), { kind: 'app', path: APP_ROUTES.measurements });
  assert.deepEqual(resolveHubLink('/data/deciship/measurements', full), { kind: 'app', path: APP_ROUTES.measurements });
  assert.deepEqual(resolveHubLink(`${WEB_ORIGIN}/deciship/measurements/abc-1`, full), { kind: 'app', path: APP_ROUTES.measurement('abc-1') });
});

test('süzgeçli liste uygulamada karşılığı olmadığından web\'e gider', () => {
  assert.deepEqual(resolveHubLink('/deciship/measurements?missingPhotos=1', full), { kind: 'web', url: `${WEB_ORIGIN}/deciship/measurements?missingPhotos=1` });
  assert.deepEqual(resolveHubLink('/deciship/invoices/ornek-9-482?status=DIFF', full), { kind: 'web', url: `${WEB_ORIGIN}/deciship/invoices/ornek-9-482?status=DIFF` });
  assert.deepEqual(resolveHubLink('/data/deciship/invoice-lines?filter.status=DIFF', full).kind, 'web');
});

test('Merkez içi adresler sekmeye; izin yoksa web', () => {
  assert.deepEqual(resolveHubLink('/account/team', full), { kind: 'app', path: '/hub/team' });
  assert.deepEqual(resolveHubLink('/home', full), { kind: 'app', path: '/hub' });
  assert.deepEqual(resolveHubLink('/activity', full), { kind: 'app', path: APP_ROUTES.activity });
  const none = { team: false, measurements: false };
  assert.equal(resolveHubLink('/account/team', none).kind, 'web');
  assert.equal(resolveHubLink('/deciship/measurements/abc', none).kind, 'web');
});

test('Analiz telefonda yok: analiz adresi her zaman web; süzgeçli etkinlik web', () => {
  assert.deepEqual(resolveHubLink('/analytics/deciship', full), { kind: 'web', url: `${WEB_ORIGIN}/analytics/deciship` });
  assert.deepEqual(resolveHubLink('/analytics', full), { kind: 'web', url: `${WEB_ORIGIN}/analytics` });
  assert.deepEqual(resolveHubLink('/activity?source=deciship', full), { kind: 'web', url: `${WEB_ORIGIN}/activity?source=deciship` });
  assert.equal(WEB_ROUTES.analytics('deciship'), '/analytics/deciship');
  assert.equal(WEB_ROUTES.activity, '/activity');
  assert.equal(WEB_ROUTES.team, '/account/team');
});

test('güvensiz adres hiçbir yere gitmez', () => {
  for (const bad of ['javascript:alert(1)', 'https://kotu.example/x', '//kotu.example/x', 'tel:+90', '/a b', '/a\\b', `${WEB_ORIGIN}.kotu.example/x`, 'deciship/invoices', '', null, undefined]) {
    assert.deepEqual(resolveHubLink(bad, full), { kind: 'none' }, String(bad));
  }
});

test('geliştirme kökü verilirse o kullanılır, kimlik kodlanır', () => {
  assert.deepEqual(resolveHubLink('/deciship/tariffs/1', full, 'http://localhost:8088'), { kind: 'web', url: 'http://localhost:8088/deciship/tariffs/1' });
  assert.deepEqual(resolveHubLink('http://localhost:8088/home', full, 'http://localhost:8088'), { kind: 'app', path: '/hub' });
  assert.deepEqual(resolveHubLink('/deciship/measurements/a%2Fb', full), { kind: 'app', path: APP_ROUTES.measurement('a/b') });
  assert.equal(resolveHubLink('/deciship/measurements/%E0%A4%A', full).kind, 'web');
});

/* ── http ───────────────────────────────────────────────── */

const res = (status: number, text: string) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

test('readJson: gövde, 204, hata şekli, bozuk JSON', async () => {
  assert.deepEqual(await readJson(res(200, '{"a":1}')), { a: 1 });
  assert.equal(await readJson(res(204, '')), undefined);
  await assert.rejects(readJson(res(403, '{"error":{"code":"NO_PRODUCT_ACCESS","message":"Yok"}}')), (e: HubApiError) => e.kind === 'forbidden' && e.code === 'NO_PRODUCT_ACCESS' && e.message === 'Yok');
  await assert.rejects(readJson(res(500, '<html>')), (e: HubApiError) => e.kind === 'server' && e.code === 'HTTP_500');
  await assert.rejects(readJson(res(200, '<html>')), (e: HubApiError) => e.code === 'BAD_JSON');
});

test('toHubError: ağ hatası türleri', () => {
  assert.equal(toHubError(new TypeError('Network request failed')).kind, 'network');
  assert.equal(toHubError({ status: 0, code: 'TIMEOUT', message: 'x' }).kind, 'network');
  assert.equal(toHubError({ status: 403, code: 'X', message: 'x' }).kind, 'forbidden');
  assert.equal(toHubError(new Error('boom')).kind, 'server');
  const same = new HubApiError(500, 'A', 'b');
  assert.equal(toHubError(same), same);
});

test('query boşları atlar, kodlar', () => {
  assert.equal(query({ from: '2026-11-01', to: undefined, compare: null }), '?from=2026-11-01');
  assert.equal(query({ a: 'x y&z' }), '?a=x%20y%26z');
  assert.equal(query({}), '');
});

/* ── cache ──────────────────────────────────────────────── */

function memoryStorage(initial: unknown = null) {
  const box = { value: initial };
  return { box, storage: { get: async () => box.value, set: async (v: unknown) => void (box.value = v) } };
}

test("bağlantı: ürün API biçimi (?id=) uygulamada açılır", () => {
  const full = { team: true, measurements: true };
  assert.deepEqual(resolveHubLink('/deciship/measurements?id=abc-1', full), { kind: 'app', path: APP_ROUTES.measurement('abc-1') });
  assert.deepEqual(resolveHubLink(`${WEB_ORIGIN}/deciship/measurements?id=a%2Fb`, full), { kind: 'app', path: APP_ROUTES.measurement('a/b') });
  // Ölçüm hakkı yoksa web'e gider; başka süzgeçle birlikteyse de.
  assert.equal(resolveHubLink('/deciship/measurements?id=abc-1', { ...full, measurements: false }).kind, 'web');
  assert.equal(resolveHubLink('/deciship/measurements?userId=u1', full).kind, 'web');
  assert.equal(resolveHubLink('/deciship/measurements?id=abc-1&x=1', full).kind, 'web');
});

test('önbellek: yaz, yeniden aç, oku; zaman korunur', async () => {
  const { box, storage } = memoryStorage();
  const c = createHubCache(storage, { now: () => 1000 });
  await c.load();
  c.bind('A', makeMe());
  assert.equal(c.write('k', { n: 1 }), 1000);
  await c.settled();
  const again = createHubCache(storage);
  await again.load();
  assert.deepEqual(again.read('k'), { at: 1000, data: { n: 1 } });
  assert.equal(again.lastMe()?.person.id, 'p-1');
  assert.ok(box.value);
});

test('önbellek: kapsam değişince hepsi silinir, aynı kapsamda kalır', async () => {
  const { storage } = memoryStorage();
  const c = createHubCache(storage);
  await c.load();
  assert.equal(c.bind('A', makeMe()), false);
  c.write('k', 1);
  assert.equal(c.bind('A', makeMe()), false);
  assert.ok(c.read('k'));
  assert.equal(c.bind('B', makeMe({ orgId: 'org-2' })), true);
  assert.equal(c.read('k'), null);
  await c.settled();
  const fresh = createHubCache(storage);
  await fresh.load();
  assert.equal(fresh.read('k'), null);
  assert.equal(fresh.lastMe()?.activeOrg?.id, 'org-2');
});

test('önbellek: clear ve drop; en eski atılır; bozuk kayıt ve depo hatası uygulamayı düşürmez', async () => {
  let t = 0;
  const { box, storage } = memoryStorage();
  const c = createHubCache(storage, { now: () => ++t, maxEntries: 2 });
  await c.load();
  c.bind('A', makeMe());
  c.write('a', 1);
  c.write('b', 2);
  c.write('c', 3);
  assert.equal(c.read('a'), null);
  assert.ok(c.read('b') && c.read('c'));
  c.drop('b');
  assert.equal(c.read('b'), null);
  await c.clear();
  assert.equal(c.read('c'), null);
  assert.equal(c.lastMe(), null);
  assert.equal(box.value, null);

  const broken = createHubCache({ get: async () => 'çöp', set: async () => Promise.reject(new Error('dolu')) });
  await broken.load();
  broken.bind('A', makeMe());
  broken.write('x', 1);
  await broken.settled();
  assert.ok(broken.read('x'));
  const fails = createHubCache({ get: async () => Promise.reject(new Error('yok')), set: async () => undefined });
  await fails.load();
  assert.equal(fails.lastMe(), null);
});

/* ── resource ───────────────────────────────────────────── */

type S = ResourceState<string>;
const reduce = (s: S, a: Parameters<typeof resourceReducer<string>>[1]) => resourceReducer<string>(s, a);
const ready = (key: string, data: string): S => reduce(reduce(emptyResource<string>(), { type: 'start', key, cached: null }), { type: 'success', key, data, at: 10 });

test('ilk yükleme, başarı, hata', () => {
  const s0 = reduce(emptyResource<string>(), { type: 'start', key: 'a', cached: null });
  assert.equal(s0.status, 'loading');
  assert.equal(ready('a', 'x').status, 'ready');
  const e = reduce(s0, { type: 'failure', key: 'a', kind: 'server' });
  assert.deepEqual([e.status, e.data, e.failed], ['error', null, 'server']);
});

test('çevrimdışı: önbellek varsa son veri ve zaman kalır', () => {
  const s = reduce(emptyResource<string>(), { type: 'start', key: 'a', cached: { at: 5, data: 'eski' } });
  assert.deepEqual([s.status, s.data, s.at, s.busy], ['ready', 'eski', 5, true]);
  const off = reduce(s, { type: 'failure', key: 'a', kind: 'network' });
  assert.deepEqual([off.status, off.data, off.at, off.failed, off.busy], ['ready', 'eski', 5, 'network', false]);
  const back = reduce(reduce(off, { type: 'start', key: 'a', cached: null }), { type: 'success', key: 'a', data: 'yeni', at: 9 });
  assert.deepEqual([back.data, back.at, back.failed], ['yeni', 9, null]);
});

test('dönem değişimi: eski veri soluk tutulur; yeni dönem düşerse eski sayı gösterilmez', () => {
  const held = reduce(ready('a', 'x'), { type: 'start', key: 'b', cached: null });
  assert.deepEqual([held.data, held.holding, held.status], ['x', true, 'ready']);
  const failed = reduce(held, { type: 'failure', key: 'b', kind: 'network' });
  assert.deepEqual([failed.status, failed.data, failed.holding], ['error', null, false]);
  const okay = reduce(held, { type: 'success', key: 'b', data: 'y', at: 20 });
  assert.deepEqual([okay.data, okay.holding], ['y', false]);
});

test('geç gelen eski yanıt yok sayılır; 403 veriyi temizler', () => {
  const held = reduce(ready('a', 'x'), { type: 'start', key: 'b', cached: null });
  assert.equal(reduce(held, { type: 'success', key: 'a', data: 'geç', at: 30 }), held);
  assert.equal(reduce(held, { type: 'failure', key: 'a', kind: 'server' }), held);
  const denied = reduce(ready('a', 'x'), { type: 'failure', key: 'a', kind: 'forbidden' });
  assert.deepEqual([denied.status, denied.data], ['forbidden', null]);
});

test('hatadan sonra yeniden deneme yükleniyora döner', () => {
  const err = reduce(reduce(emptyResource<string>(), { type: 'start', key: 'a', cached: null }), { type: 'failure', key: 'a', kind: 'server' });
  const retry = reduce(err, { type: 'start', key: 'a', cached: null });
  assert.deepEqual([retry.status, retry.failed, retry.busy], ['loading', null, true]);
});

/* ── çeviri ─────────────────────────────────────────────── */

const flat = (o: object, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));

test('TR ve EN aynı anahtarlar, boş metin yok', () => {
  const load = (l: string) => JSON.parse(readFileSync(new URL(`../../locales/${l}/hub.json`, import.meta.url), 'utf8'));
  const tr = load('tr');
  const en = load('en');
  assert.deepEqual(flat(tr).sort(), flat(en).sort());
  const values = (o: object): string[] => Object.values(o).flatMap((v) => (v && typeof v === 'object' ? values(v as object) : [String(v)]));
  assert.ok(values(tr).every((v) => v.trim()) && values(en).every((v) => v.trim()));
});

/* ── araç seçici (web Merkez ile aynı, Tümü yok) ───────── */

test('toolPickerItems: katalog sırası; yakında seçilemez, izinsiz açık araç yok, Tümü yok', () => {
  const items = toolPickerItems(['deciship']);
  assert.deepEqual(
    items.map((i) => i.key),
    ['deciship', 'orderloom', 'tagpress'],
  );
  assert.deepEqual(items[0], { key: 'deciship', state: 'pick' });
  assert.equal(items.find((i) => i.key === 'orderloom')?.state, 'soon');
  assert.equal(items.find((i) => i.key === 'tagpress')?.state, 'soon');
  // Ürün adları katalogdan: OrderLoom, TagPress.
  assert.equal(PRODUCTS.orderloom.name, 'OrderLoom');
  assert.equal(PRODUCTS.tagpress.name, 'TagPress');
});

test('toolPickerItems: me verilince sunucu durumu geçerli (launch off = yakında, launch yok = available)', () => {
  const m = makeMe();
  assert.equal(toolPickerItems(['deciship'], m).find((i) => i.key === 'deciship')?.state, 'pick');
  m.products = m.products.map((p) => (p.key === 'deciship' ? { ...p, launch: 'off' as const } : p));
  assert.equal(toolPickerItems(['deciship'], m).find((i) => i.key === 'deciship')?.state, 'soon');
  const old = makeMe();
  old.products = old.products.map((p) => { const { launch: _l, ...rest } = p; return rest; });
  assert.equal(toolPickerItems(['deciship'], old).find((i) => i.key === 'deciship')?.state, 'pick');
});

test('toolPickerItems: hiç aracı yoksa seçici yok', () => {
  assert.deepEqual(toolPickerItems([]), []);
});

test('overviewTool: seçim yoksa, izinsiz ya da bilinmeyen seçimde ilk açık araç', () => {
  assert.equal(overviewTool(null, ['deciship']), 'deciship');
  assert.equal(overviewTool(null, ['deciship', 'orderloom']), 'deciship');
  assert.equal(overviewTool('orderloom', ['deciship', 'orderloom']), 'orderloom');
  assert.equal(overviewTool('orderloom', ['deciship']), 'deciship');
  assert.equal(overviewTool('bilinmeyen' as never, ['deciship']), 'deciship');
  assert.equal(overviewTool(null, []), null);
});
