import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import type { TenantTable } from "../org/tables.ts";
import { safeJoin } from "../util/safe-path.ts";
import { type FileManifest, collectFiles, executeCopy, listTargetFiles, nonDefaultLanguageFiles, orgFilesDir, planCopy, sourceOrgRoot, verifyCopy } from "./files.ts";
import { type SourceSnapshot, openSourceSnapshot } from "./source.ts";
import { type TableCount, type TargetState, TransferRefused, assertAppStopped, assertRlsRole, importDatabase, markFilesDone, readTargetForFiles } from "./target.ts";

/**
 * SQLite → Postgres aktarımı (plan §S12; komut `src/bin/aktar-pg.ts`, sarmalayıcı `Platform/scripts/tagpress-aktar.ps1`).
 * Sıra: kaynağın anlık kopyası (kaynak değişmez) → dosya listesi ve denetimleri (bağlantı, yol) → tek işlemde veritabanı
 * (denetim, yazma, doğrulama; `--kuru` ise geri alınır) → dosya kopyası + özet doğrulaması → işaret "tamam" → rapor.
 * Dosya adımı yarıda kalırsa veritabanı aktarılmış kalır; `--yalniz-dosyalar` yalnız eksik dosyaları kopyalar (aynı içerikli
 * var olanları atlar, farklı içerikliyi ezmez), kaynağın dosya listesi aktarımdakiyle aynı değilse durur ve önceki koşunun
 * silemediği ilk açılış dili klasörünü (işaretteki `seed`; yalnız ürünle gelen içerikse) siler.
 * Uygulama (aynı rolle veritabanına bağlı oturum) açıkken hiçbir kipte çalışmaz (`assertAppStopped`).
 */

export interface TransferOptions {
  /** Kaynak veri klasörü (`studio.db` + firma klasörleri). */
  source: string;
  /** Hesap firma kimliği (hedef). */
  targetOrg: string;
  /** Uygulama rolüyle Postgres adresi (`DATABASE_URL`). */
  databaseUrl: string;
  /** Hedef dosya kökü (`TAGPRESS_DATA_DIR`). */
  dataDir: string;
  dryRun?: boolean;
  filesOnly?: boolean;
  /** Kaynak firma (çok firmalı yerel kurulumda). */
  sourceOrg?: string | null;
  now?: () => Date;
  log?: (msg: string) => void;
  tmpRoot?: string;
  /** Testler. */
  hooks?: { afterTable?: (table: TenantTable) => void | Promise<void>; beforeCommit?: () => void | Promise<void>; beforeFiles?: () => void };
}

export interface TransferReport {
  mode: "tam" | "yalniz-dosyalar";
  dryRun: boolean;
  source: { dir: string; version: { from: number; to: number }; org: { id: string; name: string }; orgCount: number; installKeys: string[] };
  target: { orgId: string; name: string; root: string };
  /** Veritabanı (yalnız tam kipte). */
  tables: TableCount[];
  state: TargetState | null;
  skippedOrgSettings: string[];
  files: { total: number; bytes: number; copied: number; existing: number; verified: number; notCopied: FileManifest["notCopied"]; hidden: string[] };
  seedFolderRemoved: string | null;
  committed: boolean;
}

export async function runTransfer(opts: TransferOptions): Promise<TransferReport> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const dryRun = !!opts.dryRun;
  const targetRoot = orgFilesDir(path.resolve(opts.dataDir), opts.targetOrg);
  // Hedef dosya kökü kaynağın içinde (ya da kaynak hedefin içinde) olamaz: kaynak klasöre hiçbir şey yazılmaz.
  const within = (a: string, b: string) => {
    const rel = path.relative(path.resolve(a), path.resolve(b));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (within(opts.source, opts.dataDir) || within(opts.dataDir, opts.source)) {
    throw new TransferRefused(`Hedef dosya klasörü (TAGPRESS_DATA_DIR ${path.resolve(opts.dataDir)}) kaynak klasörle iç içe olamaz (${path.resolve(opts.source)}).`);
  }
  log(`kaynak: ${path.resolve(opts.source)}`);
  const snap: SourceSnapshot = openSourceSnapshot(opts.source, { orgId: opts.sourceOrg ?? null, ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}) });
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  let connected = false;
  try {
    log(`anlık kopya: sürüm ${snap.version.from} → ${snap.version.to}, kaynak firma ${snap.org.id} (${snap.org.name})`);
    const sourceRoot = sourceOrgRoot(snap.dir, { orgId: snap.org.id, layout: snap.layout, legacyOwner: snap.legacyOwner });
    const manifest = collectFiles(sourceRoot);
    log(`dosyalar: ${manifest.files.length} (${manifest.bytes} bayt)`);
    await client.connect();
    connected = true;
    await assertRlsRole(client);
    // Uygulama açıkken aktarılmaz (her kipte; veritabanı adımı işlem içinde ve commit'ten önce yeniden denetler).
    await assertAppStopped(client);

    const report: TransferReport = {
      mode: opts.filesOnly ? "yalniz-dosyalar" : "tam",
      dryRun,
      source: { dir: snap.dir, version: snap.version, org: snap.org, orgCount: snap.orgCount, installKeys: snap.installKeys },
      target: { orgId: opts.targetOrg, name: "", root: targetRoot },
      tables: [],
      state: null,
      skippedOrgSettings: [],
      files: { total: manifest.files.length, bytes: manifest.bytes, copied: 0, existing: 0, verified: 0, notCopied: manifest.notCopied, hidden: manifest.hidden },
      seedFolderRemoved: null,
      committed: false,
    };

    if (opts.filesOnly) {
      const { company, marker } = await readTargetForFiles(client, opts.targetOrg);
      report.target.name = company.name;
      if (marker.files.digest !== manifest.digest) {
        throw new TransferRefused(
          `Kaynağın dosyaları veritabanı aktarımındakiyle aynı değil (aktarımda ${marker.files.count}, şimdi ${manifest.files.length} dosya). Aktarımdan sonra yerel TagPress kullanılmış olabilir; dosyalar kopyalanmadı.`,
        );
      }
      // Önceki koşu ilk açılış dilinin klasörünü silmeden düştüyse: klasör (yalnız ürünle gelen içerikse) şimdi silinir.
      const seedDir = marker.seed?.languageId ? seedFolder(targetRoot, marker.seed.languageId) : null;
      if (seedDir && existsSync(seedDir)) assertSeedFolderDefault(seedDir, "Dosyalar kopyalanmadı.");
      const plan = planCopy(manifest, targetRoot);
      report.files.existing = plan.existing.length;
      if (dryRun) {
        report.files.copied = plan.copy.length;
        return report;
      }
      if (seedDir) report.seedFolderRemoved = removeSeedFolder(seedDir);
      executeCopy(plan, sourceRoot, targetRoot, (d, t) => log(`dosya ${d}/${t}`));
      report.files.copied = plan.copy.length;
      report.files.verified = verifyCopy(manifest, targetRoot);
      await markFilesDone(client, opts.targetOrg, now());
      report.committed = true;
      return report;
    }

    const result = await importDatabase(client, snap, opts.targetOrg, {
      dryRun,
      now,
      log,
      ...(opts.hooks?.afterTable ? { afterTable: opts.hooks.afterTable } : {}),
      ...(opts.hooks?.beforeCommit ? { beforeCommit: opts.hooks.beforeCommit } : {}),
      marker: {
        source: { orgId: snap.org.id, name: snap.org.name, dir: snap.dir, version: snap.version, rawDigest: snap.rawDigest },
        files: { count: manifest.files.length, bytes: manifest.bytes, digest: manifest.digest, state: "bekliyor" },
      },
      checkTargetFiles: (state) => {
        // Hedef klasör boş olmalı; varsayılan içerikte yalnız o dilin klasörü (`diller/<dil>/`) olabilir, içinde de yalnız
        // ürünle gelen dosyalar (kullanıcının yüklediği font, değiştirdiği şablon silinmez).
        const allowed = state.kind === "seed" && state.languageId ? `diller/${state.languageId}/` : null;
        const present = listTargetFiles(targetRoot).filter((rel) => !(allowed && rel.startsWith(allowed)));
        if (present.length) {
          throw new TransferRefused(`Hedef firma klasöründe dosya var (${present.length}; ör. ${present.slice(0, 3).join(", ")}): ${targetRoot}. Dolu klasöre aktarılmaz. Hiçbir şey yazılmadı.`);
        }
        if (!allowed || state.kind !== "seed" || !state.languageId) return;
        assertSeedFolderDefault(seedFolder(targetRoot, state.languageId), "Hiçbir şey yazılmadı.");
        // Kaynak dosyalarından biri varsayılan dilin klasörüne düşmesin (dil kimlikleri farklıdır; yine de denetlenir).
        if (manifest.files.some((f) => f.rel.startsWith(allowed))) throw new Error(`Kaynak dosyaları varsayılan dilin klasörüyle çakışıyor: ${allowed}`);
      },
    });
    const seedLanguage = result.state.kind === "seed" ? result.state.languageId : null;
    report.target.name = result.company.name;
    report.tables = result.tables;
    report.state = result.state;
    report.skippedOrgSettings = result.skippedOrgSettings;
    if (dryRun) {
      report.files.copied = manifest.files.length;
      return report;
    }
    report.committed = true;

    try {
      opts.hooks?.beforeFiles?.();
      if (seedLanguage) report.seedFolderRemoved = removeSeedFolder(seedFolder(targetRoot, seedLanguage));
      const plan = planCopy(manifest, targetRoot);
      report.files.existing = plan.existing.length;
      executeCopy(plan, sourceRoot, targetRoot, (d, t) => log(`dosya ${d}/${t}`));
      report.files.copied = plan.copy.length;
      report.files.verified = verifyCopy(manifest, targetRoot);
      await markFilesDone(client, opts.targetOrg, now());
    } catch (err) {
      throw new FilesIncomplete(
        `Veritabanı aktarıldı, dosya kopyası tamamlanmadı: ${err instanceof Error ? err.message : String(err)}. Sorunu giderip aynı komutu --yalniz-dosyalar ile yeniden çalıştırın.`,
        report,
      );
    }
    return report;
  } finally {
    if (connected) await client.end().catch(() => undefined);
    snap.close();
  }
}

/** İlk açılış dilinin klasörü (`diller/<dil>`, firma kökünün içinde). */
function seedFolder(targetRoot: string, languageId: string): string {
  const dir = safeJoin(targetRoot, `diller/${languageId}`);
  if (!dir) throw new Error(`Varsayılan dilin klasörü firma klasörünün dışında: diller/${languageId}`);
  return dir;
}

/** Klasörde yalnız ürünle gelen dosyalar (ad ve özetle aynı) var mı; yoksa reddedilir (kullanıcının dosyası silinmez). */
function assertSeedFolderDefault(dir: string, tail: string): void {
  const odd = nonDefaultLanguageFiles(dir);
  if (odd.length) {
    throw new TransferRefused(
      `Hedefteki ilk açılış dilinin klasöründe ürünle gelmeyen ya da değiştirilmiş dosya var (${odd.length}; ör. ${odd.slice(0, 3).join(", ")}): ${dir}. Platformda yüklenmiş ya da değiştirilmiş olabilir; silinmez. ${tail}`,
    );
  }
}

/** İlk açılış dilinin klasörünü siler (yalnız ürünle gelen içerikse). Silinen klasör ya da (yoksa) null. */
function removeSeedFolder(dir: string): string | null {
  if (!existsSync(dir)) return null;
  assertSeedFolderDefault(dir, "Dosyalar kopyalanmadı.");
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** Veritabanı aktarıldı, dosyalar eksik (yeniden deneme: `--yalniz-dosyalar`). */
export class FilesIncomplete extends Error {
  constructor(
    message: string,
    readonly report: TransferReport,
  ) {
    super(message);
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

/** Okunur rapor (Türkçe, düz metin). */
export function formatReport(r: TransferReport): string {
  const out: string[] = [];
  const head = r.dryRun ? "KURU ÇALIŞMA: her şey denendi ve doğrulandı, hiçbir şey yazılmadı" : r.committed ? "TAMAM" : "YARIM";
  out.push(`TagPress aktarımı (${r.mode === "tam" ? "veritabanı + dosyalar" : "yalnız dosyalar"}): ${head}`);
  out.push(`Kaynak: ${r.source.dir} (veritabanı sürümü ${r.source.version.from} → ${r.source.version.to}; firma "${r.source.org.name}"${r.source.orgCount > 1 ? `, kaynakta ${r.source.orgCount} firma` : ""})`);
  out.push(`Hedef firma: ${r.target.orgId}${r.target.name ? ` "${r.target.name}"` : ""}; dosya klasörü ${r.target.root}`);
  if (r.state?.kind === "seed") out.push(`Hedefteki ilk açılış içeriği (varsayılan dil, ${r.state.templates} şablon) silindi, yerine kaynak yazıldı.`);
  else if (r.seedFolderRemoved) out.push(`Önceki koşudan kalan ilk açılış dili klasörü silindi: ${r.seedFolderRemoved}`);
  if (r.tables.length) {
    const w = Math.max(...r.tables.map((t) => t.table.length), 5);
    out.push("");
    out.push(`${"Tablo".padEnd(w)}  ${"Kaynak".padStart(7)}  ${"Hedef".padStart(7)}`);
    for (const t of [...r.tables].sort((a, b) => a.table.localeCompare(b.table))) {
      out.push(`${t.table.padEnd(w)}  ${String(t.source).padStart(7)}  ${String(t.target).padStart(7)}${t.source === t.target ? "" : "  FARK"}`);
    }
    const s = r.tables.reduce((a, t) => a + t.source, 0);
    const d = r.tables.reduce((a, t) => a + t.target, 0);
    out.push(`${"Toplam".padEnd(w)}  ${String(s).padStart(7)}  ${String(d).padStart(7)}`);
    out.push("");
  }
  const f = r.files;
  if (r.dryRun) out.push(`Dosyalar: ${f.total} (${mb(f.bytes)}) kopyalanacak${f.existing ? `, ${f.existing} hedefte zaten aynı` : ""}.`);
  else out.push(`Dosyalar: ${f.total} (${mb(f.bytes)}); kopyalanan ${f.copied}, zaten aynı ${f.existing}, özeti doğrulanan ${f.verified}.`);
  const not: string[] = [];
  if (r.source.installKeys.length) not.push(`kurulum ayarları (${r.source.installKeys.join(", ")})`);
  if (r.skippedOrgSettings.length) not.push(`platform işaretleri (${r.skippedOrgSettings.join(", ")})`);
  if (f.notCopied.length) not.push(`kurulum düzeyi dosyalar (${f.notCopied.map((n) => `${n.name}: ${n.files}`).join(", ")})`);
  if (f.hidden.length) not.push(`gizli/geçici dosyalar (${f.hidden.length}: ${f.hidden.slice(0, 5).join(", ")})`);
  if (not.length) out.push(`Aktarılmayanlar: ${not.join("; ")}.`);
  return out.join("\n");
}
