#!/usr/bin/env node
/**
 * npm run db:check-drift
 *
 * Bileşik yabancı anahtarlar yalnız SQL'de yazılıdır: Prisma bunları göremez, `migrate dev` her yeni göçte 26 anahtarı tek
 * sütunluya çevirmeyi önerir. Bu betik iki şeye bakar:
 *  1. Sonraki göçler bileşik anahtarı ya da kısmi dizini düşürüyor mu (dosya taraması, veritabanı gerekmez).
 *  2. Veritabanı ile schema.prisma arasında bilinen fark dışında bir şey var mı (`prisma migrate diff`).
 * `--migrations-only` yalnız ilkini yapar. Bulursa çıkış kodu 1.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT = '20261106120000_init';

const statements = (sql) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

const FIRM_FK = /_companyId_fkey"/;
const DROP_FK = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"(\w+_fkey)"/i;
const REFERENCES_COMPANY = /REFERENCES\s+("\w+"\.)?"Company"/;
const isSingleColumnFk = (s) => /FOREIGN KEY\s*\("\w+"\)/.test(s) && !REFERENCES_COMPANY.test(s);

/** Göçteki tehlikeli satırlar: bileşik anahtarı tek sütuna indiren ya da kısmi dizini silen. */
export function dangerousMigration(sql) {
  const list = statements(sql);
  const readded = new Set(
    list
      .filter((s) => /ADD CONSTRAINT/.test(s) && /FOREIGN KEY\s*\("\w+",\s*"companyId"\)/.test(s))
      .map((s) => /ADD CONSTRAINT "(\w+)"/.exec(s)?.[1]),
  );
  // Aynı göçte yeniden kurulan dizin düşmüş sayılmaz (ör. kuralı genişletmek için).
  const recreated = (name) => list.some((s) => new RegExp(`CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"${name}"[\\s\\S]*WHERE`, 'i').test(s));
  return list.filter((s) => {
    const droppedIndex = /DROP\s+INDEX[\s\S]*(Measurement_current_tracking_key|Invoice_current_no_key|Dispute_active_invoice_key)/i.exec(s);
    if (droppedIndex && !recreated(droppedIndex[1])) return true;
    if (/ADD CONSTRAINT/.test(s) && isSingleColumnFk(s)) return true;
    const dropped = DROP_FK.exec(s);
    return Boolean(dropped) && !FIRM_FK.test(s) && !readded.has(dropped[1]);
  });
}

/** `migrate diff` çıktısında bilinen fark (tek sütunlu FK'ye dönüş) dışında kalanlar. */
export function unexpectedDiff(sql) {
  return statements(sql).filter((s) => {
    if (DROP_FK.test(s) && !FIRM_FK.test(s)) return false;
    if (/ADD CONSTRAINT/.test(s) && isSingleColumnFk(s)) return false;
    return !/^(This is an empty migration|-- This is an empty migration)/.test(s);
  });
}

function scanMigrations() {
  const dir = path.join(API_ROOT, 'prisma', 'migrations');
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'migration.sql');
    if (name === INIT || !fs.existsSync(file)) continue;
    for (const s of dangerousMigration(fs.readFileSync(file, 'utf8'))) found.push(`${name}: ${s.slice(0, 120)}`);
  }
  return found;
}

function main() {
  const dangerous = scanMigrations();
  if (dangerous.length) {
    console.error(`Göç bileşik yabancı anahtarı ya da kısmi dizini düşürüyor. Bu satırları göçten çıkarın:\n${dangerous.map((d) => ` - ${d}`).join('\n')}`);
    process.exit(1);
  }
  if (process.argv.includes('--migrations-only')) {
    console.log('Göçler temiz.');
    return;
  }
  let diff;
  try {
    diff = execSync('npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script', { cwd: API_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`Fark alınamadı (veritabanı açık mı, MIGRATE_DATABASE_URL doğru mu?):\n${String(err.stderr ?? err.message).slice(0, 600)}`);
    process.exit(2);
  }
  const extra = unexpectedDiff(diff);
  if (extra.length) {
    console.error(`schema.prisma ile veritabanı arasında bilinen fark dışında değişiklik var. Göç yazın:\n${extra.map((s) => ` - ${s.slice(0, 160)}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Bilinen fark dışında sapma yok.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
