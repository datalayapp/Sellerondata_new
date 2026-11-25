import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupByDay, mergeFeeds, nextPage, readAudit, slimAudit, type AuditItem, type AuditPage } from '../activity';
import type { HubActivityPage } from '../contracts';

/** Çeviri yerine anahtarı ve değerleri yazar: hangi metnin seçildiği okunur. */
const t = (key: string, opts?: Record<string, unknown>) => {
  if (opts && 'defaultValue' in opts && key.startsWith('activity.actions.') && !KNOWN.has(key)) return String(opts.defaultValue);
  const rest = opts ? Object.entries(opts).filter(([k]) => k !== 'defaultValue').map(([k, v]) => `${k}=${v}`) : [];
  return rest.length ? `${key}(${rest.join(',')})` : key;
};
const KNOWN = new Set(['activity.actions.member.joined', 'activity.actions.member.updated', 'activity.actions.unknown']);
const orgRole = (r: string) => `rol:${r}`;

const page = (items: { id: string; at: string }[], p = 1, total = items.length, pageSize = 30): HubActivityPage => ({
  page: p,
  pageSize,
  total,
  items: items.map((i) => ({ ...i, actor: 'Ayşe', action: 'ölçtü' })),
});

test('nextPage: toplam dolana kadar bir sonraki sayfa (web getNextPageParam)', () => {
  assert.equal(nextPage({ page: 1, pageSize: 30, total: 31 }), 2);
  assert.equal(nextPage({ page: 2, pageSize: 30, total: 60 }), null);
  assert.equal(nextPage({ page: 1, pageSize: 30, total: 0 }), null);
  assert.equal(nextPage(undefined), null);
});

test('mergeFeeds: kaynaklar tek zaman çizelgesinde, yeniden eskiye, kaynak işaretli', () => {
  const items = mergeFeeds([
    { source: 'platform', pages: [page([{ id: 'p1', at: '2026-11-13T09:00:00Z' }, { id: 'p2', at: '2026-11-12T08:00:00Z' }])] },
    { source: 'deciship', pages: [page([{ id: 'd1', at: '2026-11-13T11:00:00Z' }, { id: 'd2', at: '2026-11-11T08:00:00Z' }])] },
  ]);
  assert.deepEqual(
    items.map((i) => `${i.source}:${i.id}`),
    ['deciship:d1', 'platform:p1', 'platform:p2', 'deciship:d2'],
  );
});

test('mergeFeeds: daha fazlası olan akışın son kaydından eskiler gizlenir (sıra yanıltmasın)', () => {
  const items = mergeFeeds([
    // Hesap akışında daha çok kayıt var; yüklenen son kayıt 12 Kasım.
    { source: 'platform', pages: [page([{ id: 'p1', at: '2026-11-13T09:00:00Z' }, { id: 'p2', at: '2026-11-12T08:00:00Z' }], 1, 40, 2)] },
    { source: 'deciship', pages: [page([{ id: 'd1', at: '2026-11-13T11:00:00Z' }, { id: 'd2', at: '2026-11-01T08:00:00Z' }])] },
  ]);
  assert.deepEqual(
    items.map((i) => i.id),
    ['d1', 'p1', 'p2'],
  );
  // İkinci sayfa yüklenince aralık genişler.
  const wider = mergeFeeds([
    {
      source: 'platform',
      pages: [page([{ id: 'p1', at: '2026-11-13T09:00:00Z' }, { id: 'p2', at: '2026-11-12T08:00:00Z' }], 1, 4, 2), page([{ id: 'p3', at: '2026-10-30T08:00:00Z' }, { id: 'p4', at: '2026-10-29T08:00:00Z' }], 2, 4, 2)],
    },
    { source: 'deciship', pages: [page([{ id: 'd1', at: '2026-11-13T11:00:00Z' }, { id: 'd2', at: '2026-11-01T08:00:00Z' }])] },
  ]);
  assert.deepEqual(
    wider.map((i) => i.id),
    ['d1', 'p1', 'p2', 'd2', 'p3', 'p4'],
  );
  assert.deepEqual(mergeFeeds([]), []);
});

test('groupByDay: ardışık aynı gün tek grup; gün anahtarını çağıran verir', () => {
  const items = mergeFeeds([
    {
      source: 'deciship',
      pages: [page([{ id: 'a', at: '2026-11-13T21:30:00Z' }, { id: 'b', at: '2026-11-13T08:00:00Z' }, { id: 'c', at: '2026-11-12T23:00:00Z' }, { id: 'd', at: '2026-11-10T09:00:00Z' }])],
    },
  ]);
  const utcDay = (iso: string) => iso.slice(0, 10);
  assert.deepEqual(
    groupByDay(items, utcDay).map((g) => [g.day, g.items.map((i) => i.id)]),
    [
      ['2026-11-13', ['a', 'b']],
      ['2026-11-12', ['c']],
      ['2026-11-10', ['d']],
    ],
  );
  // İstanbul (UTC+3): 13 Kasım 21:30 UTC ertesi güne, 12 Kasım 23:00 UTC 13 Kasım'a düşer.
  const istanbul = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  assert.deepEqual(
    groupByDay(items, istanbul).map((g) => [g.day, g.items.map((i) => i.id)]),
    [
      ['2026-11-14', ['a']],
      ['2026-11-13', ['b', 'c']],
      ['2026-11-10', ['d']],
    ],
  );
  assert.deepEqual(groupByDay([], utcDay), []);
});

const audit = (over: Partial<AuditItem>): AuditItem => ({ id: 'x', at: '2026-11-13T09:00:00Z', actor: 'Selin', action: 'member.joined', target: null, ...over });

test('readAudit: eylem çeviriden, bilinmeyen eylem sunucu etiketinden, o da yoksa genel metin', () => {
  assert.equal(readAudit(audit({}), t, 'tr', orgRole).action, 'activity.actions.member.joined');
  assert.equal(readAudit(audit({ action: 'yeni.olay', label: 'Yeni olay' }), t, 'tr', orgRole).action, 'Yeni olay');
  assert.equal(readAudit(audit({ action: 'yeni.olay' }), t, 'tr', orgRole).action, 'activity.actions.unknown');
});

test('readAudit: üyelik değişikliği neyin değiştiğini söyler; hedef adı sunucudan', () => {
  const item = audit({
    action: 'member.updated',
    targetName: 'Mehmet Kaya',
    details: {
      changes: [
        { field: 'orgRole', from: 'MEMBER', to: 'ADMIN' },
        { field: 'productRole', product: 'deciship', from: 'MEASURE', to: 'ACCOUNTING' },
        { field: 'productRole', product: 'deciship', from: 'MEASURE', to: null },
        { field: 'status', from: 'ACTIVE', to: 'SUSPENDED' },
      ],
    },
  });
  const r = readAudit(item, t, 'tr', orgRole);
  assert.equal(r.action, 'activity.member.orgRole(role=rol:ADMIN), activity.member.toolRole(tool=DeciShip,role=Muhasebe), activity.member.noAccess(tool=DeciShip), activity.member.suspended');
  assert.equal(r.target, 'Mehmet Kaya');
  assert.equal(readAudit(audit({ action: 'member.updated' }), t, 'tr', orgRole).action, 'activity.actions.member.updated');
  // Çıkarılan üyenin adı ayrıntıda.
  assert.equal(readAudit(audit({ action: 'member.removed', details: { name: 'Eski Çalışan' } }), t, 'tr', orgRole).target, 'Eski Çalışan');
  assert.equal('target' in readAudit(audit({}), t, 'tr', orgRole), false);
});

test('slimAudit: cihaza yalnız ekranın okuduğu alanlar iner', () => {
  const raw: AuditPage = {
    page: 1,
    pageSize: 30,
    total: 1,
    items: [audit({ details: { changes: [{ field: 'status', from: 'ACTIVE', to: 'SUSPENDED' }], operator: 'destek', reason: 'gizli' }, meta: { operator: 'destek' }, label: 'Üyelik güncellendi' })],
  };
  const slim = slimAudit(raw);
  assert.deepEqual(slim.items[0]!.details, { changes: [{ field: 'status', from: 'ACTIVE', to: 'SUSPENDED' }] });
  assert.equal('meta' in slim.items[0]!, false);
  assert.equal(slim.items[0]!.label, 'Üyelik güncellendi');
  assert.deepEqual([slim.page, slim.pageSize, slim.total], [1, 30, 1]);
  assert.equal(slimAudit({ ...raw, items: [audit({ details: { operator: 'x' } })] }).items[0]!.details, null);
});
