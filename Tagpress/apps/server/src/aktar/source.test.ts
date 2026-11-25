import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../db/database.ts";
import { MIGRATIONS } from "../db/migrations/index.ts";
import { TENANT_TABLES } from "../org/tables.ts";
import { ORG_DIRS, collectFiles, executeCopy, planCopy, sourceOrgRoot, verifyCopy } from "./files.ts";
import { openSourceSnapshot, readSourceTable } from "./source.ts";
import { INSTALL_FILES, LANG, OTHER, OWNER, OWNER_FILES, buildSource } from "./test-fixture.ts";
import { fileHashes, sha, treeState } from "./test-tree.ts";

/** Aktarımın veritabanısız parçaları: kaynağın anlık kopyası (kaynak değişmez) ve dosya listesi / kopyası (yol taşması yok). */

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodRecursive(d, 0o666);
    } catch {
      // yoksay
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function chmodRecursive(dir: string, mode: number): void {
  for (const [rel] of treeState(dir)) if (!rel.endsWith("/")) chmodSync(path.join(dir, ...rel.split("/")), mode);
}

describe("kaynağın anlık kopyası", () => {
  it("salt okunur kaynaktan okur, kaynağa dokunmaz; sahibin satırları, başka firmanınkiler yok", () => {
    const src = tmp("aktar-kaynak-");
    const counts = buildSource(src);
    chmodRecursive(src, 0o444); // dosyalar salt okunur: araç yazmaya kalkarsa düşer
    const before = treeState(src);
    const snap = openSourceSnapshot(src);
    try {
      expect(snap.org).toEqual({ id: OWNER, name: "Firmam" });
      expect(snap.orgCount).toBe(2);
      expect(snap.version).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
      expect(snap.installKeys).toEqual(["install.defaultOrgId", "install.ownerOrgId", "key:anthropic"]);
      for (const t of TENANT_TABLES) {
        const rows = readSourceTable(snap, t).rows.length;
        expect(rows, t).toBe(t === "org_settings" ? counts[t] + 1 : counts[t]);
      }
      const langs = readSourceTable(snap, "languages");
      expect(langs.rows.map((r) => r[langs.columns.indexOf("id")])).toEqual([LANG]);
      // Tamsayılar hassasiyet kaybı olmadan.
      const ai = readSourceTable(snap, "ai_calls");
      expect(ai.rows.map((r) => r[ai.columns.indexOf("input_tokens")])).toContain(9007199254740993n);
    } finally {
      snap.close();
    }
    expect(treeState(src)).toEqual(before);
  });

  it("eski sürümlü kaynağı yalnız anlık kopyada göçe getirir (göç 9 firmayı kopyada açar)", () => {
    const src = tmp("aktar-eski-");
    const file = path.join(src, "studio.db");
    const db = new DatabaseSync(file);
    migrate(db, { to: 8 });
    db.prepare("INSERT INTO languages (id, name, created_at) VALUES ('benim-tarzim', 'Benim', '2026-10-09T00:00:00Z')").run();
    db.close();
    const before = treeState(src);
    const snap = openSourceSnapshot(src);
    try {
      expect(snap.version).toEqual({ from: 8, to: MIGRATIONS.length });
      expect(snap.org.name).toBe("Firmam");
      expect(readSourceTable(snap, "languages").rows).toHaveLength(1);
    } finally {
      snap.close();
    }
    expect(treeState(src)).toEqual(before);
    const check = new DatabaseSync(file, { readOnly: true });
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
    check.close();
  });

  it("WAL'da duran (boşaltılmamış) yazılar da okunur; kaynağın dosyaları değişmez", () => {
    const src = tmp("aktar-wal-");
    buildSource(src);
    // Açık bir bağlantı WAL'ın boşaltılmasını engeller: ikinci bağlantının yazısı yalnız `-wal` dosyasında kalır.
    const holder = new DatabaseSync(path.join(src, "studio.db"));
    holder.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    holder.prepare("SELECT COUNT(*) FROM languages").get();
    const writer = new DatabaseSync(path.join(src, "studio.db"));
    writer.prepare("INSERT INTO batches (id, language_id, name, created_at, org_id) VALUES ('b-wal', ?, 'WAL', 'x', ?)").run(LANG, OWNER);
    writer.close();
    try {
      const before = treeState(src);
      expect([...before.keys()]).toContain("studio.db-wal");
      const snap = openSourceSnapshot(src);
      try {
        const b = readSourceTable(snap, "batches");
        expect(b.rows.map((r) => r[b.columns.indexOf("id")])).toContain("b-wal");
      } finally {
        snap.close();
      }
      expect(treeState(src)).toEqual(before);
    } finally {
      holder.close();
    }
  });

  it("kaynak firma seçilebilir; bilinmeyen firma ve veritabanısız klasör açık hata", () => {
    const src = tmp("aktar-secim-");
    buildSource(src);
    const snap = openSourceSnapshot(src, { orgId: OTHER });
    try {
      expect(snap.org.id).toBe(OTHER);
      expect(readSourceTable(snap, "languages").rows).toHaveLength(1);
    } finally {
      snap.close();
    }
    expect(() => openSourceSnapshot(src, { orgId: "yok" })).toThrow(/Kaynak firma bulunamadı/);
    expect(() => openSourceSnapshot(tmp("aktar-bos-"))).toThrow(/studio\.db yok/);
  });
});

describe("dosya listesi ve kopya", () => {
  it("yalnız firma klasörleri listelenir; kurulum düzeyi ve gizli dosyalar raporda", () => {
    const src = tmp("aktar-dosya-");
    buildSource(src);
    const root = sourceOrgRoot(src, { orgId: OWNER, layout: 1, legacyOwner: OWNER });
    expect(root).toBe(path.resolve(src));
    const m = collectFiles(root);
    expect(m.files.map((f) => f.rel).sort()).toEqual(Object.keys(OWNER_FILES).sort());
    expect(m.hidden).toEqual([]);
    const names = m.notCopied.map((n) => n.name);
    for (const n of ["ana-anahtar.json", "firmalar", "ortak", "studio.db", "yedek/anahtarlar.dpapi.json", "yedek/db-2026-10-10-son", ".gizli-not"]) expect(names).toContain(n);
    expect(ORG_DIRS).toContain("yedek/sablonlar");
    // Düzen 2 ya da sahip olmayan firma: `firmalar/<firma>`.
    expect(sourceOrgRoot(src, { orgId: OTHER, layout: 1, legacyOwner: OWNER })).toBe(path.join(path.resolve(src), "firmalar", OTHER));
    expect(sourceOrgRoot(src, { orgId: OWNER, layout: 2, legacyOwner: OWNER })).toBe(path.join(path.resolve(src), "firmalar", OWNER));
    expect(Object.keys(INSTALL_FILES).length).toBeGreaterThan(0);
  });

  it("kopya özetle doğrulanır; var olan farklı dosyanın üzerine yazılmaz; yeniden denemede aynılar atlanır", () => {
    const src = tmp("aktar-kopya-");
    buildSource(src);
    const m = collectFiles(src);
    const target = path.join(tmp("aktar-hedef-"), "firmalar", "f1");
    const first = planCopy(m, target);
    expect(first.copy).toHaveLength(m.files.length);
    executeCopy({ copy: first.copy.slice(0, 2), existing: [] }, src, target);
    const again = planCopy(m, target);
    expect(again.existing).toHaveLength(2);
    executeCopy(again, src, target);
    expect(verifyCopy(m, target)).toBe(m.files.length);
    expect(fileHashes(target)).toEqual(Object.fromEntries(Object.entries(OWNER_FILES).map(([k, v]) => [k, sha(v)])));
    // Geçici kopya adı kalmadı.
    expect(Object.keys(fileHashes(target)).some((k) => k.includes(".aktar-"))).toBe(false);
    // Hedefte içerik değişirse: üzerine yazılmaz, doğrulama düşer.
    const rel = Object.keys(OWNER_FILES)[0]!;
    writeFileSync(path.join(target, ...rel.split("/")), "başka");
    expect(() => planCopy(m, target)).toThrow(/üzerine yazılmaz/);
    expect(() => verifyCopy(m, target)).toThrow(/doğrulaması geçmedi/);
  });

  it("yol taşması: hedef kökün dışına çıkan yol reddedilir, dışarıya hiçbir şey yazılmaz", () => {
    const base = tmp("aktar-tasma-");
    const target = path.join(base, "firmalar", "f1");
    for (const rel of ["../disari.txt", "../../disari.txt", "a/../../disari.txt", "C:/disari.txt", "/disari.txt", "a\\..\\..\\disari.txt"]) {
      const m = { root: base, files: [{ rel, size: 1, sha256: "x", mtimeMs: 0 }], bytes: 1, digest: "x", notCopied: [], hidden: [] };
      expect(() => planCopy(m, target), rel).toThrow(/dışına çıkıyor/);
    }
    expect(treeState(base).size).toBe(0);
  });
});

