// 12: baskı ölçüleri standardı (2026-11-21): fiziksel ölçü mm, çözünürlük çıktı anında.
// 1. `print_sessions.plan_version`: oturumun hangi ölçü kurallarıyla dizildiği. Var olan oturumlar 1 (eski sticker
//    ölçüsü: tasarım pikseli = 1 pt, sticker ~2,3 kat büyük); yeni planlar `PLAN_VERSION` (2) yazar. Masa 1 olan taslak
//    sticker oturumunda "yeniden planla" önerir; 1 olan basılmış oturum eski ölçüyle (basıldığı gibi) dışa aktarılır.
// 2. `print_templates.data` → kağıt eski eklentinin 595 × 842 pt'si (209,90 × 297,04 mm; ±0,05 mm) ise tam A4 (210 × 297).
//    Tam A4 satırı yeniden yazılmaz; yuvalar ve akış değerleri gerçek mm'dir, dokunulmaz. Bozuk JSON'lu ya da nesne
//    olmayan satır atlanır; ikinci koşu hiçbir şeyi değiştirmez.
// Profil sürümlerine dokunulmaz (yayımlanmış sürüm değişmez): eski `printing.stickerDpi` 72'yi okuma anındaki
// `upgradeProfileInput` kaldırır. Basılmış oturumların şablon kopyaları (arşiv) değişmez. Satırlar yerinde güncellenir;
// `org_id` değişmez (bakım kapsamı, bütün firmalar). İkinci koşu (ör. elle) hata vermez, bir şey değiştirmez.
import type { DatabaseSync } from "node:sqlite";
import type { MigrationEnv } from "./types.ts";

export function migration(db: DatabaseSync, _env: MigrationEnv): void {
  const cols = (db.prepare("PRAGMA table_info(print_sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("plan_version")) db.exec("ALTER TABLE print_sessions ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1;");
  db.exec(`
  UPDATE print_templates SET data = json_set(data, '$.paper.wMm', 210, '$.paper.hMm', 297)
  WHERE CASE WHEN json_valid(data) THEN
    CASE WHEN json_type(data) = 'object' AND json_type(data, '$.paper') = 'object'
      AND json_type(data, '$.paper.wMm') IN ('integer', 'real') AND json_type(data, '$.paper.hMm') IN ('integer', 'real')
      THEN abs(json_extract(data, '$.paper.wMm') - 209.9028) < 0.05 AND abs(json_extract(data, '$.paper.hMm') - 297.0389) < 0.05
    ELSE 0 END
  ELSE 0 END;
  `);
}
