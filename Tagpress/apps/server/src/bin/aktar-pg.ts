/**
 * SQLite → Postgres aktarımı (plan §S12): yerel kipin veri klasörünü platformdaki bir firmaya taşır.
 *
 *   pnpm aktar:pg --kaynak <veri klasörü> --hedef-firma <Hesap firma kimliği> [--kuru] [--yalniz-dosyalar] [--kaynak-firma <kimlik>]
 *
 * Ortam: `DATABASE_URL` (uygulama rolü `sod_tagpress`; RLS altında yazar), `TAGPRESS_DATA_DIR` (hedef dosya kökü; zorunlu, kaynakla
 * iç içe olamaz). Kapta `tagpress-aktar` servisi (`Platform/scripts/tagpress-aktar.ps1`), kaynak `/kaynak` salt okunur bağlı.
 * Platformdaki TagPress uygulaması durmuş olmalı (aynı rolle bağlı oturum varsa reddedilir; sarmalayıcı durdurur ve sonra
 * yeniden başlatır). Kaynak hiçbir adımda değişmez (`src/aktar/source.ts`). Çıkış kodu: 0 tamam (ya da kuru çalışma), 1 hata (hiçbir şey yazılmadı),
 * 2 reddedildi (hedef dolu, ikinci koşu, firma yok …; hiçbir şey yazılmadı), 3 veritabanı aktarıldı ama dosyalar eksik
 * (`--yalniz-dosyalar` ile yeniden çalıştırın).
 */
import { parseArgs } from "node:util";
import { FilesIncomplete, formatReport, runTransfer } from "../aktar/transfer.ts";
import { TransferRefused } from "../aktar/target.ts";

const USAGE = "Kullanım: aktar-pg --kaynak <veri klasörü> --hedef-firma <firma kimliği> [--kuru] [--yalniz-dosyalar] [--kaynak-firma <kimlik>]";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      kaynak: { type: "string" },
      "hedef-firma": { type: "string" },
      "kaynak-firma": { type: "string" },
      kuru: { type: "boolean", default: false },
      "yalniz-dosyalar": { type: "boolean", default: false },
      yardim: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.yardim) {
    console.log(USAGE);
    return 0;
  }
  const source = values.kaynak?.trim();
  const targetOrg = values["hedef-firma"]?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dataDir = process.env.TAGPRESS_DATA_DIR?.trim();
  const missing = [!source && "--kaynak", !targetOrg && "--hedef-firma", !databaseUrl && "DATABASE_URL", !dataDir && "TAGPRESS_DATA_DIR"].filter(Boolean);
  if (missing.length) {
    console.error(`[tagpress-aktar] eksik: ${missing.join(", ")}\n${USAGE}`);
    return 1;
  }
  try {
    const report = await runTransfer({
      source: source!,
      targetOrg: targetOrg!,
      databaseUrl: databaseUrl!,
      dataDir: dataDir!,
      dryRun: values.kuru,
      filesOnly: values["yalniz-dosyalar"],
      sourceOrg: values["kaynak-firma"]?.trim() || null,
      log: (m) => console.error(`[tagpress-aktar] ${m}`),
    });
    console.log(formatReport(report));
    return 0;
  } catch (err) {
    if (err instanceof FilesIncomplete) {
      console.log(formatReport(err.report));
      console.error(`[tagpress-aktar] YARIM: ${err.message}`);
      return 3;
    }
    console.error(`[tagpress-aktar] ${err instanceof TransferRefused ? "REDDEDİLDİ" : "HATA"}: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof TransferRefused ? 2 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[tagpress-aktar] HATA: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
