import type { DatabaseSync } from "node:sqlite";
import { MIGRATION_9_TABLES } from "./0009-firma.ts";
import type { MigrationEnv } from "./types.ts";

// 10: sıkı firma kipi. Göç 9'un geçici tetikleyicilerini kaldırır ve kalıcı biçimlerini kurar (22 tablo; `org_settings`
// zaten NOT NULL ve kendi `org_immutable` tetikleyicisini taşır):
// - `<t>_org_fill` silinir (boş org_id'ye varsayılan firma yazılmaz);
// - `<t>_org_required`: org_id boşsa ekleme HER durumda durur (ABORT);
// - `<t>_org_immutable`: org_id hiç değişmez (boştan doluya geçiş de; ABORT).
// Ön koşul: hiçbir kiracı tablosunda boş org_id yok (göç 9 veri varsa hepsini sahibin firmasına atar; arada boş satır
// kaldıysa göç durur, bütünüyle geri alınır ve açılış açık bir iletiyle durur).
// Liste göç 9'un dondurulmuş listesidir (göçler değişmez); sonraki kiracı tabloları kendi göçlerinde aynı iki
// tetikleyiciyle kurulur (şema testi: `org/schema.test.ts`).
export function migration(db: DatabaseSync, _env: MigrationEnv): void {
  for (const t of MIGRATION_9_TABLES) {
    const empty = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id IS NULL`).get() as { n: number }).n);
    if (empty) throw new Error(`Sıkı kip göçü: ${t} tablosunda org_id boş ${empty} satır var.`);
    db.exec(`
    DROP TRIGGER IF EXISTS ${t}_org_fill;
    DROP TRIGGER IF EXISTS ${t}_org_required;
    DROP TRIGGER IF EXISTS ${t}_org_immutable;
    CREATE TRIGGER ${t}_org_required BEFORE INSERT ON ${t}
      WHEN NEW.org_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'org_id boş (${t})'); END;
    CREATE TRIGGER ${t}_org_immutable BEFORE UPDATE OF org_id ON ${t}
      WHEN NEW.org_id IS NOT OLD.org_id
      BEGIN SELECT RAISE(ABORT, 'org_id değiştirilemez (${t})'); END;
    `);
  }
}
