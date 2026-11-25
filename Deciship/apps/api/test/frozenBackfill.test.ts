import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { schemaProblems } from '../src/lib/schemaCheck.ts';
import { readSettings } from '../src/lib/settings.ts';
import { invoiceTariff, type TariffWithRelations } from '../src/services/compare.ts';
import { serializeTariffFull, tariffBody, tariffSnapshot } from '../src/services/tariffs.ts';
import { dbSetupSection } from './globalSetup.ts';
import { SUPER_URL, TEST_ADMIN_URL, TEST_DB_NAME } from './testEnv.ts';

/**
 * Mesaj 4, Adım 0: 20261111120000_frozen_results göçünün dolu hacimdeki davranışı. Eski şemayla veri kurulur, göç sahibin
 * (sod_deciship_admin) eliyle uygulanır, sonuç uygulamanın kendi işlevleriyle (tariffSnapshot, invoiceTariff, readSettings)
 * karşılaştırılır: SQL'deki kural koddaki kuraldan saparsa test kırılır.
 */
const DIR = path.resolve(import.meta.dirname, '../prisma/migrations');
const MIGRATION = 'frozen_results';

const dbUrl = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};
/**
 * Ambalaj göçü öncesi biçim: okurken eklenen varsayılanlar (satırda `packaging: 'OWN'`, boş `pakDiscountPct` /
 * `envelopeDiscountPct`) çıkarılır; OWN dışı ambalaj ya da dolu indirim kalır (bu göçün verisinde yoktur, olursa fark görünür).
 */
function prePackaging<T extends { rates?: { packaging?: string }[]; pakDiscountPct?: unknown; envelopeDiscountPct?: unknown }>(s: T): T {
  const out: Record<string, unknown> = { ...s };
  if (out.pakDiscountPct == null) delete out.pakDiscountPct;
  if (out.envelopeDiscountPct == null) delete out.envelopeDiscountPct;
  if (Array.isArray(s.rates)) out.rates = s.rates.map(({ packaging, ...r }) => (packaging == null || packaging === 'OWN' ? r : { ...r, packaging }));
  return out as T;
}

const sqlOf = (dir: string) => fs.readFileSync(path.join(DIR, dir, 'migration.sql'), 'utf8');

type Row = Record<string, unknown>;

describe('Mesaj 4 göçü: dolu hacimde backfill', () => {
  it('tarife sürümü canlı tarifeyle aynı içerikte; fatura, satır ve ayar bugünkü hesabın dayanağına bağlanır; anahtarlar ve RLS yerinde', async () => {
    const dirs = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'migration.sql'))).sort();
    const target = dirs.find((d) => d.endsWith(MIGRATION));
    expect(target, 'göç dosyası').toBeTruthy();
    const before = dirs.slice(0, dirs.indexOf(target!));
    const later = dirs.slice(dirs.indexOf(target!) + 1);

    const name = `${TEST_DB_NAME}_frozen`;
    const root = new pg.Client({ connectionString: SUPER_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.query(`CREATE DATABASE "${name}"`);
    const sup = new pg.Client({ connectionString: dbUrl(SUPER_URL, name), options: '-c search_path=deciship -c TimeZone=UTC' });
    const owner = new pg.Client({ connectionString: dbUrl(TEST_ADMIN_URL, name), options: '-c TimeZone=UTC' });
    await sup.connect();
    await owner.connect();
    const rows = (sql: string, params: unknown[] = []) => sup.query(sql, params).then((r) => r.rows as Row[]);
    try {
      await sup.query(dbSetupSection());
      for (const d of before) await owner.query(sqlOf(d));

      // ---------- eski şemada veri ----------
      await sup.query(`
        INSERT INTO "Company"(id, name, settings, "updatedAt") VALUES
          ('c1', 'A', '{"edgeTolCm": 2, "amountTol": 7.5, "unknownSurchargesAsDiff": true, "currency": "usd", "desiDivisor": 5000}', now()),
          ('c2', 'B', '{}', now()),
          ('c3', 'C', '{"unknownSurchargesAsDiff": "evet", "weightTolKg": 0.25, "fxTolerancePct": 3}', now());
        INSERT INTO "Member"(id, "companyId", "personId", name, role, "updatedAt") VALUES ('m1','c1','p1','X','ADMIN',now()), ('m2','c2','p2','Y','ADMIN',now());
        INSERT INTO "Carrier"(id, "companyId", code, name, "updatedAt") VALUES
          ('k1','c1','fedex','F',now()), ('k1b','c1','ups','U',now()), ('k2','c2','aras','A',now()), ('k3','c3','mng','M',now());
        INSERT INTO "File"(id, "companyId", kind, mime, size, path, sha256, "createdById", "updatedAt") VALUES
          ('f1','c1','INVOICE_SOURCE','text/csv',1,'p','s','m1',now()), ('f2','c2','INVOICE_SOURCE','text/csv',1,'p','s','m2',now());

        INSERT INTO "Tariff"(id, "companyId", "carrierId", name, service, currency, divisor, "edgeRounding", "weightSteps", "discountPct", "fuelPct", "fuelVariable",
                             "validFrom", "validTo", active, "isDefault", "countryAdjustments", "updatedAt") VALUES
          -- dolu tarife: taşıyıcının varsayılanı (güncellenme tarihi en eski olsa da)
          ('tA','c1','k1','Dolu Tarife','Express','EUR',5000,'NONE','[{"upto": 10, "step": 0.5, "fazla": 1}, {"upto": null, "step": 1}]',15.50,12.00,true,
           '2026-01-01','2026-12-31',true,true,
           '[{"country": "de", "pct": -15.45, "note": " not ", "source": "invoice", "invoiceId": "i1"}, {"country": "FR", "pct": 10},
             {"country": "IT", "pct": 5, "note": null}, {"country": "XXX", "pct": 1}, {"country": "ES", "pct": 500}, {"country": "NL", "pct": "3"}, "bozuk"]',
           '2026-01-01 10:00'),
          -- yalın tarife: alt satır yok, ağırlık basamakları dizi değil
          ('tB','c1','k1','Yalın',NULL,'TRY',3000,'CEIL_CM','{}',0,0,false,NULL,NULL,true,false,'[]','2026-06-01 10:00'),
          ('tC','c1','k1','Etkin değil',NULL,'TRY',3000,'CEIL_CM','[]',0,0,false,NULL,NULL,false,false,'[]','2026-07-01 10:00'),
          -- bu taşıyıcının etkin tarifesi yok
          ('tD','c1','k1b','Öbür taşıyıcı, kapalı',NULL,'USD',5000,'CEIL_CM','[]',0,0,true,NULL,NULL,false,true,'[]','2026-07-01 10:00'),
          -- varsayılan işaretli yok: en son güncellenen etkin tarife (tF)
          ('tE','c2','k2','Eski',NULL,'TRY',3000,'CEIL_CM','[]',0,0,false,NULL,NULL,true,false,'[]','2026-02-01 10:00'),
          ('tF','c2','k2','Yeni',NULL,'TRY',3000,'CEIL_CM','[]',0,0,false,NULL,NULL,true,false,'[]','2026-03-01 10:00'),
          ('tG','c2','k2','En yeni ama kapalı',NULL,'TRY',3000,'CEIL_CM','[]',0,0,false,NULL,NULL,false,true,'[]','2026-04-01 10:00'),
          ('tH','c3','k3','Üyesiz firma',NULL,'TRY',3000,'CEIL_CM','[]',0,0,false,NULL,NULL,true,true,'[]','2026-04-01 10:00');

        INSERT INTO "TariffZone"(id, "companyId", "tariffId", country, zone, "updatedAt") VALUES
          ('z1','c1','tA','FR','2',now()), ('z2','c1','tA','DE','1',now()), ('z3','c1','tA','*','10',now()), ('z4','c1','tA','AT','A',now());
        INSERT INTO "TariffRate"(id, "companyId", "tariffId", zone, "weightUpto", price, "perKg", "updatedAt") VALUES
          ('r1','c1','tA','2',5,40.00,false,now()), ('r2','c1','tA','1',10.5,25.50,false,now()), ('r3','c1','tA','1',1,12.25,false,now()),
          ('r4','c1','tA','10',99999,3.10,true,now()), ('r5','c1','tA','A',0.5,7,false,now()), ('r6','c1','tA','1',30,1.75,true,now());
        INSERT INTO "TariffOverflow"(id, "companyId", "tariffId", zone, "perUnit", "updatedAt") VALUES ('o1','c1','tA','2',4.50,now()), ('o2','c1','tA','1',3.00,now());
        INSERT INTO "TariffSurcharge"(id, "companyId", "tariffId", code, name, kind, amount, "updatedAt") VALUES
          ('s1','c1','tA','RES','Konut teslim','FIXED',45.00,now()), ('s2','c1','tA','FUEL','','PCT',12.5,now()), ('s3','c1','tA','AHS','Elle taşıma','PER_KG',-1.20,now());

        INSERT INTO "Invoice"(id, "companyId", "carrierId", "tariffId", "invoiceNo", "invoiceDate", currency, "sourceFileId", mapping, totals, "isSample", "deletedAt", "updatedAt") VALUES
          ('i1','c1','k1','tB', 'N1','2026-10-15','TRY','f1','{}','{}',false,NULL,'2026-10-20 08:00'),  -- seçili tarife
          ('i2','c1','k1',NULL, 'N2','2026-10-15','TRY','f1','{}','{}',false,NULL,'2026-10-20 08:00'),  -- seçim yok: varsayılan (tA)
          ('i3','c1','k1','tC', 'N3','2026-10-15','TRY','f1','{}','{}',false,NULL,'2026-10-20 08:00'),  -- seçili tarife kapalı: yine o
          ('i4','c1','k1b',NULL,'N4','2026-10-15','TRY','f1','{}','{}',false,NULL,'2026-10-20 08:00'),  -- etkin tarife yok: dayanaksız
          ('i5','c1','k1','tD', 'N5','2026-10-15','TRY','f1','{}','{}',false,NULL,'2026-10-20 08:00'),  -- başka taşıyıcının tarifesi: varsayılan (tA)
          ('i6','c2','k2',NULL, 'N6','2026-10-15','TRY','f2','{}','{}',false,NULL,'2026-10-20 08:00'),  -- varsayılan işaretli yok: tF
          ('i7','c2','k2','tE', 'N7','2026-10-15','TRY','f2','{}','{}',true,'2026-10-21 08:00','2026-10-21 08:00');  -- silinmiş örnek fatura da dolar

        INSERT INTO "InvoiceLine"(id, "invoiceId", "companyId", "rowIndex", "trackingNo", surcharges, "netAmount", "rawHash", "tariffId", status, "diffTypes", breakdown, "updatedAt") VALUES
          ('l1','i2','c1',1,'T1','[]',10,'h1','tA','MATCH','{}','{}','2026-10-20 08:00'),
          ('l2','i2','c1',2,'T2','[]',10,'h2','tA','NO_TARIFF','{}','{}','2026-10-20 08:00'),   -- tarifesiz sonuç: boş
          ('l3','i2','c1',3,'T3','[]',10,'h3',NULL,'UNMATCHED','{}','{}','2026-10-20 08:00'),   -- tarifesi silinmiş: boş
          ('l4','i2','c1',4,'T4','[]',10,'h4','tB','DIFF','{}','{}','2026-10-20 08:00'),        -- eski tarifeyle hesaplı kalmış satır: kendi tarifesi
          ('l5','i6','c2',1,'T5','[]',10,'h5','tF','UNMATCHED','{}','{}','2026-10-20 08:00');
      `);
      const stamps = () =>
        rows(`SELECT 'Tariff' AS t, id, "updatedAt"::text AS u FROM "Tariff" UNION ALL SELECT 'Invoice', id, "updatedAt"::text FROM "Invoice"
              UNION ALL SELECT 'InvoiceLine', id, "updatedAt"::text FROM "InvoiceLine" ORDER BY 1, 2`);
      const stampsBefore = await stamps();

      // ---------- göç: sahibin eliyle, firma bağlamı olmadan ----------
      await owner.query(sqlOf(target!));
      expect(await stamps(), 'backfill updatedAt değiştirmez').toEqual(stampsBefore);

      // ---------- 1) her tarifeye bir sürüm; içerik canlı tarifeyle aynı ----------
      const tariffRows = await rows(
        `SELECT t.*, t."validFrom" AT TIME ZONE 'UTC' AS vf, t."validTo" AT TIME ZONE 'UTC' AS vt, t."updatedAt" AT TIME ZONE 'UTC' AS ua FROM "Tariff" t ORDER BY t.ctid`,
      );
      const child = async (table: string, tariffId: string) => rows(`SELECT * FROM "${table}" WHERE "tariffId" = $1 ORDER BY ctid`, [tariffId]);
      const live: TariffWithRelations[] = [];
      for (const t of tariffRows) {
        live.push({
          ...t,
          validFrom: t.vf,
          validTo: t.vt,
          updatedAt: t.ua,
          zones: await child('TariffZone', t.id as string),
          rates: await child('TariffRate', t.id as string),
          overflow: await child('TariffOverflow', t.id as string),
          surcharges: await child('TariffSurcharge', t.id as string),
        } as never);
      }
      const revisions = await rows(`SELECT * FROM "TariffRevision"`);
      expect(revisions).toHaveLength(live.length);
      const revisionOfTariff = new Map(revisions.map((r) => [r.tariffId as string, r]));
      for (const t of live) {
        const r = revisionOfTariff.get(t.id)!;
        expect(r, t.id).toBeTruthy();
        expect(r, t.id).toMatchObject({ companyId: t.companyId, tariffName: t.name, contentHash: null, currency: t.currency });
        expect(t.currentRevisionId, t.id).toBe(r.id);
        // sürüm tariffBody'den geçer ve geçerken değişmez (zaten kanonik); uygulamanın ürettiği anlık görüntüyle birebir aynı
        // ambalaj göçünden (20261201090000) sonraki varsayılanlar (satırda packaging 'OWN', boş Pak / Zarf indirimi) bu
        // göçün yazdığı anlık görüntüde yoktur; okurken eklenir, özet değişmez (`tariffPackaging.test.ts`)
        expect(prePackaging(tariffBody.parse(r.snapshot)), t.id).toStrictEqual(r.snapshot);
        expect(r.snapshot, t.id).toStrictEqual(prePackaging(JSON.parse(JSON.stringify(tariffSnapshot(serializeTariffFull(t))))));
      }
      // elle yazılmış beklenti: sayı ve gün biçimi, sıralama, bozuk istisnaların atılması
      expect(revisionOfTariff.get('tA')!.snapshot).toStrictEqual({
        carrierId: 'k1',
        name: 'Dolu Tarife',
        service: 'Express',
        currency: 'EUR',
        divisor: 5000,
        edgeRounding: 'NONE',
        weightSteps: [{ upto: 10, step: 0.5 }, { upto: null, step: 1 }],
        discountPct: 15.5,
        fuelPct: 12,
        fuelVariable: true,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        active: true,
        isDefault: true,
        zones: [{ country: '*', zone: '10' }, { country: 'AT', zone: 'A' }, { country: 'DE', zone: '1' }, { country: 'FR', zone: '2' }],
        rates: [
          { zone: '1', weightUpto: 1, price: 12.25, perKg: false },
          { zone: '1', weightUpto: 10.5, price: 25.5, perKg: false },
          { zone: '1', weightUpto: 30, price: 1.75, perKg: true },
          { zone: '10', weightUpto: 99999, price: 3.1, perKg: true },
          { zone: '2', weightUpto: 5, price: 40, perKg: false },
          { zone: 'A', weightUpto: 0.5, price: 7, perKg: false },
        ],
        overflow: [{ zone: '2', perUnit: 4.5 }, { zone: '1', perUnit: 3 }],
        surcharges: [
          { code: 'RES', name: 'Konut teslim', kind: 'FIXED', amount: 45 },
          { code: 'FUEL', name: '', kind: 'PCT', amount: 12.5 },
          { code: 'AHS', name: 'Elle taşıma', kind: 'PER_KG', amount: -1.2 },
        ],
        countryAdjustments: [
          { country: 'DE', pct: -15.45, note: 'not', source: 'invoice', invoiceId: 'i1' },
          { country: 'FR', pct: 10, source: 'manual' },
          { country: 'IT', pct: 5, note: null, source: 'manual' },
        ],
      });
      expect(revisionOfTariff.get('tB')!.snapshot).toMatchObject({ service: null, weightSteps: [], validFrom: null, validTo: null, zones: [], rates: [], overflow: [], surcharges: [], countryAdjustments: [] });

      // ---------- 2) fatura: bugünkü hesabın kullandığı tarife (invoiceTariff) ve bugünkü ayar ----------
      const invoices = await rows(`SELECT id, "companyId", "carrierId", "tariffId", "tariffRevisionId", "compareSettings" FROM "Invoice" ORDER BY id`);
      const companies = new Map((await rows(`SELECT id, settings FROM "Company"`)).map((c) => [c.id as string, c.settings]));
      const picked: Record<string, string | null> = {};
      for (const inv of invoices) {
        const tariffs = live.filter((t) => t.companyId === inv.companyId && t.carrierId === inv.carrierId);
        const expected = invoiceTariff({ tariffs, fixedTariffId: inv.tariffId as string | null });
        expect(inv.tariffRevisionId, inv.id as string).toBe(expected ? revisionOfTariff.get(expected.id)!.id : null);
        picked[inv.id as string] = expected?.id ?? null;
        const s = readSettings(companies.get(inv.companyId as string));
        expect(inv.compareSettings, inv.id as string).toStrictEqual({
          edgeTolCm: s.edgeTolCm,
          weightTolKg: s.weightTolKg,
          amountTol: s.amountTol,
          fxTolerancePct: s.fxTolerancePct,
          unknownSurchargesAsDiff: s.unknownSurchargesAsDiff === true,
          companyCurrency: s.currency.toUpperCase(),
        });
      }
      // kuralın kendisi de elle: test, koddaki kural değişirse sessizce onu izlemesin
      expect(picked).toEqual({ i1: 'tB', i2: 'tA', i3: 'tC', i4: null, i5: 'tA', i6: 'tF', i7: 'tE' });
      expect(invoices.find((i) => i.id === 'i1')!.compareSettings).toEqual({ edgeTolCm: 2, weightTolKg: 0.1, amountTol: 7.5, fxTolerancePct: 1.5, unknownSurchargesAsDiff: true, companyCurrency: 'USD' });
      expect(invoices.find((i) => i.id === 'i6')!.compareSettings).toEqual({ edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1.5, unknownSurchargesAsDiff: false, companyCurrency: 'TRY' });

      // ---------- 3) satır: hesaplandığı tarifenin sürümü; tarifesiz sonuç ve tarifesi silinmiş satır boş ----------
      const lines = await rows(`SELECT id, "tariffRevisionId", "prevResult", "recalcPending", "recalcPendingAt" FROM "InvoiceLine" ORDER BY id`);
      const rev = (tariffId: string) => revisionOfTariff.get(tariffId)!.id;
      expect(Object.fromEntries(lines.map((l) => [l.id, l.tariffRevisionId]))).toEqual({ l1: rev('tA'), l2: null, l3: null, l4: rev('tB'), l5: rev('tF') });
      expect(lines.every((l) => l.prevResult === null && l.recalcPending === null && l.recalcPendingAt === null)).toBe(true);

      // ---------- RLS: göç bittiğinde her tabloda yeniden zorunlu; sahip bağlamsız hiçbir şey görmez ----------
      const rls = await rows(`
        SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'deciship' AND c.relkind = 'r'`);
      for (const t of rls) expect(t, t.name as string).toMatchObject({ rls: true, force: true });
      expect(rls.find((t) => t.name === 'TariffRevision')).toMatchObject({ policies: 1 });
      for (const t of ['TariffRevision', 'Tariff', 'Invoice', 'InvoiceLine', 'Company']) {
        expect((await owner.query(`SELECT count(*)::int AS n FROM "deciship"."${t}"`)).rows[0].n, t).toBe(0);
      }

      // ---------- anahtarlar ----------
      // kullanılan sürüm silinemez; başka firmanın sürümü bağlanamaz
      await expect(sup.query(`DELETE FROM "TariffRevision" WHERE id = $1`, [rev('tA')])).rejects.toMatchObject({ code: '23503' });
      await expect(sup.query(`UPDATE "Invoice" SET "tariffRevisionId" = $1 WHERE id = 'i1'`, [rev('tF')])).rejects.toMatchObject({ code: '23503' });
      await expect(sup.query(`UPDATE "InvoiceLine" SET "tariffRevisionId" = $1 WHERE id = 'l1'`, [rev('tF')])).rejects.toMatchObject({ code: '23503' });
      await expect(sup.query(`UPDATE "Tariff" SET "currentRevisionId" = $1 WHERE id = 'tA'`, [rev('tF')])).rejects.toMatchObject({ code: '23503' });
      // tarife silinince: sürüm durur (yalnız tariffId boşalır), fatura ve satır aynı sürümde kalır
      await sup.query(`DELETE FROM "Tariff" WHERE id = 'tB'`);
      expect(await rows(`SELECT "companyId", "tariffId", "tariffName" FROM "TariffRevision" WHERE id = $1`, [rev('tB')])).toEqual([{ companyId: 'c1', tariffId: null, tariffName: 'Yalın' }]);
      expect(await rows(`SELECT "tariffId", "tariffRevisionId" FROM "Invoice" WHERE id = 'i1'`)).toEqual([{ tariffId: null, tariffRevisionId: rev('tB') }]);
      expect(await rows(`SELECT "tariffId", "tariffRevisionId" FROM "InvoiceLine" WHERE id = 'l4'`)).toEqual([{ tariffId: null, tariffRevisionId: rev('tB') }]);
      // firma silinince sürümler de gider: NO ACTION anahtarlar cascade'i durdurmaz (c3: üyesi ve dosyası olmayan firma)
      await sup.query(`DELETE FROM "Company" WHERE id = 'c3'`);
      await sup.query(`DELETE FROM "Company" WHERE id = 'c2'`);
      expect(await rows(`SELECT id FROM "TariffRevision" WHERE "companyId" IN ('c2', 'c3')`)).toEqual([]);

      // sonraki göçler de dolu hacimde uygulanır; açılıştaki şema denetimi yeni anahtarları sayar
      for (const d of later) await owner.query(sqlOf(d));
      expect(await schemaProblems((sql) => sup.query(sql).then((r) => r.rows))).toEqual([]);
    } finally {
      await sup.end();
      await owner.end();
      await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.end();
    }
  }, 120_000);
});
