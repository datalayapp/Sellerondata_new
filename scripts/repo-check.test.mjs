// repo-check sınamaları: node --test scripts/repo-check.test.mjs
// Not: kaynakta görünmez karakter ve ters eğik çizgi + u kaçışı yok; kod noktaları String.fromCodePoint ile üretilir.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import baseCfg from './repo-check.config.mjs';
import {
  checkTextFile, checkMigrations, checkPackages, checkDocFile, rangesIntersect, rangeFloor, run, format, HATA, UYARI, isMigration,
} from './repo-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECI = 'Deciship/apps/api/prisma/migrations';
const ACC = 'Platform/apps/account-api/prisma/migrations';
const ch = (cp) => String.fromCodePoint(cp);
const cfgWith = (fn) => { const c = structuredClone(baseCfg); fn?.(c); return c; };
const readMig = (dir, name) => readFileSync(path.join(ROOT, dir, name, 'migration.sql'), 'utf8');
const errors = (fs) => fs.filter((f) => f.level === HATA);
const warns = (fs) => fs.filter((f) => f.level === UYARI);

/** Tek göç metnini denetler. */
function k5(sql, { cfg = cfgWith(), dir = DECI, name = '20991231000000_test', history = [] } = {}) {
  const file = `${dir}/${name}/migration.sql`;
  const files = [...history.map((h) => ({ file: h.file, text: h.text })), { file, text: sql }];
  return checkMigrations(files, cfg, new Set([file]));
}
const T = (t) => `"deciship"."${t}"`;
const noForce = (t) => `ALTER TABLE ${T(t)} NO FORCE ROW LEVEL SECURITY;`;
const force = (t) => `ALTER TABLE ${T(t)} FORCE ROW LEVEL SECURITY;`;
const rlsDo = (...names) => `DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${names.map((n) => `'${n}'`).join(', ')}] LOOP
    EXECUTE format('ALTER TABLE "deciship".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "deciship".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY company_isolation ON "deciship".%I
           USING ("companyId" = current_setting('app.company_id', true))$p$,
      t
    );
  END LOOP;
END $$;`;

// ---------------------------------------------------------------------------------------------------------------------
describe('K5 goc-rls: plan §3.7 asgari liste', () => {
  test('eski yakıt göçü istisna listesi kapatılınca HATA verir (Tariff ve FROM\'daki Carrier)', () => {
    const sql = readMig(DECI, '20261110180000_tariff_fuel_variable');
    const cfg = cfgWith((c) => { c.migrations.legacy = []; });
    const r = k5(sql, { cfg, name: '20261110180000_tariff_fuel_variable' });
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 7);
    assert.equal(r[0].rule, 'goc-rls');
    assert.match(r[0].message, /"deciship"\."Tariff"/);
    assert.match(r[0].message, /"deciship"\."Carrier"/);
  });

  test('eski yakıt göçü istisna listesindeyken yalnız UYARI', () => {
    const sql = readMig(DECI, '20261110180000_tariff_fuel_variable');
    const r = k5(sql, { name: '20261110180000_tariff_fuel_variable' });
    assert.equal(errors(r).length, 0);
    assert.equal(warns(r).length, 1);
    assert.match(r[0].message, /bilinen eski göç/);
  });

  test('import_report deseni (NO FORCE → UPDATE → FORCE) geçer', () => {
    assert.deepEqual(k5(readMig(DECI, '20261112120000_import_report')), []);
  });

  test('NO FORCE sonrası FORCE unutulunca HATA', () => {
    const r = k5(`${noForce('Invoice')}\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 1);
    assert.match(r[0].message, /NO FORCE ile açıldı, göç sonunda geri kapanmıyor/);
  });

  test('aynı göçte oluşturulan tabloya INSERT geçer', () => {
    const sql = `CREATE TABLE ${T('Fresh')} ("id" TEXT NOT NULL, "companyId" TEXT NOT NULL);
INSERT INTO ${T('Fresh')} ("id", "companyId") VALUES ('a', 'b');
UPDATE ${T('Fresh')} SET "id" = 'c';
${rlsDo('Fresh')}
`;
    assert.deepEqual(k5(sql), []);
  });

  test('`-- rls-ok:` gerekçesizse HATA ve istisna sayılmaz; gerekçeliyse geçer', () => {
    const bare = k5(`-- rls-ok:\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(bare).length, 2);
    assert.match(bare[0].message, /gerekçesiz/);
    assert.match(bare[1].message, /FORCE RLS altında/);
    const noColon = k5(`-- rls-ok tablo boş\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(noColon).length, 2);
    const ok = k5(`-- rls-ok: tablo bu sürümde hep boş, canlıda kurulmadı\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.deepEqual(ok, []);
  });

  test('`-- rls-ok:` yalnız hemen üstündeki yorum bloğunda geçerli (boş satır bağı keser)', () => {
    const r = k5(`-- rls-ok: gerekçe yazıldı\n\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(r).length, 1);
  });

  test('yeni tabloda RLS yoksa HATA; yalnız ENABLE de yetmez (FORCE gerekir); DO bloğuyla geçer', () => {
    const create = `CREATE TABLE ${T('NoRls')} ("id" TEXT NOT NULL);\n`;
    const none = k5(create);
    assert.equal(errors(none).length, 1);
    assert.match(none[0].message, /ENABLE ve FORCE ROW LEVEL SECURITY yok/);
    const enableOnly = k5(`${create}ALTER TABLE ${T('NoRls')} ENABLE ROW LEVEL SECURITY;\n`);
    assert.equal(errors(enableOnly).length, 1);
    assert.match(enableOnly[0].message, /FORCE ROW LEVEL SECURITY yok/);
    assert.deepEqual(k5(create + rlsDo('Other', 'NoRls')), []);
    assert.deepEqual(k5(`-- rls-ok: yalnız göç geçmişi tablosu, firma verisi yok\n${create}`), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('K5 goc-rls: ayrıştırıcı kenar durumları (kaçırma yok)', () => {
  test('yorum içindeki NO FORCE sayılmaz (-- ve iç içe /* */)', () => {
    const line = k5(`-- ${noForce('Invoice')}\nUPDATE ${T('Invoice')} SET "x" = 1;\n-- ${force('Invoice')}\n`);
    assert.equal(errors(line).length, 1);
    const block = k5(`/* dış /* iç */ ${noForce('Invoice')} */\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(block).length, 1);
  });

  test('yorum içindeki UPDATE veri ifadesi sayılmaz', () => {
    assert.deepEqual(k5(`-- UPDATE ${T('Invoice')} SET "x" = 1;\n/* DELETE FROM ${T('Invoice')}; /* iç */ */\nSELECT 1;\n`), []);
  });

  test('dize sabitindeki NO FORCE sayılmaz', () => {
    const r = k5(`COMMENT ON TABLE ${T('Invoice')} IS 'ALTER TABLE "deciship"."Invoice" NO FORCE ROW LEVEL SECURITY';
UPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(r).length, 1);
  });

  test("E'…' içindeki kaçışlı tırnak ve ; ifadeyi bölmez", () => {
    const sql = `${noForce('Invoice')}
UPDATE ${T('Invoice')} SET "note" = E'a\\'; ALTER TABLE "deciship"."Invoice" FORCE ROW LEVEL SECURITY; --';
${force('Invoice')}\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('UPDATE … FROM: hedef açık ama FROM tablosu FORCE altındaysa HATA, yalnız o tablo yazılır', () => {
    const r = k5(`${noForce('Tariff')}
UPDATE ${T('Tariff')} t SET "fuelVariable" = true
FROM ${T('Carrier')} c
WHERE c."id" = t."carrierId";
${force('Tariff')}\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Carrier"/);
    assert.doesNotMatch(r[0].message, /"deciship"\."Tariff"/);
  });

  test('virgüllü FROM listesi ve JOIN: her okunan tablo denetlenir', () => {
    const r = k5(`${noForce('A')}${noForce('B')}
UPDATE ${T('A')} a SET "x" = b."x"
FROM ${T('B')} b, ${T('C')} c JOIN ${T('D')} d ON d."id" = c."id"
WHERE a."id" = b."id";
${force('A')}${force('B')}\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."C", "deciship"\."D"/);
  });

  test('SET içindeki alt sorgunun okuduğu tablo da denetlenir', () => {
    const r = k5(`${noForce('Invoice')}
UPDATE ${T('Invoice')} SET "total" = (SELECT sum("amount") FROM ${T('InvoiceLine')} l WHERE l."invoiceId" = "Invoice"."id");
${force('Invoice')}\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."InvoiceLine"/);
  });

  test('INSERT … SELECT: kaynak tablo FORCE altındaysa HATA, NO FORCE ile geçer', () => {
    const body = `CREATE TABLE ${T('Copy')} ("id" TEXT);
INSERT INTO ${T('Copy')} ("id") SELECT "id" FROM ${T('Invoice')};
${rlsDo('Copy')}\n`;
    const r = k5(body);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Invoice"/);
    assert.deepEqual(k5(`${noForce('Invoice')}\n${body}${force('Invoice')}\n`), []);
  });

  test('DELETE … USING: USING tablosu denetlenir', () => {
    const r = k5(`${noForce('Measurement')}
DELETE FROM ${T('Measurement')} m USING ${T('Invoice')} i WHERE i."id" = m."invoiceId";
${force('Measurement')}\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Invoice"/);
  });

  test('WITH … UPDATE … INSERT (invoice_current_no) geçer; NO FORCE satırları silinince HATA', () => {
    const sql = readMig(DECI, '20261107120000_invoice_current_no');
    assert.deepEqual(k5(sql), []);
    const broken = sql.split('\n').filter((l) => !/NO FORCE/.test(l)).join('\n');
    const r = k5(broken);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Invoice", "deciship"\."AuditLog"/);
  });

  test('CTE adı tablo sanılmaz', () => {
    const sql = `${noForce('Invoice')}
WITH ranked AS (SELECT "id" FROM ${T('Invoice')}), picked ("id") AS (SELECT "id" FROM ranked)
UPDATE ${T('Invoice')} i SET "x" = 1 FROM picked p WHERE p."id" = i."id";
${force('Invoice')}\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('MERGE INTO … USING denetlenir', () => {
    const r = k5(`MERGE INTO ${T('Invoice')} i USING ${T('Staging')} s ON s."id" = i."id" WHEN MATCHED THEN UPDATE SET "x" = s."x";\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Invoice", "deciship"\."Staging"/);
  });

  test('çok satırlı, küçük harfli ve tırnaksız şema yakalanır', () => {
    const r = k5(`update
  deciship."Tariff"
set
  "fuelVariable" = true;\n`);
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 1);
  });

  test('nitelemesiz tablo adı göç klasörünün varsayılan şemasında sayılır', () => {
    const r = k5('UPDATE "Tariff" SET "fuelVariable" = true;\n');
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Tariff"/);
  });

  test('IF EXISTS / ONLY ile NO FORCE ve FORCE tanınır', () => {
    assert.deepEqual(k5(`ALTER TABLE IF EXISTS ONLY ${T('Invoice')} NO FORCE ROW LEVEL SECURITY;
DELETE FROM ONLY ${T('Invoice')} WHERE "x" IS NULL;
ALTER TABLE ONLY ${T('Invoice')} FORCE ROW LEVEL SECURITY;\n`), []);
  });

  test('sıra yanlışsa (NO FORCE; FORCE; UPDATE) HATA', () => {
    const r = k5(`${noForce('Invoice')}\n${force('Invoice')}\nUPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 3);
  });

  test('DISABLE RLS geri ENABLE edilmezse HATA; DISABLE → UPDATE → ENABLE geçer', () => {
    const dis = `ALTER TABLE ${T('Invoice')} DISABLE ROW LEVEL SECURITY;\nUPDATE ${T('Invoice')} SET "x" = 1;\n`;
    const r = k5(dis);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /DISABLE ile açıldı/);
    assert.deepEqual(k5(`${dis}ALTER TABLE ${T('Invoice')} ENABLE ROW LEVEL SECURITY;\n`), []);
  });

  test('SET ROLE sonrası NO FORCE yetmez (sahip olmayan rol)', () => {
    const r = k5(`SET ROLE sod_deciship;\n${noForce('Invoice')}\nUPDATE ${T('Invoice')} SET "x" = 1;\n${force('Invoice')}\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /SET ROLE/);
  });

  test('DO bloğunda sabit UPDATE yakalanır', () => {
    const r = k5(`DO $$
BEGIN
  IF true THEN
    UPDATE ${T('Invoice')} SET "x" = 1;
  END IF;
END $$;\n`);
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 4);
  });

  test('DO bloğunda IF EXISTS (SELECT … FROM) okuması yakalanır (sessizce yanlış döner)', () => {
    const r = k5(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${T('Invoice')}) THEN RAISE NOTICE 'var'; END IF; END $$;\n`);
    assert.equal(errors(r).length, 1);
  });

  test('DO bloğunda dinamik UPDATE: ARRAY listesine açılır; NO FORCE/FORCE ile sarılınca geçer', () => {
    const dyn = (pre, post) => `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Invoice', 'InvoiceLine'] LOOP
    ${pre}EXECUTE format('UPDATE "deciship".%I SET "x" = 1', t);${post}
  END LOOP;
END $$;\n`;
    const r = k5(dyn('', ''));
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"deciship"\."Invoice", "deciship"\."InvoiceLine"/);
    const ok = dyn(`EXECUTE format('ALTER TABLE "deciship".%I NO FORCE ROW LEVEL SECURITY', t);\n    `,
      `\n    EXECUTE format('ALTER TABLE "deciship".%I FORCE ROW LEVEL SECURITY', t);`);
    assert.deepEqual(k5(ok), []);
  });

  test('çözülemeyen dinamik SQL HATA (rls-ok ile geçer); sistem kataloğu okuması serbest', () => {
    const sql = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'deciship' LOOP
    EXECUTE 'DELETE FROM "deciship".' || quote_ident(r.tablename);
  END LOOP;
END $$;\n`;
    const r = k5(sql);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /dinamik SQL/);
    assert.equal(r[0].line, 5);
    assert.deepEqual(k5(`-- rls-ok: deneme verisi temizliği, canlıda koşmaz\n${sql}`), []);
  });

  test('ARRAY listesi yoksa değişkenden gelen ad çözülmüş sayılmaz', () => {
    const r = k5(`DO $$ DECLARE t text := 'Invoice'; BEGIN EXECUTE format('DELETE FROM "deciship".%I', t); END $$;\n`);
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /dinamik SQL/);
  });

  test('etiketli $body$ içinde $$ ve ; tek ifade sayılır', () => {
    const r = k5(`DO $body$
BEGIN
  RAISE NOTICE '$$ ; DROP';
  UPDATE ${T('Invoice')} SET "x" = 1;
END $body$;\n`);
    assert.equal(errors(r).length, 1);
    assert.equal(r[0].line, 4);
  });

  test('kapanmamış $$ bloğu ayrıştırma HATA verir', () => {
    const r = k5(`DO $$ BEGIN UPDATE ${T('Invoice')} SET "x" = 1;\n`);
    assert.ok(errors(r).some((f) => /ayrıştırılamadı/.test(f.message)));
  });

  test('ON UPDATE CASCADE, FOR UPDATE ilkesi, GRANT, tetikleyici ve işlev gövdesi veri ifadesi sayılmaz', () => {
    const sql = `ALTER TABLE ${T('Dispute')} ADD CONSTRAINT "x_fkey" FOREIGN KEY ("a") REFERENCES ${T('Invoice')}("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE POLICY p ON ${T('Invoice')} FOR UPDATE USING (current_setting('app.scope', true) = 'x');
CREATE POLICY p2 ON ${T('Invoice')} FOR DELETE USING (EXISTS (SELECT 1 FROM ${T('Member')}));
GRANT SELECT, INSERT, UPDATE, DELETE ON ${T('Invoice')} TO sod_deciship;
REVOKE SELECT ON ${T('Invoice')} FROM sod_other;
CREATE FUNCTION "deciship".f() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE ${T('Invoice')} SET "x" = 1; RETURN NEW; END $f$;
CREATE TRIGGER t AFTER INSERT OR UPDATE OR DELETE ON ${T('Invoice')} FOR EACH ROW EXECUTE FUNCTION "deciship".f();
CREATE INDEX "i" ON ${T('Invoice')} ("companyId", lower("invoiceNo"));
SELECT 1;\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('şema nitelikli işlev çağrısı tablo sanılmaz', () => {
    const sql = `${noForce('Invoice')}
UPDATE ${T('Invoice')} SET "x" = "deciship".normalize_no("invoiceNo");
${force('Invoice')}\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('INSERT … ON CONFLICT DO UPDATE yalnız INSERT hedefini sayar', () => {
    const sql = `CREATE TABLE ${T('Fresh')} ("id" TEXT);
INSERT INTO ${T('Fresh')} ("id") VALUES ('a') ON CONFLICT ("id") DO UPDATE SET "id" = EXCLUDED."id";
${rlsDo('Fresh')}\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('IS DISTINCT FROM ve EXTRACT(… FROM …) tablo sanılmaz', () => {
    const sql = `CREATE TABLE ${T('Fresh')} ("id" TEXT, "createdAt" TIMESTAMP(3), "y" INTEGER);
UPDATE ${T('Fresh')} SET "y" = EXTRACT(YEAR FROM "createdAt") WHERE "id" IS DISTINCT FROM "y"::text;
${rlsDo('Fresh')}\n`;
    assert.deepEqual(k5(sql), []);
  });

  test('CREATE TABLE … AS SELECT ve SELECT … INTO okuması denetlenir', () => {
    const r1 = k5(`CREATE TABLE ${T('Snap')} AS SELECT * FROM ${T('Invoice')};\n${rlsDo('Snap')}\n`);
    assert.equal(errors(r1).length, 1);
    assert.match(r1[0].message, /"deciship"\."Invoice"/);
    const r2 = k5(`SELECT * INTO ${T('Snap2')} FROM ${T('Invoice')};\n`);
    assert.ok(errors(r2).some((f) => /"deciship"\."Invoice"/.test(f.message)));
  });

  test('CALL denetlenemez: HATA', () => {
    assert.equal(errors(k5('CALL "deciship".backfill();\n')).length, 1);
  });

  test('ayarda olmayan göç klasörü HATA', () => {
    const r = k5('SELECT 1;\n', { dir: 'OrderLoom/apps/api/prisma/migrations' });
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /göç klasörü ayarda yok/);
  });

  test('bir göçte FORCE görülen yeni şema kendiliğinden RLS\'li sayılır', () => {
    const cfg = cfgWith((c) => { c.migrations.dirs.push({ dir: 'OrderLoom/apps/api/prisma/migrations', defaultSchema: 'orderloom' }); });
    const dir = 'OrderLoom/apps/api/prisma/migrations';
    const history = [{
      file: `${dir}/20990101000000_init/migration.sql`,
      text: 'CREATE TABLE "orderloom"."Order" ("id" TEXT);\nALTER TABLE "orderloom"."Order" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "orderloom"."Order" FORCE ROW LEVEL SECURITY;\n',
    }];
    const r = k5('UPDATE "Order" SET "id" = "id";\n', { cfg, dir, history });
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"orderloom"\."Order"/);
  });

  test('RLS\'siz şemada (platform) veri ifadesi serbest', () => {
    assert.deepEqual(k5('UPDATE "platform"."Person" SET "x" = 1;\nUPDATE "Session" SET "y" = 2;\n', { dir: ACC }), []);
  });

  test('düz SQL göç klasörü (db/pg/migrations/NNNN-ad.sql) göç sayılır ve aynı kurallarla denetlenir', () => {
    const dir = 'Tagpress/apps/server/src/db/pg/migrations';
    assert.equal(isMigration(`${dir}/0002-yeni.sql`), true);
    assert.equal(isMigration('Tagpress/apps/server/src/db/pg/migrate.ts'), false);
    assert.equal(isMigration('Tagpress/apps/server/src/db/pg/migrations/alt/0002-yeni.sql'), false);
    const file = `${dir}/0002-yeni.sql`;
    // tagpress şeması ayarda RLS'li: firma bağlamsız veri ifadesi HATA.
    const r = checkMigrations([{ file, text: 'UPDATE "tagpress"."jobs" SET "x" = 1;\n' }], cfgWith(), new Set([file]));
    assert.equal(errors(r).length, 1);
    assert.match(r[0].message, /"tagpress"\."jobs" FORCE RLS altında/);
    // Ayarda olmayan düz SQL klasörü de HATA (yeni aracın göçü denetimsiz kalmasın).
    const yok = 'Orderloom/apps/api/src/db/pg/migrations/0001-ilk.sql';
    const r2 = checkMigrations([{ file: yok, text: 'SELECT 1;\n' }], cfgWith(), new Set([yok]));
    assert.equal(errors(r2).length, 1);
    assert.match(r2[0].message, /göç klasörü ayarda yok: .*Orderloom\/apps\/api\/src\/db\/pg\/migrations/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('K5 goc-rls: depodaki gerçek göçler', () => {
  test('bütün deciship ve hesap göçleri: 0 HATA, yalnız eski yakıt göçü UYARI', () => {
    const files = [];
    for (const dir of [DECI, ACC]) {
      for (const name of readdirSync(path.join(ROOT, dir)).filter((n) => /^\d{14}_/.test(n)).sort()) {
        files.push({ file: `${dir}/${name}/migration.sql`, text: readMig(dir, name) });
      }
    }
    assert.ok(files.length >= 10);
    const r = checkMigrations(files, cfgWith());
    assert.deepEqual(errors(r), []);
    assert.equal(warns(r).length, 1);
    assert.match(warns(r)[0].file, /20261110180000_tariff_fuel_variable/);
  });

  test('bütün TagPress Postgres göçleri: 0 bulgu', () => {
    const dir = 'Tagpress/apps/server/src/db/pg/migrations';
    const files = readdirSync(path.join(ROOT, dir)).filter((n) => /^\d{4}-.+\.sql$/.test(n)).sort()
      .map((n) => ({ file: `${dir}/${n}`, text: readFileSync(path.join(ROOT, dir, n), 'utf8') }));
    assert.ok(files.length >= 1);
    assert.deepEqual(checkMigrations(files, cfgWith()), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('K1–K4 metin dosyaları', () => {
  const cfg = cfgWith();
  const meta = { index: 'lf', work: 'lf', attr: 'text=auto' };
  const buf = (s) => Buffer.from(s, 'utf8');

  test('K1: 0x08 (regex \\b yerine geri silme) HATA, satır doğru', () => {
    const r = checkTextFile('a/x.ts', buf(`const a = 1;\nconst re = /${ch(8)}word${ch(8)}/;\n`), meta, cfg);
    assert.equal(r.length, 1);
    assert.equal(r[0].rule, 'kontrol-karakteri');
    assert.equal(r[0].line, 2);
    assert.match(r[0].message, /0x08/);
  });

  test('K1: md dosyasında da (BEL) yakalanır; sekme ve CRLF serbest', () => {
    assert.equal(checkTextFile('d/x.md', buf(`yol: Deciship${ch(7)}pps\n`), meta, cfg).length, 1);
    assert.deepEqual(checkTextFile('d/y.ts', buf('a\tb\r\nc\n'), meta, cfg), []);
  });

  test('K1: hariç klasör, -text özniteliği ve ikili dosya taranmaz', () => {
    const bad = buf(`x${ch(8)}y`);
    assert.deepEqual(checkTextFile('SONRAKI-OTURUM/not.ts', bad, meta, cfg), []);
    assert.deepEqual(checkTextFile('Deciship/samples/invoices/a.csv', bad, meta, cfg), []);
    assert.deepEqual(checkTextFile('a/fixture.csv', bad, { ...meta, attr: '-text' }, cfg), []);
    assert.deepEqual(checkTextFile('a/logo.png', bad, meta, cfg), []);
    assert.deepEqual(checkTextFile('a/blob.unknown', Buffer.from([0x41, 0, 8, 0x42]), meta, cfg), []);
  });

  test('K2: U+200B HATA ve çözüm iletisi kaçışı söyler', () => {
    const r = checkTextFile('a/x.ts', buf(`const s = 'a${ch(0x200b)}b';\n`), meta, cfg);
    assert.equal(r.length, 1);
    assert.equal(r[0].rule, 'gorunmez-karakter');
    assert.match(r[0].message, /U\+200B/);
    assert.match(r[0].message, /kaçışıyla yaz/);
  });

  test('K2: yön karakteri (U+202E) sql dosyasında HATA; md dosyasında aranmaz', () => {
    assert.equal(checkTextFile('m/migration.sql', buf(`-- a${ch(0x202e)}b\n`), meta, cfg).length, 1);
    assert.deepEqual(checkTextFile('d/x.md', buf(`a${ch(0x202e)}b\n`), meta, cfg), []);
  });

  test('K2: bölünmez boşluklar (U+00A0, U+202F) serbest; dosya ortasındaki U+FEFF HATA', () => {
    assert.deepEqual(checkTextFile('a/x.ts', buf(`'1${ch(0xa0)}234${ch(0x202f)}TL'\n`), meta, cfg), []);
    assert.equal(checkTextFile('a/x.ts', buf(`'${ch(0xfeff)}'\n`), meta, cfg).length, 1);
  });

  test('K3: .ps1 BOM ister, .ts/.json BOM istemez; baştaki BOM K2\'de çift sayılmaz', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const ps = checkTextFile('s/a.ps1', buf('Write-Host "ğ"\n'), meta, cfg);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].rule, 'bom');
    assert.deepEqual(checkTextFile('s/a.ps1', Buffer.concat([bom, buf('Write-Host "ğ"\n')]), meta, cfg), []);
    const ts = checkTextFile('s/a.ts', Buffer.concat([bom, buf('export {};\n')]), meta, cfg);
    assert.deepEqual(ts.map((f) => f.rule), ['bom']);
    assert.deepEqual(checkTextFile('s/a.json', Buffer.concat([bom, buf('{}\n')]), meta, cfg).map((f) => f.rule), ['bom']);
  });

  test('K4: .sh index\'te CRLF ise HATA; izlenmeyen CRLF autocrlf=true ile serbest, değilse HATA', () => {
    const sh = buf('#!/bin/sh\necho a\n');
    assert.equal(checkTextFile('x/run.sh', sh, { index: 'crlf', work: 'crlf', attr: 'text=auto' }, cfg)[0].rule, 'satir-sonu');
    assert.equal(checkTextFile('.githooks/pre-commit', sh, { index: 'mixed', work: 'lf', attr: 'text eol=lf' }, cfg).length, 1);
    assert.deepEqual(checkTextFile('x/run.sh', sh, { index: 'lf', work: 'crlf', attr: 'text eol=lf' }, cfg), []);
    assert.deepEqual(checkTextFile('x/new.sh', sh, { index: '', work: 'crlf', attr: 'text=auto' }, cfg, { autocrlf: 'true' }), []);
    assert.equal(checkTextFile('x/new.sh', sh, { index: '', work: 'crlf', attr: 'text=auto' }, cfg, { autocrlf: 'false' }).length, 1);
  });

  test('allow istisnası yalnız adı geçen kuralı kapatır', () => {
    const c = cfgWith((x) => { x.allow = [{ glob: 'a/odd.ts', rules: ['K1'], reason: 'deneme' }]; });
    const r = checkTextFile('a/odd.ts', buf(`x${ch(8)}y${ch(0x200b)}\n`), meta, c);
    assert.deepEqual(r.map((f) => f.code), ['K2']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('K6–K9 paketler', () => {
  const pj = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const mkSrc = (files) => {
    const map = new Map(Object.entries(files));
    return { paths: [...map.keys()], has: (p) => map.has(p), text: (p) => map.get(p) ?? null };
  };
  const shared = {
    name: '@x/shared', version: '0.1.0', dependencies: { jose: '^6.2.0', '@types/papaparse': '^5.0.0' },
    peerDependencies: { fastify: '^5.0.0', react: '^19' }, peerDependenciesMeta: { react: { optional: true } },
    devDependencies: { vitest: '^5.0.5' },
  };
  const app = {
    name: '@x/api', version: '0.1.0',
    dependencies: { '@x/shared': 'file:../../packages/shared', jose: '^6.2.15', fastify: '^5.12.7' },
    devDependencies: { typescript: '^7.0.2', vitest: '^5.0.5' },
  };
  const lockOf = (entry) => pj({
    name: '@x/api', lockfileVersion: 3,
    packages: {
      '': app,
      '../../packages/shared': entry,
      'node_modules/@x/shared': { resolved: '../../packages/shared', link: true },
      'node_modules/typescript': { version: '7.0.2' },
      'node_modules/vitest': { version: '5.0.9' },
    },
  });
  const freshEntry = { name: '@x/shared', version: '0.1.0', dependencies: shared.dependencies, devDependencies: shared.devDependencies, peerDependencies: shared.peerDependencies };
  const base = (over = {}) => ({
    '.nvmrc': '24.22.1\n',
    'package.json': pj({ name: 'root', engines: { node: '>=24.22.1 <25' } }),
    'X/packages/shared/package.json': pj(shared),
    'X/apps/api/package.json': pj(app),
    'X/apps/api/package-lock.json': lockOf(freshEntry),
    'X/apps/api/Dockerfile': 'FROM node:24-alpine AS base\n',
    ...over,
  });
  // Örnek Dockerfile node:24-alpine yazar; tam sürüm denetimi (dockerNodeExact) kendi testinde sınanır.
  const cfg = cfgWith((c) => { c.sharedNodeModules = [{ consumer: 'X/apps/api', reason: 'deneme' }]; c.versions.dockerNodeExact = false; });
  const codes = (r) => r.map((f) => `${f.level} ${f.code}`).sort();

  test('temiz örnek: bulgu yok', () => {
    assert.deepEqual(checkPackages(mkSrc(base()), cfg), []);
  });

  test('K6: file: yolu yok ya da ad tutmuyor → HATA', () => {
    const bad = { ...app, dependencies: { ...app.dependencies, '@x/ghost': 'file:../../packages/ghost', '@x/wrong': 'file:../../packages/shared' } };
    const r = checkPackages(mkSrc(base({ 'X/apps/api/package.json': pj(bad) })), cfg).filter((f) => f.code === 'K6');
    assert.equal(r.length, 2);
    assert.ok(r.every((f) => f.level === HATA));
    assert.ok(r.some((f) => /package\.json yok/.test(f.message)));
    assert.ok(r.some((f) => /adı "@x\/shared"/.test(f.message)));
  });

  test('K7: kilitte eski dependencies/version HATA, devDependencies UYARI, çözüm iletisi', () => {
    const stale = { ...freshEntry, version: '0.0.9', dependencies: { jose: '^5.0.0' }, devDependencies: {} };
    const r = checkPackages(mkSrc(base({ 'X/apps/api/package-lock.json': lockOf(stale) })), cfg).filter((f) => f.code === 'K7');
    assert.deepEqual(codes(r), ['HATA K7', 'UYARI K7']);
    const err = r.find((f) => f.level === HATA);
    assert.match(err.message, /version 0\.0\.9 → 0\.1\.0/);
    assert.match(err.message, /jose \^5\.0\.0 → \^6\.2\.0/);
    assert.match(err.message, /npm install --package-lock-only/);
    assert.equal(err.file, 'X/apps/api/package-lock.json');
    assert.ok(err.line > 1);
  });

  test('K7: peerDependencies farkı HATA; bağ başka yere çözülmüşse HATA', () => {
    const r1 = checkPackages(mkSrc(base({ 'X/apps/api/package-lock.json': lockOf({ ...freshEntry, peerDependencies: { fastify: '^4.0.0' } }) })), cfg);
    assert.deepEqual(codes(r1.filter((f) => f.code === 'K7')), ['HATA K7']);
    const lock = JSON.parse(lockOf(freshEntry));
    lock.packages['node_modules/@x/shared'] = { version: '0.1.0', resolved: 'https://registry/x.tgz' };
    const r2 = checkPackages(mkSrc(base({ 'X/apps/api/package-lock.json': pj(lock) })), cfg).filter((f) => f.code === 'K7');
    assert.equal(r2.length, 1);
    assert.match(r2[0].message, /çözülmüş/);
  });

  test('K8: paylaşılan node_modules: eksik, yalnız dev ve kesişmeyen aralık HATA; @types ve isteğe bağlı eş atlanır', () => {
    const missing = { ...app, dependencies: { '@x/shared': app.dependencies['@x/shared'], fastify: '^4.28.0' }, devDependencies: { ...app.devDependencies, jose: '^6.2.15' } };
    const r = checkPackages(mkSrc(base({ 'X/apps/api/package.json': pj(missing) })), cfg).filter((f) => f.code === 'K8');
    assert.equal(r.length, 2);
    assert.ok(r.some((f) => /jose .*yalnız devDependencies/.test(f.message)));
    assert.ok(r.some((f) => /fastify .*kesişmiyor/.test(f.message)));
    assert.ok(!r.some((f) => /@types|react/.test(f.message)));
  });

  test('K8: iç içe yerel paket (file:) tüketicide aynı yere bağlı olmalı', () => {
    const inner = { name: '@x/inner', version: '0.1.0' };
    const sh2 = { ...shared, dependencies: { ...shared.dependencies, '@x/inner': 'file:../inner' } };
    const r = checkPackages(mkSrc(base({
      'X/packages/inner/package.json': pj(inner),
      'X/packages/shared/package.json': pj(sh2),
      'X/apps/api/package-lock.json': lockOf({ ...freshEntry, dependencies: sh2.dependencies }),
    })), cfg).filter((f) => f.code === 'K8');
    assert.equal(r.length, 1);
    assert.match(r[0].message, /@x\/inner/);
  });

  test('K9: ana sürüm farkı HATA, küçük sürüm farkı UYARI, istisna gerekçesiyle atlanır', () => {
    const other = (dir, deps) => ({ [`${dir}/package.json`]: pj({ name: dir, version: '0.1.0', devDependencies: deps }) });
    const files = base({
      ...other('X/a', { typescript: '^7.0.2', vitest: '^5.1.0' }),
      ...other('X/b', { typescript: '^5.9.0', vitest: '^5.0.5' }),
      ...other('X/c', { typescript: '^7.1.0', vitest: '^5.0.1' }),
      ...other('Deciship/apps/mobile', { typescript: '~6.0.3' }),
    });
    const r = checkPackages(mkSrc(files), cfg).filter((f) => f.code === 'K9');
    const err = r.filter((f) => f.level === HATA);
    assert.equal(err.length, 1);
    assert.equal(err[0].file, 'X/b/package.json');
    assert.match(err[0].message, /typescript \^5\.9\.0: ana sürüm 5, diğer paketlerde 7/);
    const w = r.filter((f) => f.level === UYARI).map((f) => f.file).sort();
    assert.deepEqual(w, ['X/a/package.json', 'X/c/package.json']);
  });

  test('K9: kilitte çözülen ana sürüm package.json ile aynı değilse HATA', () => {
    const lock = JSON.parse(lockOf(freshEntry));
    lock.packages['node_modules/typescript'] = { version: '5.9.3' };
    const r = checkPackages(mkSrc(base({ 'X/apps/api/package-lock.json': pj(lock) })), cfg).filter((f) => f.code === 'K9');
    assert.equal(r.length, 1);
    assert.match(r[0].message, /kilitte 5\.9\.3 çözülmüş/);
  });

  test('K9: .nvmrc, engines ve Dockerfile node etiketi', () => {
    const r1 = checkPackages(mkSrc(base({ 'package.json': pj({ name: 'root', engines: { node: '>=24.15.0' } }) })), cfg);
    assert.ok(r1.some((f) => f.code === 'K9' && f.level === HATA && /engines\.node/.test(f.message)));
    const r2 = checkPackages(mkSrc(base({ 'X/apps/api/Dockerfile': 'FROM node:22-alpine AS base\nFROM nginx:1.29-alpine\n' })), cfg);
    assert.deepEqual(r2.filter((f) => f.code === 'K9').map((f) => [f.level, f.line]), [[HATA, 1]]);
    const exact = cfgWith((c) => { c.sharedNodeModules = cfg.sharedNodeModules; c.versions.dockerNodeExact = true; });
    assert.equal(checkPackages(mkSrc(base()), exact).filter((f) => f.code === 'K9').length, 1);
    assert.deepEqual(checkPackages(mkSrc(base({ 'X/apps/api/Dockerfile': 'FROM node:24.22.1-alpine\n' })), exact), []);
    const r3 = checkPackages(mkSrc(base({ '.nvmrc': undefined })), cfg);
    assert.ok(r3.some((f) => f.code === 'K9' && f.level === UYARI));
  });

  test('sürüm aralığı kesişimi ve alt sınır', () => {
    assert.equal(rangesIntersect('^6.2.0', '^6.2.15'), true);
    assert.equal(rangesIntersect('^5.0.0', '^4.28.0'), false);
    assert.equal(rangesIntersect('>=25', '^26.1.0'), true);
    assert.equal(rangesIntersect('~6.0.3', '^6.1.0'), false);
    assert.equal(rangesIntersect('^0.3.1', '^0.4.0'), false);
    assert.equal(rangesIntersect('1.2.3 - 2.0.0', '^2.0.0'), true);
    assert.equal(rangesIntersect('^4 || ^5', '5.1.0'), true);
    assert.equal(rangesIntersect('*', '^9'), true);
    assert.deepEqual(rangeFloor('>=24.22.1 <25'), [24, 22, 1]);
    assert.deepEqual(rangeFloor('~6.0.3'), [6, 0, 3]);
    assert.equal(rangeFloor('*'), null);
    assert.equal(rangeFloor('file:../x'), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('depo koşusu', () => {
  test('tam koşu: K5 HATA yok, eski yakıt göçü UYARI, 5 sn altında', () => {
    const res = run({ cfg: baseCfg });
    assert.ok(res.ms < 5000, `süre ${res.ms} ms`);
    assert.ok(res.files > 500);
    assert.deepEqual(res.findings.filter((f) => f.code === 'K5' && f.level === HATA), []);
    assert.ok(res.findings.some((f) => f.code === 'K5' && f.level === UYARI && /tariff_fuel_variable/.test(f.file)));
    for (const line of format(res).split('\n').slice(0, -1)) {
      assert.match(line, /^(HATA|UYARI) \[[a-z-]+\] \S+:\d+ {2}\S/);
    }
  });

  test('komut satırı: --json biçimi ve çıkış kodu; --staged 2 sn altında; bilinmeyen bayrak 2', () => {
    const script = path.join(ROOT, 'scripts', 'repo-check.mjs');
    const j = spawnSync(process.execPath, [script, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = JSON.parse(j.stdout);
    assert.equal(typeof out.ok, 'boolean');
    assert.equal(j.status, out.errors > 0 ? 1 : 0);
    assert.ok(Array.isArray(out.findings));
    const t0 = Date.now();
    const s = spawnSync(process.execPath, [script, '--staged'], { cwd: ROOT, encoding: 'utf8' });
    assert.ok(Date.now() - t0 < 2000, `--staged ${Date.now() - t0} ms`);
    assert.ok([0, 1].includes(s.status));
    assert.match(s.stdout, /repo-check: \d+ HATA, \d+ UYARI/);
    assert.equal(spawnSync(process.execPath, [script, '--yok'], { cwd: ROOT }).status, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('--staged: index içeriği (geçici depoda; bu depoya git yazılmaz)', () => {
  test('sahnelenen içerik denetlenir, çalışma ağacı ve izlenmeyen dosya değil', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'repo-check-'));
    try {
      const g = (...args) => {
        const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      };
      const put = (p, content) => {
        mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
        writeFileSync(path.join(dir, p), content);
      };
      g('init', '-q');
      g('config', 'core.autocrlf', 'false');
      put('a.ts', `const s = 'a${ch(0x200b)}b';\n`);
      put('b.ts', 'export const b = 1;\n');
      put('run.sh', '#!/bin/sh\r\necho a\r\n');
      const mig = `${DECI}/20990101000000_x/migration.sql`;
      put(mig, 'UPDATE "deciship"."Tariff" SET "x" = 1;\n');
      g('add', 'a.ts', 'b.ts', 'run.sh', mig);
      put('a.ts', 'export const a = 1;\n'); // çalışma ağacında temiz, index'te kirli
      put('b.ts', `export const b = /${ch(8)}x/;\n`); // çalışma ağacında kirli, index'te temiz
      put('c.ts', `export const c = '${ch(8)}';\n`); // izlenmiyor

      const staged = run({ staged: true, cfg: baseCfg, root: dir });
      const got = staged.findings.map((f) => `${f.code} ${f.file}`).sort();
      assert.deepEqual(got, ['K2 a.ts', 'K4 run.sh', `K5 ${mig}`]);
      assert.ok(staged.ms < 2000);

      const full = run({ staged: false, cfg: baseCfg, root: dir });
      const files = new Set(full.findings.map((f) => f.file));
      assert.ok(files.has('b.ts') && files.has('c.ts') && !files.has('a.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('K10 belge-yolu ve K11 uzun-satir (yalnız UYARI)', () => {
  const cfg = cfgWith();
  const have = new Set(['Platform/docs/KARARLAR.md', 'Platform/apps', 'scripts/a.mjs', 'SONRAKI-OTURUM/rel.md']);
  const exists = (p) => have.has(p);
  const doc = (text, file = 'SONRAKI-OTURUM/DEVAM.md') => checkDocFile(file, text, exists, cfg);

  test('K10: olmayan yol UYARI, satır numarası ve ileti doğru', () => {
    const r = doc('ilk satır\nbak: `Platform/docs/YOK.md` ve `scripts/a.mjs`\n');
    assert.equal(r.length, 1);
    assert.equal(r[0].level, UYARI);
    assert.equal(r[0].code, 'K10');
    assert.equal(r[0].rule, 'belge-yolu');
    assert.equal(r[0].line, 2);
    assert.equal(r[0].message, 'belgedeki yol yok: Platform/docs/YOK.md');
  });

  test('K10: var olan dosya, klasör, :40 / :12-40 / :12,57 son eki, noktalama ve ilk sözcük serbest', () => {
    const md = [
      '`Platform/docs/KARARLAR.md`', '`Platform/apps`', '`Platform/apps/`', '`scripts/a.mjs:40`', '`scripts/a.mjs:12-40`',
      '`scripts/a.mjs:12,57`', '`scripts/a.mjs.`', '`scripts/a.mjs --json`',
    ].join('\n');
    assert.deepEqual(doc(md), []);
  });

  test('K10: glob, yer tutucu, değişken ve üç nokta atlanır; kök dışı yollar yol sayılmaz', () => {
    const md = '`Platform/*/x.ts` `Platform/<ad>/x` `Platform/{a,b}` `Platform/$X/y` `Platform/…/z` `Platform/.../z` `src/yok.ts` `https://Platform/x`';
    assert.deepEqual(doc(md), []);
  });

  test('K10: yol belgenin kendi klasörüne göre de çözülür', () => {
    assert.deepEqual(doc('`SONRAKI-OTURUM/rel.md`'), []);
    const own = checkDocFile('Platform/docs/X.md', '`Platform/y.md`', (p) => p === 'Platform/docs/Platform/y.md', cfg);
    assert.deepEqual(own, []);
  });

  test('K11: 601 karakterlik satır UYARI, 600 karakterlik değil; dosya başına tek satır ileti', () => {
    assert.deepEqual(doc(`${'a'.repeat(600)}\n`), []);
    const r = doc(`kısa\n${'a'.repeat(601)}\n${'b'.repeat(700)}\n`);
    assert.equal(r.length, 1);
    assert.equal(r[0].level, UYARI);
    assert.equal(r[0].code, 'K11');
    assert.equal(r[0].message, '2 satır 600 karakteri aşıyor (ilk: satır 2, 601 karakter)');
    assert.deepEqual(doc(`${'a'.repeat(600)}\r\n`), []);
  });

  test('kapsam: SONRAKI-OTURUM taranır; ARSIV, samples, node_modules ve md olmayan dosya taranmaz; allow K10/K11 kapatır', () => {
    const bad = '`Platform/yok.md`\n';
    assert.equal(doc(bad, 'SONRAKI-OTURUM/KALANLAR.md').length, 1);
    for (const f of ['SONRAKI-OTURUM/ARSIV/x.md', 'Deciship/samples/a.md', 'a/node_modules/p/README.md', 'a/x.ts']) {
      assert.deepEqual(doc(bad, f), [], f);
    }
    const c = cfgWith((x) => { x.allow = [{ glob: 'a/odd.md', rules: ['K10', 'K11'], reason: 'deneme' }]; });
    assert.deepEqual(checkDocFile('a/odd.md', `${bad}${'a'.repeat(700)}\n`, exists, c), []);
  });

  test('geçici depoda: yalnız UYARI; --staged yalnız sahnelenen md dosyasını denetler', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'repo-check-doc-'));
    try {
      const g = (...args) => {
        const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      };
      const put = (p, content) => {
        mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
        writeFileSync(path.join(dir, p), content);
      };
      g('init', '-q');
      g('config', 'core.autocrlf', 'false');
      put('Platform/docs/var.md', '# var\n');
      put('SONRAKI-OTURUM/a.md', `\`Platform/docs/var.md\` \`Platform/docs/yok.md\`\n${'x'.repeat(601)}\n`);
      put('SONRAKI-OTURUM/ARSIV/b.md', '`Platform/yok.md`\n');
      put('b.md', '`Platform/yok2.md`\n');
      g('add', 'SONRAKI-OTURUM/a.md');

      const staged = run({ staged: true, cfg: baseCfg, root: dir });
      assert.deepEqual(staged.findings.map((f) => `${f.level} ${f.code} ${f.file}`).sort(),
        ['UYARI K10 SONRAKI-OTURUM/a.md', 'UYARI K11 SONRAKI-OTURUM/a.md']);

      const full = run({ staged: false, cfg: baseCfg, root: dir });
      const docs = full.findings.filter((f) => f.code === 'K10' || f.code === 'K11');
      assert.ok(docs.every((f) => f.level === UYARI));
      assert.deepEqual(docs.map((f) => `${f.code} ${f.file}`).sort(),
        ['K10 SONRAKI-OTURUM/a.md', 'K10 b.md', 'K11 SONRAKI-OTURUM/a.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
