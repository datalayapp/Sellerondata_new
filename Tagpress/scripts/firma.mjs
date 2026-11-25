/**
 * `pnpm firma`: kurulumdaki firmalar (SUNUCU-PLANI §2.7). Uygulama KAPALIYKEN çalışır; veri klasörü `TAGPRESS_DATA_DIR`
 * (yoksa `data/`). Deneme için geçici klasörle: `TAGPRESS_DATA_DIR=<kopya> pnpm firma ekle "Deneme"`, sonra
 * `TAGPRESS_ORG=<kimlik> TAGPRESS_TENANCY=strict PORT=5499` ile açılış.
 *
 *   pnpm firma liste                  firmalar: kimlik, ad, kaynak, dil sayısı, varsayılan/sahip işareti
 *   pnpm firma ekle <ad>              yeni firma + varsayılan içerik (dil v1 yayınlanmış, şablonlar, fontlar)
 *   pnpm firma adlandir <kimlik> <ad> firmanın adını değiştirir
 *
 * Silme yok: firma verisini kalıcı silmek ayrı ve incelemeli bir iştir. Kurulumun varsayılan firmasını değiştirmez.
 * Veritabanında bekleyen göç varsa sunucunun açılışındaki gibi önce yedek alınır, sonra göç uygulanır.
 *
 * Çıkış kodu: 0 tamam, 1 hata (uygulama açık, firma yok …), 2 kullanım hatası.
 */
import { existsSync } from "node:fs";
import { dataPaths, loadConfig } from "../apps/server/src/config.ts";
import { openDatabase, userVersion } from "../apps/server/src/db/database.ts";
import { MIGRATIONS } from "../apps/server/src/db/migrations/index.ts";
import { runInOrg } from "../apps/server/src/org/context.ts";
import { OrgRoots } from "../apps/server/src/org/roots.ts";
import { OrgSeeder } from "../apps/server/src/org/seed.ts";
import { OrgService } from "../apps/server/src/org/service.ts";
import { TenantDb } from "../apps/server/src/org/tenant-db.ts";
import { Tenancy } from "../apps/server/src/org/tenancy.ts";
import { SettingsService } from "../apps/server/src/services/settings.ts";
import { systemClock } from "../apps/server/src/util/clock.ts";

const USAGE = `Kullanım:
  pnpm firma liste
  pnpm firma ekle <ad>
  pnpm firma adlandir <kimlik> <ad>`;

/** Uygulama bu makinede açık mı (sağlık ucu)? Açıksa veritabanına dokunulmaz. */
async function appRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json().catch(() => null);
    return res.ok && body?.ok === true;
  } catch {
    return false;
  }
}

function open(config) {
  const paths = dataPaths(config.dataDir);
  const fresh = !existsSync(paths.db);
  const db = openDatabase(paths.db, { backupDir: paths.backups });
  const tenancy = new Tenancy({ mode: "strict" });
  const tdb = new TenantDb(db, tenancy);
  const settings = new SettingsService(tdb);
  const roots = new OrgRoots(config.dataDir, settings, tenancy);
  const seeder = new OrgSeeder({ db: tdb, clock: systemClock, dataDir: config.dataDir, rootOf: (id) => roots.rootOf(id) });
  const orgs = new OrgService(tdb, systemClock, () => roots.reload(), seeder);
  return { db, tdb, orgs, fresh };
}

function languageCount(tdb, orgId) {
  return runInOrg(orgId, () => Number(tdb.prepare("SELECT COUNT(*) AS n FROM languages WHERE org_id = $org AND deleted_at IS NULL").get()?.n ?? 0));
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || !["liste", "ekle", "adlandir"].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  if ((cmd === "ekle" && args.length !== 1) || (cmd === "adlandir" && args.length !== 2) || (cmd === "liste" && args.length)) {
    console.error(USAGE);
    return 2;
  }
  const name = cmd === "ekle" ? args[0] : cmd === "adlandir" ? args[1] : "";
  if (cmd !== "liste" && !name.trim()) {
    console.error("Firma adı boş olamaz.");
    return 2;
  }
  const config = loadConfig();
  if (await appRunning(config.port)) {
    console.error(`Uygulama açık (port ${config.port}). pnpm firma yalnız uygulama kapalıyken çalışır; önce uygulamayı kapatın.`);
    return 1;
  }
  const { db, tdb, orgs, fresh } = open(config);
  try {
    if (fresh) console.log(`Yeni veritabanı açıldı: ${config.dataDir} (göç ${userVersion(db)}/${MIGRATIONS.length}).`);
    if (cmd === "liste") {
      const list = orgs.list();
      if (!list.length) {
        console.log("Kurulumda firma yok (uygulamanın ilk açılışı \"Firmam\"ı açar).");
        return 0;
      }
      const def = orgs.defaultOrgId();
      const owner = orgs.ownerOrgId();
      for (const o of list) {
        const marks = [o.id === def ? "varsayılan" : "", o.id === owner ? "sahip" : "", o.closedAt ? "kapalı" : ""].filter(Boolean);
        console.log(`${o.id}  ${o.name}  (${o.source}, ${o.createdAt.slice(0, 10)}, ${languageCount(tdb, o.id)} dil${marks.length ? `, ${marks.join(", ")}` : ""})`);
      }
      return 0;
    }
    if (cmd === "ekle") {
      const org = orgs.create({ name, source: "local" });
      const langs = languageCount(tdb, org.id);
      console.log(`Firma açıldı: ${org.id}  ${org.name}  (varsayılan içerik: ${langs} dil)`);
      console.log(`Denemek için (uygulama kapalıyken): TAGPRESS_ORG=${org.id} TAGPRESS_TENANCY=strict PORT=5499 ile açın.`);
      return 0;
    }
    const [id] = args;
    if (!orgs.get(id)) {
      console.error(`Firma bulunamadı: ${id}`);
      return 1;
    }
    const org = orgs.rename(id, name);
    console.log(`Firmanın adı değişti: ${org.id}  ${org.name}`);
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`Hata: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
