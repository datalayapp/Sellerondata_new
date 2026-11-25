/**
 * Postgres göçü (platform kipi): `tagpress-migrate` servisinin tek seferlik komutu. Göç rolünün adresi
 * `MIGRATE_DATABASE_URL` (`sod_tagpress_admin`); uygulama adresiyle (`DATABASE_URL`) çalışmaz. Göç klasörü varsayılan olarak
 * kaynak ağacındaki `db/pg/migrations/`; derlenmiş imajda `TAGPRESS_PG_MIGRATIONS_DIR` ile verilir.
 * Çıkış kodu: 0 başarı, 1 hata (hiçbir yarım göç kalmaz; her göç kendi işleminde).
 */
import { migratePgUrl, PG_ADMIN_ROLE, PG_MIGRATIONS_DIR } from "../db/pg/migrate.ts";

async function main(): Promise<void> {
  const url = process.env.MIGRATE_DATABASE_URL?.trim();
  if (!url) throw new Error("MIGRATE_DATABASE_URL yok (göç rolü sod_tagpress_admin ile bağlantı adresi).");
  const user = decodeURIComponent(new URL(url).username);
  if (user !== PG_ADMIN_ROLE) throw new Error(`MIGRATE_DATABASE_URL göç rolüyle olmalı (${PG_ADMIN_ROLE}), bulunan: ${user || "(boş)"}`);
  const dir = process.env.TAGPRESS_PG_MIGRATIONS_DIR?.trim() || PG_MIGRATIONS_DIR;
  const res = await migratePgUrl(url, { dir, log: (m) => console.log(`[tagpress-migrate] ${m}`) });
  console.log(`[tagpress-migrate] tamam: ${res.applied.length} yeni, ${res.skipped.length} zaten uygulanmış`);
}

main().catch((err: unknown) => {
  console.error(`[tagpress-migrate] HATA: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
