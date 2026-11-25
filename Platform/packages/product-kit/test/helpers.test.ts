import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bucketize,
  csvHeader,
  csvRows,
  isTimeZone,
  KitError,
  makePeriod,
  memberProjectionSql,
  parsePeriod,
  PROCESSED_EVENT_TTL_DAYS,
  PROCESSED_EVENT_TTL_MS,
  previousPeriod,
  queryInt,
  validDay,
  zonedDate,
} from '../src/index.ts';

const ctx = (now: string, timeZone = 'Europe/Istanbul') => ({ now: new Date(now), locale: 'tr' as const, timeZone });

describe('dönem', () => {
  it('validDay takvim dışını ve yıl sınırını reddeder', () => {
    expect(validDay('2026-02-28')).toBe(true);
    for (const bad of ['2026-02-30', '2026-2-01', '1999-12-31', '3000-01-01', 20260101, null]) expect(validDay(bad)).toBe(false);
  });

  it('varsayılan: firmanın gününe göre son 30 gün', () => {
    // UTC 22:30, İstanbul'da ertesi gün.
    const p = parsePeriod({}, ctx('2026-10-31T22:30:00Z'));
    expect([p.from, p.to, p.days]).toEqual(['2026-10-03', '2026-11-01', 30]);
    expect(parsePeriod({}, ctx('2026-10-31T22:30:00Z', 'UTC')).to).toBe('2026-10-31');
  });

  it('hatalar 400 VALIDATION', () => {
    for (const q of [{ from: 'x' }, { from: '2026-10-05', to: '2026-10-01' }, { from: '2020-01-01', to: '2026-01-01' }]) {
      try {
        parsePeriod(q, ctx('2026-10-31T00:00:00Z'));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(KitError);
        expect((e as KitError).status).toBe(400);
        expect((e as KitError).code).toBe('VALIDATION');
      }
    }
  });

  it('önceki dönem ve aralıklar', () => {
    const p = makePeriod('2026-10-01', '2026-10-10');
    expect(previousPeriod(p)).toMatchObject({ from: '2026-09-21', to: '2026-09-30', days: 10 });
    expect(p.end.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    const pts = bucketize(p, () => 1, { cumulative: true, today: '2026-10-08' });
    expect(pts.map((x) => x.y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, null, null]);
    expect(bucketize(makePeriod('2026-01-01', '2026-04-30'), () => 1)).toHaveLength(18);
  });

  it('saat dilimi ve gün', () => {
    expect(isTimeZone('Europe/Istanbul')).toBe(true);
    expect(isTimeZone('+03:00')).toBe(false);
    expect(zonedDate(new Date('2026-10-31T21:00:00Z'), 'Europe/Istanbul')).toBe('2026-11-01');
  });

  it('queryInt yalnız pozitif tam sayı', () => {
    expect(queryInt(undefined, 1, 'page', 'tr')).toBe(1);
    expect(queryInt('7', 1, 'page', 'tr')).toBe(7);
    for (const bad of ['0', '-1', '1e3', 'Infinity', '1.5', '1234567890']) expect(() => queryInt(bad, 1, 'page', 'en')).toThrow(/Invalid filter value: page/);
  });
});

describe('CSV', () => {
  const cols = [
    { id: 'a', label: 'Ad', format: 'text' as const },
    { id: 'b', label: '@Tutar', format: 'money' as const },
  ];
  it('Türkçe: ; ve virgül; İngilizce: , ve nokta', () => {
    expect(csvHeader(cols, 'tr')).toBe("\uFEFFAd;'@Tutar\r\n");
    expect(csvRows(cols, [{ id: '1', cells: { a: 'x', b: 1.5 } }], 'tr')).toBe('x;1,50\r\n');
    expect(csvRows(cols, [{ id: '1', cells: { a: 'x,y', b: 1.5 } }], 'en')).toBe('"x,y",1.50\r\n');
  });
  it('formül, satır sonu ve tırnak', () => {
    expect(csvRows(cols, [{ id: '1', cells: { a: '  +cmd', b: null } }], 'tr')).toBe("'  +cmd;\r\n");
    expect(csvRows(cols, [{ id: '1', cells: { a: 'a"b\nc', b: 0 } }], 'tr')).toBe('"a""b\nc";0,00\r\n');
    expect(csvRows(cols, [{ id: '1', cells: { a: '＝1', b: 2 } }], 'tr')).toBe("'＝1;2,00\r\n");
  });
});

describe('memberProjectionSql', () => {
  it('her tablo FORCE RLS; uygulama rolüne silme Company ve Member (kalıcı firma silmesi) ve süresi dolan olay kimliğinde', () => {
    const sql = memberProjectionSql({ schema: 'orderloom', appRole: 'sod_orderloom' });
    for (const t of ['Company', 'Member', 'ProcessedEvent', 'CompanyPurge']) {
      expect(sql).toContain(`ALTER TABLE "orderloom"."${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "orderloom"."${t}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain(`current_setting('app.org_id', true)`);
    expect(sql).toContain(`current_setting('app.scope', true) = 'events'`);
    expect(sql).not.toMatch(/TRUNCATE/);
    // init.sql'in varsayılan hakları önce geri alınır; şablon yalnız gerekeni verir
    expect(sql).toContain(`REVOKE ALL ON "orderloom"."Company", "orderloom"."Member", "orderloom"."ProcessedEvent", "orderloom"."CompanyPurge" FROM "sod_orderloom";`);
    expect(sql.indexOf('REVOKE ALL')).toBeLessThan(sql.indexOf('GRANT SELECT'));
    // firmayı kapatma (org.purged): firma verisinde silme yalnız firma ve üye izdüşümünde; silme kaydı silinemez.
    // Olay kimliği yalnız bakım kapsamında ve süresi dolunca silinir (tek DELETE ilkesi).
    expect(sql.match(/DELETE/g)).toHaveLength(3);
    expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON "orderloom"."Company", "orderloom"."Member" TO "sod_orderloom";`);
    expect(sql).toContain(`GRANT SELECT, INSERT, DELETE ON "orderloom"."ProcessedEvent" TO "sod_orderloom";`);
    expect(sql).toContain(`GRANT SELECT, INSERT ON "orderloom"."CompanyPurge" TO "sod_orderloom";`);
    expect(sql).toContain(`CREATE POLICY maintenance_expired_delete ON "orderloom"."ProcessedEvent" FOR DELETE
  USING (current_setting('app.scope', true) = 'maintenance' AND "processedAt" < now() - interval '30 days');`);
    expect(sql).toContain(`CREATE POLICY maintenance_expired_read ON "orderloom"."ProcessedEvent" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "processedAt" < now() - interval '30 days');`);
    // olay kapsamı okur ve ekler, silemez: olay kimliğinde genel (ALL) ilke yok
    const eventPolicies = sql.match(/CREATE POLICY \w+ ON "orderloom"\."ProcessedEvent"[^;]*;/g) ?? [];
    expect(eventPolicies).toHaveLength(4);
    expect(eventPolicies.some((p) => !/ FOR (SELECT|INSERT|DELETE)\b/.test(p))).toBe(false);
    expect(eventPolicies.filter((p) => / FOR DELETE\b/.test(p)).every((p) => p.includes("= 'maintenance'"))).toBe(true);
    // şema init.sql / upgrade.sql'in işi: göçte CREATE SCHEMA yasak (products-lists.mjs)
    expect(sql).not.toMatch(/CREATE\s+SCHEMA/i);
    // silme kaydında yalnız bitiş anı güncellenir; bakım kapsamı yalnız bitmemiş kayıtları okur
    expect(sql).toContain(`GRANT UPDATE ("completedAt") ON "orderloom"."CompanyPurge" TO "sod_orderloom";`);
    expect(sql.match(/GRANT UPDATE/g)).toHaveLength(1);
    expect(sql).toContain(`CREATE POLICY maintenance_purge_read ON "orderloom"."CompanyPurge" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance' AND "completedAt" IS NULL);`);
    // silme kaydı: ekleme yalnız olay kapsamında, güncelleme yalnız bitmemişi bitmiş yapar; genel (ALL) ilke yok
    const purgePolicies = sql.match(/CREATE POLICY \w+ ON "orderloom"\."CompanyPurge"[^;]*;/g) ?? [];
    expect(purgePolicies.some((p) => !/ FOR (SELECT|INSERT|UPDATE)\b/.test(p))).toBe(false);
    expect(sql).toContain(`CREATE POLICY event_insert ON "orderloom"."CompanyPurge" FOR INSERT
  WITH CHECK ("orgId" = current_setting('app.org_id', true) AND current_setting('app.scope', true) = 'events' AND "completedAt" IS NULL);`);
    expect(sql).toContain(`CREATE POLICY purge_complete ON "orderloom"."CompanyPurge" FOR UPDATE
  USING ("orgId" = current_setting('app.org_id', true) AND "completedAt" IS NULL)
  WITH CHECK ("orgId" = current_setting('app.org_id', true) AND "completedAt" IS NOT NULL);`);
  });

  it('firma saat dilimi ve Merkez onayı sütunları; yeni firma onaysız açılır; üyeye bileşik anahtar', () => {
    const sql = memberProjectionSql({ schema: 'orderloom', appRole: 'sod_orderloom' });
    expect(sql).toContain(`"timeZone" text,`);
    expect(sql).toContain(`"companyConfirmed" boolean NOT NULL DEFAULT false,`);
    expect(sql).toContain(`CONSTRAINT "Member_id_orgId_key" UNIQUE ("id", "orgId")`);
    expect(sql).toContain(`"completedAt" timestamptz`);
  });

  it('adlar SQL tanımlayıcısı olarak denetlenir', () => {
    expect(() => memberProjectionSql({ schema: 'ornek-arac', appRole: 'r' })).toThrow(/geçersiz SQL adı/);
    expect(() => memberProjectionSql({ schema: 's', appRole: 'x"; DROP ROLE y; --' })).toThrow(/geçersiz SQL adı/);
  });

  it('fikstür göçü bloğu birebir içerir (göçe yapıştırılan metin değişmedi); süre sabiti DeciShip ile aynı', () => {
    expect(PROCESSED_EVENT_TTL_DAYS).toBe(30);
    expect(PROCESSED_EVENT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const migration = readFileSync(new URL('./ornekarac/migration.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(migration.startsWith(memberProjectionSql({ schema: 'ornekarac', appRole: 'sod_ornekarac' }))).toBe(true);
  });
});
