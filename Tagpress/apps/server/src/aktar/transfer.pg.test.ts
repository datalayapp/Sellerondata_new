import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestAuthority, createTestAuthority } from "@sellerondata/auth-kit/testing";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.ts";
import { PG_APP_ROLE } from "../db/pg/migrate.ts";
import { SEEDED_KEY } from "../org/platform-service.ts";
import { TENANT_TABLES, type TenantTable } from "../org/tables.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../services/secret-box.ts";
import { type TestPgDb, createTestDb } from "../test/pg.ts";
import { ManualClock } from "../util/clock.ts";
import { TRANSFER_KEY, TransferRefused } from "./target.ts";
import { LANG, OWNER_FILES, buildSource } from "./test-fixture.ts";
import { fileHashes, makeDirLink, removeDirLink, sha, treeState } from "./test-tree.ts";
import { FilesIncomplete, type TransferOptions, formatReport, runTransfer } from "./transfer.ts";

/**
 * Aktarım aracı (plan TP-AKTAR, §S12) gerçek platform şemasında (`pnpm test:pg`): uygulama rolüyle, RLS altında. Kabul:
 * kaynak salt okunur ve önce = sonra; tablo tablo satır sayısı ve içerik eşit; dosya sayısı ve özetleri eşit; dolu hedef ve ikinci
 * koşu reddedilir; yarıda kalan veritabanı aktarımı hedefte satır bırakmaz (tek işlem); `--yalniz-dosyalar` yeniden denemesi;
 * başka firma hiçbir şey görmez ve hiçbir şeyi değişmez; ilk açılışın varsayılan içeriği (yalnız o) yerini kaynağa bırakır.
 */

let db: TestPgDb;
let su: pg.Client;
let work: string;
let source: string;
let expected: Record<TenantTable, number>;
let sourceBefore: Map<string, string>;

beforeAll(async () => {
  db = await createTestDb({ template: false, migrate: true, orgs: false });
  su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  work = mkdtempSync(path.join(os.tmpdir(), "tagpress-aktar-pg-"));
  source = path.join(work, "kaynak");
  expected = buildSource(source);
  sourceBefore = treeState(source);
}, 120_000);

afterAll(async () => {
  await su?.end();
  await db?.drop();
  if (work) rmSync(work, { recursive: true, force: true });
});

const company = async (name = "Hedef Firma") => {
  const id = randomUUID();
  await su.query(`INSERT INTO tagpress."Company" ("id", "name") VALUES ($1, $2)`, [id, name]);
  return id;
};
const dataDir = () => {
  const d = path.join(work, `veri-${randomUUID().slice(0, 8)}`);
  mkdirSync(d);
  return d;
};
const opts = (targetOrg: string, dir: string, extra: Partial<TransferOptions> = {}): TransferOptions => ({
  source,
  targetOrg,
  databaseUrl: db.appUrl,
  dataDir: dir,
  now: () => new Date("2026-11-22T06:00:00.000Z"),
  ...extra,
});
const counts = async (orgId: string) => {
  const out: Record<string, number> = {};
  for (const t of TENANT_TABLES) out[t] = Number((await su.query(`SELECT count(*)::int AS n FROM tagpress."${t}" WHERE org_id = $1`, [orgId])).rows[0].n);
  return out;
};
const total = async (orgId: string) => Object.values(await counts(orgId)).reduce((a, b) => a + b, 0);
const setting = async (orgId: string, key: string) => {
  const r = (await su.query(`SELECT value FROM tagpress.org_settings WHERE org_id = $1 AND key = $2`, [orgId, key])).rows[0] as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as Record<string, unknown>) : null;
};
/** Aktarılan satırları siler (süper kullanıcı; kaynak kimlikleri genel benzersiz olduğundan sonraki testler aynı kaynağı yeniden aktarabilsin). */
const purge = async (orgId: string) => {
  for (const t of TENANT_TABLES) await su.query(`DELETE FROM tagpress."${t}" WHERE org_id = $1`, [orgId]);
};
const orgDir = (dir: string, orgId: string) => path.join(dir, "firmalar", orgId.toLowerCase());
const expectedFiles = Object.fromEntries(Object.entries(OWNER_FILES).map(([k, v]) => [k, sha(v)]));
/** Uygulama rolünün bu veritabanındaki bağlantıları kapanana dek bekler (aktarım uygulama açıkken reddedilir). */
const appGone = async () => {
  for (let i = 0; i < 200; i++) {
    const n = (await su.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = $1`, [PG_APP_ROLE])).rows[0].n;
    if (!n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("uygulama rolünün bağlantıları kapanmadı");
};
/** Bütün tabloların bir firmaya ait satırlarının izi (süper kullanıcı; başka firmanın değişmediğini denetler). */
const orgRows = async (orgId: string) => {
  const out: Record<string, unknown[]> = {};
  for (const t of TENANT_TABLES) out[t] = (await su.query(`SELECT * FROM tagpress."${t}" WHERE org_id = $1 ORDER BY 1`, [orgId])).rows;
  return out;
};

describe("tam aktarım", () => {
  it("tablo tablo sayı ve içerik eşit, dosyalar özetle eşit, kaynak değişmez, başka firma etkilenmez", async () => {
    const bystander = await company("Başka Firma");
    await su.query(`INSERT INTO tagpress.languages (id, name, created_at, org_id) VALUES ('baskasinin-dili', 'B', 'x', $1)`, [bystander]);
    const bystanderBefore = await orgRows(bystander);
    const target = await company();
    const dir = dataDir();
    mkdirSync(path.join(orgDir(dir, bystander), "diller", "baskasinin-dili"), { recursive: true });
    writeFileSync(path.join(orgDir(dir, bystander), "diller", "baskasinin-dili", "a.png"), "b");
    const bystanderFiles = treeState(orgDir(dir, bystander));

    const report = await runTransfer(opts(target, dir));
    expect(report.committed).toBe(true);
    expect(report.state).toEqual({ kind: "empty" });
    expect(report.target.name).toBe("Hedef Firma");
    for (const t of report.tables) {
      expect(t.target, t.table).toBe(t.source);
      expect(t.target, t.table).toBe(expected[t.table]);
    }
    expect(report.tables.map((t) => t.table).sort()).toEqual([...TENANT_TABLES].sort());
    const after = await counts(target);
    for (const t of TENANT_TABLES) expect(after[t], t).toBe(expected[t] + (t === "org_settings" ? 2 : 0)); // + iki işaret

    // İçerik: zor değerler, kimlik kuralları, sıra.
    const ai = (await su.query(`SELECT response, input_tokens, cost_usd, summary, member_id FROM tagpress.ai_calls WHERE id = 'ai-1'`)).rows[0];
    expect([...(ai.response as Buffer)]).toEqual([0, 1, 2, 255]);
    expect(String(ai.input_tokens)).toBe("9007199254740993");
    expect(ai.cost_usd).toBe(0.1234567890123);
    expect(ai.summary).toBe("özet 🎉");
    expect(ai.member_id).toBeNull();
    expect((await su.query(`SELECT text FROM tagpress.jobs WHERE id = 'j-1'`)).rows[0].text).toBe("Ayşe & Ali ❤️");
    expect((await su.query(`SELECT id FROM tagpress.design_session_entries WHERE org_id = $1 ORDER BY id`, [target])).rows.map((r) => Number(r.id))).toEqual([7, 9]);
    expect((await su.query(`SELECT entry_id FROM tagpress.profile_revisions WHERE org_id = $1`, [target])).rows[0].entry_id).toBe("9");
    expect((await su.query(`SELECT step FROM tagpress.job_log WHERE org_id = $1 ORDER BY id`, [target])).rows.map((r) => r.step)).toEqual(["start", "done", "start"]);
    expect((await su.query(`SELECT id FROM tagpress.gen_tasks WHERE org_id = $1 ORDER BY ins_seq`, [target])).rows.map((r) => r.id)).toEqual(["g-2", "g-1"]);
    expect((await su.query(`SELECT id FROM tagpress.print_pages WHERE org_id = $1 ORDER BY ins_seq`, [target])).rows.map((r) => r.id)).toEqual(["pp-2", "pp-1"]);
    // Kaynağın ikinci firması, kurulum ayarları ve platform işaretleri aktarılmaz.
    expect((await su.query(`SELECT id FROM tagpress.languages WHERE org_id = $1`, [target])).rows.map((r) => r.id)).toEqual([LANG]);
    expect((await su.query(`SELECT count(*)::int AS n FROM tagpress.settings`)).rows[0].n).toBe(0);
    expect(await setting(target, "platform.eski-isaret")).toBeNull();
    expect(report.skippedOrgSettings).toEqual(["platform.eski-isaret"]);
    expect(await setting(target, SEEDED_KEY)).toMatchObject({ languageId: null });
    expect(await setting(target, TRANSFER_KEY)).toMatchObject({ files: { count: Object.keys(OWNER_FILES).length, state: "tamam" } });

    // Korunan kimliğin dizisi ilerledi: uygulamanın yeni satırı çakışmaz.
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [target]);
      const id = (await app.query(`INSERT INTO tagpress.design_session_entries (session_id, at, kind, text, org_id) VALUES ('ds-1', 'x', 'note', 'yeni', $1) RETURNING id`, [target])).rows[0].id;
      expect(Number(id)).toBeGreaterThan(9);
      await app.query("ROLLBACK");
      // Başka firmanın bağlamında aktarılan hiçbir satır görünmez.
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [bystander]);
      expect((await app.query(`SELECT count(*)::int AS n FROM tagpress.jobs`)).rows[0].n).toBe(0);
      expect((await app.query(`SELECT id FROM tagpress.languages`)).rows.map((r) => r.id)).toEqual(["baskasinin-dili"]);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
      await appGone();
    }

    // Dosyalar: yalnız firma dosyaları, özetleri aynı; kurulum düzeyi dosyalar yok.
    expect(fileHashes(orgDir(dir, target))).toEqual(expectedFiles);
    expect(report.files).toMatchObject({ total: Object.keys(OWNER_FILES).length, copied: Object.keys(OWNER_FILES).length, verified: Object.keys(OWNER_FILES).length });
    expect(existsSync(path.join(dir, "ortak"))).toBe(false);
    expect(readFileSync(path.join(orgDir(dir, target), "onizleme", "v1.adj1.png"), "utf8")).toBe("onizleme-adj");

    // Kaynak önce = sonra; başka firma değişmedi.
    expect(treeState(source)).toEqual(sourceBefore);
    expect(await orgRows(bystander)).toEqual(bystanderBefore);
    expect(treeState(orgDir(dir, bystander))).toEqual(bystanderFiles);

    const text = formatReport(report);
    expect(text).toContain("TAMAM");
    expect(text).toMatch(/jobs\s+2\s+2/);
    expect(text).toContain("key:anthropic");

    // İkinci koşu reddedilir (veritabanı ve dosyalar değişmez).
    const before = await orgRows(target);
    const filesBefore = treeState(orgDir(dir, target));
    await expect(runTransfer(opts(target, dir))).rejects.toThrow(/zaten yapılmış/);
    // Aynı veri başka bir firmaya da aktarılamaz (kimlikler zaten var): işlem bütünüyle geri alınır.
    const other = await company();
    await expect(runTransfer(opts(other, dataDir()))).rejects.toThrow(/Kimlik çakışması/);
    expect(await total(other)).toBe(0);
    expect(await orgRows(target)).toEqual(before);
    expect(treeState(orgDir(dir, target))).toEqual(filesBefore);
    expect(treeState(source)).toEqual(sourceBefore);
    await purge(target);
  });
});

describe("reddedilenler ve yarıda kalanlar", () => {
  it("dolu hedef reddedilir; firma kaydı yoksa ve kapalıysa durur; RLS'yi aşan rol reddedilir", async () => {
    const full = await company();
    await su.query(`INSERT INTO tagpress.batches (id, language_id, name, created_at, org_id) VALUES ($1, 'l', 'b', 'x', $2)`, [`b-${full}`, full]);
    await expect(runTransfer(opts(full, dataDir()))).rejects.toThrow(/TagPress verisi var/);
    expect(await total(full)).toBe(1);

    await expect(runTransfer(opts(randomUUID(), dataDir()))).rejects.toThrow(/Merkez'den/);

    const closed = await company();
    await su.query(`UPDATE tagpress."Company" SET "closedAt" = now() WHERE id = $1`, [closed]);
    await expect(runTransfer(opts(closed, dataDir()))).rejects.toThrow(/kapalı/);

    const t = await company();
    await expect(runTransfer({ ...opts(t, dataDir()), databaseUrl: db.superUrl })).rejects.toBeInstanceOf(TransferRefused);
    expect(await total(t)).toBe(0);

    // Hedef klasörde dosya varsa (veritabanı boş olsa da) durur.
    const filled = await company();
    const dir = dataDir();
    mkdirSync(path.join(orgDir(dir, filled), "onizleme"), { recursive: true });
    writeFileSync(path.join(orgDir(dir, filled), "onizleme", "eski.png"), "x");
    await expect(runTransfer(opts(filled, dir))).rejects.toThrow(/klasöründe dosya var/);
    expect(await total(filled)).toBe(0);

    // Hedef dosya kökü kaynakla iç içe olamaz.
    await expect(runTransfer(opts(await company(), source))).rejects.toThrow(/iç içe/);
    await expect(runTransfer(opts(await company(), path.join(source, "alt")))).rejects.toThrow(/iç içe/);
    expect(treeState(source)).toEqual(sourceBefore);
  });

  it("kuru çalışma her şeyi dener ve doğrular, hiçbir şey yazmaz", async () => {
    const t = await company();
    const dir = dataDir();
    const report = await runTransfer(opts(t, dir, { dryRun: true }));
    expect(report.committed).toBe(false);
    expect(report.tables.every((x) => x.source === x.target && x.target === expected[x.table])).toBe(true);
    expect(await total(t)).toBe(0);
    expect(existsSync(orgDir(dir, t))).toBe(false);
    expect(formatReport(report)).toContain("KURU");
  });

  it("yarıda kalan veritabanı aktarımı hedefte hiçbir satır bırakmaz (tek işlem)", async () => {
    const t = await company();
    const dir = dataDir();
    await expect(
      runTransfer(
        opts(t, dir, {
          hooks: {
            afterTable: (table) => {
              if (table === "variants") throw new Error("deneme: yarıda kesildi");
            },
          },
        }),
      ),
    ).rejects.toThrow(/yarıda kesildi/);
    expect(await total(t)).toBe(0);
    expect(existsSync(orgDir(dir, t))).toBe(false);
    // Sonra temiz aktarım olur.
    expect((await runTransfer(opts(t, dir))).committed).toBe(true);
    await purge(t);
  });

  it("dosya adımı yarıda kalırsa --yalniz-dosyalar eksikleri tamamlar, farklı içeriği ezmez", async () => {
    const t = await company();
    const dir = dataDir();
    const err = await runTransfer(opts(t, dir, { hooks: { beforeFiles: () => { throw new Error("disk doldu"); } } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilesIncomplete);
    expect((err as Error).message).toMatch(/--yalniz-dosyalar/);
    expect(await setting(t, TRANSFER_KEY)).toMatchObject({ files: { state: "bekliyor" } });
    expect((await counts(t)).jobs).toBe(2);

    // Bir dosya önceden kopyalanmış (yarım kopya senaryosu).
    const rel = Object.keys(OWNER_FILES)[0]!;
    mkdirSync(path.dirname(path.join(orgDir(dir, t), ...rel.split("/"))), { recursive: true });
    writeFileSync(path.join(orgDir(dir, t), ...rel.split("/")), OWNER_FILES[rel]!);

    // Tam koşu reddedilir (veritabanı zaten aktarıldı).
    await expect(runTransfer(opts(t, dir))).rejects.toThrow(/--yalniz-dosyalar/);

    const dry = await runTransfer(opts(t, dir, { filesOnly: true, dryRun: true }));
    expect(dry.files).toMatchObject({ copied: Object.keys(OWNER_FILES).length - 1, existing: 1 });
    expect(await setting(t, TRANSFER_KEY)).toMatchObject({ files: { state: "bekliyor" } });

    const r = await runTransfer(opts(t, dir, { filesOnly: true }));
    expect(r.files).toMatchObject({ copied: Object.keys(OWNER_FILES).length - 1, existing: 1, verified: Object.keys(OWNER_FILES).length });
    expect(fileHashes(orgDir(dir, t))).toEqual(expectedFiles);
    expect(await setting(t, TRANSFER_KEY)).toMatchObject({ files: { state: "tamam" } });
    // Tekrar: kopyalanacak bir şey yok.
    expect((await runTransfer(opts(t, dir, { filesOnly: true }))).files).toMatchObject({ copied: 0, existing: Object.keys(OWNER_FILES).length });

    // Hedefte içerik değişmişse üzerine yazılmaz.
    writeFileSync(path.join(orgDir(dir, t), ...rel.split("/")), "değişti");
    await expect(runTransfer(opts(t, dir, { filesOnly: true }))).rejects.toThrow(/üzerine yazılmaz/);
    expect(readFileSync(path.join(orgDir(dir, t), ...rel.split("/")), "utf8")).toBe("değişti");

    // Veritabanı aktarımı olmayan firmada --yalniz-dosyalar reddedilir.
    await expect(runTransfer(opts(await company(), dataDir(), { filesOnly: true }))).rejects.toThrow(/veritabanı aktarımı yapılmamış/);
    expect(treeState(source)).toEqual(sourceBefore);
    await purge(t);
  });

  it("uygulama veritabanına bağlıyken (başta ya da aktarım sırasında bağlanırsa) reddedilir, hiçbir şey yazılmaz (R4)", async () => {
    // İncelemenin senaryosu: uygulama (aynı rol, READ COMMITTED) aktarım sırasında yazıyor.
    const t = await company();
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await app.query("SELECT set_config('app.org_id', $1, false)", [t]);
      await expect(runTransfer(opts(t, dataDir()))).rejects.toThrow(/uygulaması veritabanına bağlı/);
      await expect(runTransfer(opts(t, dataDir(), { dryRun: true }))).rejects.toThrow(/uygulaması veritabanına bağlı/);
      expect(await total(t)).toBe(0);
    } finally {
      await app.end();
      await appGone();
    }

    // Uygulama aktarım sırasında açılır ve yazmaya çalışır: yazısı kilitte bekler, aktarım commit'ten önce reddedilir.
    const late = new pg.Client({ connectionString: db.appUrl });
    let write: Promise<unknown> | null = null;
    try {
      const err = await runTransfer(
        opts(t, dataDir(), {
          hooks: {
            afterTable: async (table) => {
              if (table !== "languages") return;
              await late.connect();
              await late.query("SELECT set_config('app.org_id', $1, false)", [t]);
              write = late.query(`INSERT INTO tagpress.org_settings (org_id, key, value) VALUES ($1, 'app', '{"uygulama":"yazdi"}') ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`, [t]);
              write.catch(() => undefined);
            },
          },
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransferRefused);
      expect((err as Error).message).toMatch(/uygulaması veritabanına bağlı/);
      // Aktarım geri alındı; uygulamanın yazısı ancak ondan sonra (boş firmaya) girer, aktarılanın üstüne değil.
      await write;
      expect(await counts(t)).toMatchObject({ languages: 0, jobs: 0, org_settings: 1 });
      expect(await setting(t, TRANSFER_KEY)).toBeNull();
    } finally {
      await late.end();
      await appGone();
    }
    await purge(t);
  });

  it("aktarım süresince kiracı tablolarına başka yazı giremez (kilit); bekleyen yazı commit'ten sonra girer", async () => {
    const t = await company();
    // Uygulama rolü dışından (bağlantı denetimine takılmayan) bir yazan: kilit onu da durdurmalı.
    const other = new pg.Client({ connectionString: db.superUrl });
    await other.connect();
    let settled = false;
    let write: Promise<unknown> | null = null;
    let settledBeforeCommit: boolean | null = null;
    try {
      const report = await runTransfer(
        opts(t, dataDir(), {
          hooks: {
            afterTable: (table) => {
              if (table !== "languages") return;
              write = other.query(`INSERT INTO tagpress.languages (id, name, created_at, org_id) VALUES ($1, 'Eşzamanlı', 'x', $2)`, [`es-${t}`, t]).finally(() => {
                settled = true;
              });
              write.catch(() => undefined);
            },
            beforeCommit: async () => {
              await new Promise((r) => setTimeout(r, 300));
              settledBeforeCommit = settled;
            },
          },
        }),
      );
      expect(report.committed).toBe(true);
      expect(settledBeforeCommit).toBe(false); // yazı aktarım boyunca bekledi
      await write;
      // Aktarılan içerik doğrulanmış hâliyle yerinde; bekleyen yazı sonradan ayrı satır olarak girdi.
      expect((await su.query(`SELECT id FROM tagpress.languages WHERE org_id = $1 ORDER BY id`, [t])).rows.map((r) => r.id)).toEqual([LANG, `es-${t}`]);
    } finally {
      await other.end();
    }
    await purge(t);
  });

  it("tasarım oturumu numaraları başka firmanınkiyle çakışırsa nedenini ve yapılacağı söyleyerek reddedilir", async () => {
    // Platformda başka bir firma tasarım oturumu kullanmış: kaynaktaki 7 numaralı kayıt onda var (tek sayaç).
    const bystander = await company("Başka Firma");
    await su.query(`INSERT INTO tagpress.design_sessions (id, language_id, status, started_at, updated_at, org_id) VALUES ($1, 'l', 'open', 'x', 'x', $2)`, [`ds-${bystander}`, bystander]);
    await su.query(`INSERT INTO tagpress.design_session_entries (id, session_id, at, kind, text, org_id) VALUES (7, $1, 'x', 'note', 't', $2)`, [`ds-${bystander}`, bystander]);
    const before = await orgRows(bystander);
    const t = await company();
    try {
      const err = await runTransfer(opts(t, dataDir())).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransferRefused);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Tasarım oturumu kayıtlarının numaraları/);
      expect(msg).toMatch(/başka bir firma tasarım oturumu kullanmış/);
      expect(msg).toMatch(/Ne yapılmalı/);
      expect(msg).not.toMatch(/başka bir firmaya aktarılmış olabilir/);
      expect(await total(t)).toBe(0);
      expect(await orgRows(bystander)).toEqual(before);
    } finally {
      await purge(bystander);
    }
  });

  it("kaynakta bağlantı (junction) varsa veritabanına yazmadan durur", async () => {
    const t = await company();
    const linkSrc = path.join(work, `kaynak-baglanti-${randomUUID().slice(0, 8)}`);
    buildSource(linkSrc);
    const outside = path.join(work, `disari-${randomUUID().slice(0, 8)}`);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "gizli.txt"), "dışarıda");
    const link = path.join(linkSrc, "referanslar", LANG, "baglanti");
    makeDirLink(outside, link);
    try {
      await expect(runTransfer({ ...opts(t, dataDir()), source: linkSrc })).rejects.toThrow(/bağlantı/);
      expect(await total(t)).toBe(0);
      expect(readFileSync(path.join(outside, "gizli.txt"), "utf8")).toBe("dışarıda");
    } finally {
      removeDirLink(link); // yalnız bağlantı kaldırılır (hedefi değil; Linux'ta sembolik bağ, Windows'ta junction)
    }
  });
});

describe("ilk açılışın varsayılan içeriği", () => {
  let authority: TestAuthority;
  let dir: string;

  beforeAll(async () => {
    authority = await createTestAuthority();
    dir = dataDir();
  }, 120_000);

  /** Uygulamayı açar, işi yapar, kapatır (aktarım uygulama veritabanına bağlıyken reddedilir). */
  const withApp = async <T>(fn: (app: FastifyInstance) => Promise<T>): Promise<T> => {
    const { app } = await buildApp({
      config: {
        auth: "platform",
        dataDir: dir,
        port: 4200,
        dev: true,
        webDist: path.join(dir, "web-yok"),
        platform: { jwksUrl: authority.jwksUrl, allowedOrigins: ["http://localhost"], production: false, aiGateway: null },
      },
      databaseUrl: db.appUrl,
      platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
      clock: new ManualClock(),
      secretKeys: fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
      legacyDpapi: null,
      startQueue: false,
    });
    try {
      await app.ready();
      return await fn(app);
    } finally {
      await app.close();
      await appGone();
    }
  };

  const open = (orgId: string) =>
    withApp(async (app) => {
      const token = await authority.accessToken({ product: "tagpress", orgId, membershipId: randomUUID(), role: "ADMIN", epoch: 0, orgName: "Gerçek Firma" });
      const res = await app.inject({ method: "GET", url: "/api/tagpress/languages", headers: authority.bearer(token) });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { languages: { id: string }[] }).languages.map((l) => l.id);
    });
  /** TagPress'i Merkez'den ilk kez açmış firma (yalnız ürünle gelen varsayılan içerik). */
  const seededOrg = async () => {
    const orgId = randomUUID();
    const langs = await open(orgId);
    expect(langs).toHaveLength(1);
    return { orgId, seedLang: langs[0]! };
  };
  const seedDir = (orgId: string, lang: string) => path.join(orgDir(dir, orgId), "diller", lang);

  it("yalnız (değiştirilmemiş) varsayılan içerik varsa o silinir ve kaynak yazılır; uygulama aktarılan dili görür", async () => {
    const { orgId, seedLang } = await seededOrg();
    expect(existsSync(seedDir(orgId, seedLang))).toBe(true);
    expect(await setting(orgId, SEEDED_KEY)).toMatchObject({ languageId: seedLang });

    const report = await runTransfer(opts(orgId, dir));
    expect(report.state).toMatchObject({ kind: "seed", languageId: seedLang });
    expect(report.target.name).toBe("Gerçek Firma");
    expect(report.seedFolderRemoved).toBe(seedDir(orgId, seedLang));
    for (const t of report.tables) expect(t.target, t.table).toBe(expected[t.table]);
    expect((await su.query(`SELECT id FROM tagpress.languages WHERE org_id = $1`, [orgId])).rows.map((r) => r.id)).toEqual([LANG]);
    expect(existsSync(seedDir(orgId, seedLang))).toBe(false);
    expect(fileHashes(orgDir(dir, orgId))).toEqual(expectedFiles);
    expect(await setting(orgId, TRANSFER_KEY)).toMatchObject({ seed: { languageId: seedLang }, files: { state: "tamam" } });
    expect(await open(orgId)).toEqual([LANG]);
    expect(formatReport(report)).toContain("ilk açılış içeriği");
    await purge(orgId);
  });

  it("kullanıcının platformda yaptığı değişiklik (şablon, font, ayar, dil adı) varsa açık iletiyle reddedilir, hiçbir şey silinmez (R4)", async () => {
    const cases: { name: string; change: (orgId: string, lang: string) => Promise<void>; refused: RegExp }[] = [
      {
        name: "şablon düzenlendi",
        change: async (orgId) => {
          await su.query(
            `UPDATE tagpress.templates SET data = (data::jsonb || '{"note":"kullanıcı düzenledi"}'::jsonb)::text, updated_at = '2026-11-22T09:30:00.000Z' WHERE org_id = $1 AND key = (SELECT min(key) FROM tagpress.templates WHERE org_id = $1)`,
            [orgId],
          );
        },
        refused: /ilk açılış içeriği platformda değiştirilmiş \(şablon \S+ düzenlenmiş\)/,
      },
      {
        name: "şablon kaydı değişti (tarih aynı)",
        change: async (orgId) => {
          await su.query(`UPDATE tagpress.templates SET data = (data::jsonb || '{"note":"x"}'::jsonb)::text WHERE org_id = $1 AND key = (SELECT min(key) FROM tagpress.templates WHERE org_id = $1)`, [orgId]);
        },
        refused: /şablon \S+ düzenlenmiş/,
      },
      {
        name: "şablon dosyası eksik",
        change: async (orgId) => {
          await su.query(`UPDATE tagpress.templates SET file_missing = 1 WHERE org_id = $1 AND key = (SELECT min(key) FROM tagpress.templates WHERE org_id = $1)`, [orgId]);
        },
        refused: /şablon \S+ dosyası eksik/,
      },
      {
        name: "font yüklendi",
        change: async (orgId, lang) => {
          writeFileSync(path.join(seedDir(orgId, lang), "fontlar", "kullanicinin-yukledigi.ttf"), "font");
        },
        refused: /ürünle gelmeyen ya da değiştirilmiş dosya var \(1; ör\. fontlar\/kullanicinin-yukledigi\.ttf\)/,
      },
      {
        name: "ürünle gelen font değişti",
        change: async (orgId, lang) => {
          const fonts = path.join(seedDir(orgId, lang), "fontlar");
          const ttf = readdirSync(fonts).find((f) => /\.(ttf|otf)$/i.test(f))!;
          writeFileSync(path.join(fonts, ttf), "başka içerik");
        },
        refused: /ürünle gelmeyen ya da değiştirilmiş dosya var \(1; ör\. fontlar\//,
      },
      {
        name: "ai.limits ayarı kondu",
        change: async (orgId) => {
          await su.query(`INSERT INTO tagpress.org_settings (org_id, key, value) VALUES ($1, 'ai.limits', '{"sessionUsd":1}')`, [orgId]);
        },
        refused: /firma ayarı ai\.limits/,
      },
      {
        name: "dilin adı değişti",
        change: async (orgId) => {
          await su.query(`UPDATE tagpress.languages SET name = 'Benim dilim' WHERE org_id = $1`, [orgId]);
        },
        refused: /varsayılan dilin adı değiştirilmiş/,
      },
    ];
    for (const c of cases) {
      const { orgId, seedLang } = await seededOrg();
      await c.change(orgId, seedLang);
      const before = await orgRows(orgId);
      const files = treeState(orgDir(dir, orgId));
      const err = await runTransfer(opts(orgId, dir)).catch((e: unknown) => e);
      expect(err, c.name).toBeInstanceOf(TransferRefused);
      expect((err as Error).message, c.name).toMatch(c.refused);
      expect((err as Error).message, c.name).toMatch(/Hiçbir şey yazılmadı/);
      expect(await orgRows(orgId), c.name).toEqual(before);
      expect(treeState(orgDir(dir, orgId)), c.name).toEqual(files);
    }
    expect(treeState(source)).toEqual(sourceBefore);
  });

  it("varsayılan içeriğe ek bir iş yapılmışsa reddedilir (hiçbir şey silinmez)", async () => {
    const { orgId, seedLang } = await seededOrg();
    await su.query(`INSERT INTO tagpress.batches (id, language_id, name, created_at, org_id) VALUES ($1, $2, 'ilk iş', 'x', $3)`, [`b-${orgId}`, seedLang, orgId]);
    const before = await orgRows(orgId);
    const files = treeState(orgDir(dir, orgId));
    await expect(runTransfer(opts(orgId, dir))).rejects.toThrow(/TagPress verisi var/);
    expect(await orgRows(orgId)).toEqual(before);
    expect(treeState(orgDir(dir, orgId))).toEqual(files);

    // Varsayılan dile ikinci sürüm yazılmışsa da (kullanıcı düzenledi) varsayılan sayılmaz.
    const other = await seededOrg();
    await su.query(
      `INSERT INTO tagpress.profile_versions (id, language_id, version, status, data, created_at, org_id) SELECT $1, language_id, 2, 'draft', data, created_at, org_id FROM tagpress.profile_versions WHERE org_id = $2 AND language_id = $3`,
      [`pv-${other.orgId}`, other.orgId, other.seedLang],
    );
    await expect(runTransfer(opts(other.orgId, dir))).rejects.toThrow(/TagPress verisi var: ilk açılış içeriği platformda değiştirilmiş \(tasarım dili düzenlenmiş \(sürüm 2, draft\)\)/);
    expect((await su.query(`SELECT count(*)::int AS n FROM tagpress.languages WHERE org_id = $1`, [other.orgId])).rows[0].n).toBe(1);
  });

  it("dosya adımı varsayılan dil klasörü silinmeden düşerse --yalniz-dosyalar klasörü (yalnız ürünle gelen içerikse) siler", async () => {
    const { orgId, seedLang } = await seededOrg();
    const folder = seedDir(orgId, seedLang);
    const err = await runTransfer(opts(orgId, dir, { hooks: { beforeFiles: () => { throw new Error("disk doldu"); } } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilesIncomplete);
    expect(existsSync(folder)).toBe(true);
    expect(await setting(orgId, TRANSFER_KEY)).toMatchObject({ seed: { languageId: seedLang }, files: { state: "bekliyor" } });

    // Klasöre ürünle gelmeyen dosya düştüyse silinmez, dosyalar kopyalanmaz.
    const extra = path.join(folder, "fontlar", "sonradan.ttf");
    writeFileSync(extra, "kullanıcının");
    await expect(runTransfer(opts(orgId, dir, { filesOnly: true }))).rejects.toThrow(/ürünle gelmeyen ya da değiştirilmiş dosya var.*Dosyalar kopyalanmadı/);
    expect(readFileSync(extra, "utf8")).toBe("kullanıcının");
    expect(existsSync(path.join(orgDir(dir, orgId), "onizleme"))).toBe(false);
    rmSync(extra);

    // Kuru çalışma silmez.
    const dry = await runTransfer(opts(orgId, dir, { filesOnly: true, dryRun: true }));
    expect(dry.seedFolderRemoved).toBeNull();
    expect(existsSync(folder)).toBe(true);

    const r = await runTransfer(opts(orgId, dir, { filesOnly: true }));
    expect(r.seedFolderRemoved).toBe(folder);
    expect(existsSync(folder)).toBe(false);
    expect(fileHashes(orgDir(dir, orgId))).toEqual(expectedFiles);
    expect(await setting(orgId, TRANSFER_KEY)).toMatchObject({ files: { state: "tamam" } });
    expect(formatReport(r)).toContain("Önceki koşudan kalan ilk açılış dili klasörü silindi");
    // Tekrar: silinecek klasör de kopyalanacak dosya da yok.
    expect(await runTransfer(opts(orgId, dir, { filesOnly: true }))).toMatchObject({ seedFolderRemoved: null, files: { copied: 0 } });
    expect(await open(orgId)).toEqual([LANG]);
    await purge(orgId);
  });
});
