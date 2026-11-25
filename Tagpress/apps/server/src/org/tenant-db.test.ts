import { describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../db/database.ts";
import { OrgContextError, maintenance, runInOrg } from "./context.ts";
import { scanSql, scopeProblems } from "./sql-scan.ts";
import { MaintenanceScopeError, TenantDb, UnscopedSqlError } from "./tenant-db.ts";
import { Tenancy, type TenancyMode } from "./tenancy.ts";

const at = "2026-11-21T00:00:00.000Z";

/** Göçlenmiş bellek veritabanı, iki firma (A varsayılan) ve her birinde bir dil. */
function setup(mode: TenancyMode = "strict") {
  const raw: Db = openDatabase(":memory:");
  raw.exec(`
    INSERT INTO orgs (id, name, source, created_at) VALUES ('org-a', 'A', 'local', '${at}'), ('org-b', 'B', 'local', '${at}');
    INSERT INTO settings (key, value) VALUES ('install.defaultOrgId', '"org-a"');
    INSERT INTO languages (id, name, created_at, org_id) VALUES ('dil-a', 'Dil A', '${at}', 'org-a'), ('dil-b', 'Dil B', '${at}', 'org-b');
  `);
  const tenancy = new Tenancy({ mode });
  return { raw, tenancy, tdb: new TenantDb(raw, tenancy) };
}

const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name);

describe("TenantDb: kapsamsız SQL reddi", () => {
  const { tdb } = setup();
  const rejected: [string, RegExp][] = [
    ["SELECT * FROM languages", /languages için firma kapsamı yok/],
    ["SELECT * FROM languages WHERE id = ?", /languages için firma kapsamı yok/],
    ["SELECT * FROM jobs j JOIN batches b ON b.id = j.batch_id WHERE j.org_id = $org", /batches \(b\) için firma kapsamı yok: "b\.org_id = \$org"/],
    ["SELECT * FROM jobs j JOIN batches b ON b.id = j.batch_id WHERE j.org_id = $org AND j.org_id = $org", /batches \(b\) için/],
    ["SELECT * FROM jobs, batches WHERE jobs.org_id = $org", /batches için firma kapsamı yok: "batches\.org_id = \$org"/],
    ["SELECT * FROM jobs j, batches b WHERE org_id = $org", /takma adla yazın/],
    ["SELECT * FROM variants WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $org)", /variants için firma kapsamı yok/],
    ["DELETE FROM undo", /undo için firma kapsamı yok/],
    ["UPDATE jobs SET status = ? WHERE id = ?", /jobs için firma kapsamı yok/],
    ["UPDATE languages SET org_id = ?, name = ? WHERE org_id = $org", /org_id değiştirilemez/],
    ["INSERT INTO languages (id, name, created_at) VALUES (?, ?, ?)", /sütun listesinde org_id yok/],
    ["INSERT INTO languages VALUES ($org, ?, ?)", /sütun listesinde org_id yok/],
    ["INSERT INTO languages (org_id, id, name, created_at) VALUES (?, ?, ?, ?)", /org_id değeri tam olarak \$org olmalı/],
    ['SELECT * FROM "languages" WHERE "id" = ?', /languages için firma kapsamı yok/],
    ["SELECT * FROM [jobs] -- WHERE org_id = $org", /jobs için firma kapsamı yok/],
    ["SELECT * FROM jobs WHERE note = 'org_id = $org'", /jobs için firma kapsamı yok/],
    ["SELECT value FROM settings WHERE key = ?", /kurulum tablosu/],
    ["SELECT * FROM orgs WHERE id = $org", /kurulum tablosu/],
    ["SELECT * FROM builds WHERE org_id = $org", /tanınmayan tablo: builds/],
    ["SELECT * FROM languages WHERE org_id = $org; DELETE FROM jobs", /tek ifade/],
    // varsa güncelle / yerine yaz: başka firmanın satırına dokunur
    ["INSERT INTO refs (org_id, id, language_id, data, split, created_at) VALUES ($org, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", /ON CONFLICT … DO UPDATE/],
    ["INSERT INTO refs (org_id, id, language_id, data, split, created_at) VALUES ($org, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE refs.org_id = $org OR 1", /OR/],
    ["INSERT OR REPLACE INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)", /REPLACE/],
    ["REPLACE INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)", /REPLACE/],
    ["UPDATE OR REPLACE jobs SET seq = ? WHERE id = ? AND org_id = $org", /REPLACE/],
    // mantık: OR, NOT, yalnız SELECT listesinde, şema öneki
    ["SELECT * FROM languages WHERE org_id = $org AND id = ? OR name = ?", /en dışta OR/],
    ["SELECT * FROM languages WHERE org_id = $org OR 1=1", /en dışta OR/],
    ["SELECT * FROM languages WHERE (org_id = $org AND id = ?) OR 1", /en dışta OR/],
    ["SELECT * FROM languages WHERE (org_id = $org)", /en dışında, AND ile/],
    ["SELECT * FROM languages WHERE NOT org_id = $org", /önünde NOT/],
    ["SELECT * FROM languages WHERE org_id IS NOT $org", /languages için firma kapsamı yok/],
    ["SELECT *, org_id = $org AS mine FROM languages", /yalnız WHERE ya da JOIN … ON içinde sayılır/],
    // İkinci inceleme (p1): tek tırnaklı tablo adı, dış birleşimde korunan taraf, HAVING.
    ["SELECT * FROM 'languages'", /anlaşılamadı/],
    ["SELECT * FROM 'templates' WHERE 1", /anlaşılamadı/],
    ["SELECT id FROM languages WHERE org_id = $org AND EXISTS (SELECT 1 FROM 'templates' x WHERE x.data LIKE '%G%')", /anlaşılamadı/],
    ["UPDATE 'jobs' SET status = ? WHERE org_id = $org", /anlaşılamadı/],
    ["SELECT l.id, l.name FROM languages l LEFT JOIN templates t ON l.org_id = $org AND t.language_id = l.id AND t.org_id = $org", /languages \(l\): dış birleşimde korunan tablonun kapsamı ON içinde sayılmaz/],
    ["SELECT l.id FROM languages l LEFT OUTER JOIN templates t ON t.language_id = l.id AND t.org_id = $org AND l.org_id = $org WHERE t.key IS NULL", /languages \(l\): dış birleşimde korunan/],
    ["SELECT l.id, l.name FROM templates t RIGHT JOIN languages l ON t.language_id = l.id AND t.org_id = $org AND l.org_id = $org", /languages \(l\): dış birleşimde korunan/],
    ["SELECT l.id FROM templates t FULL JOIN languages l ON t.language_id = l.id AND t.org_id = $org AND l.org_id = $org", /templates \(t\): dış birleşimde korunan/],
    ["SELECT key, COUNT(*) AS n, group_concat(language_id) AS langs FROM templates GROUP BY key HAVING org_id = $org", /HAVING/],
    ["UPDATE languages SET name = ? WHERE org_id = $org OR id = ?", /en dışta OR/],
    ["DELETE FROM undo WHERE token = ? OR org_id = $org", /en dışta OR/],
    ["SELECT * FROM main.jobs WHERE org_id = $org", /şema öneki/],
    ["INSERT INTO job_log (org_id, job_id, step, message, at) SELECT $org, id, 'x', 'y', ? FROM jobs", /jobs için firma kapsamı yok/],
    ["INSERT INTO job_log (org_id, job_id, step, message, at) SELECT ?, id, 'x', 'y', ? FROM jobs WHERE org_id = $org", /org_id değeri tam olarak \$org/],
  ];
  it.each(rejected)("%s", (sql, why) => {
    expect(() => tdb.prepare(sql)).toThrow(UnscopedSqlError);
    expect(() => tdb.prepare(sql)).toThrow(why);
  });

  const accepted = [
    "SELECT l.id FROM languages l LEFT JOIN templates t ON t.language_id = l.id AND t.org_id = $org WHERE l.org_id = $org",
    "SELECT l.id FROM templates t RIGHT JOIN languages l ON t.language_id = l.id AND t.org_id = $org WHERE l.org_id = $org",
    "SELECT l.id FROM languages l JOIN templates t ON t.language_id = l.id AND t.org_id = $org AND l.org_id = $org",
    "SELECT key, COUNT(*) AS n FROM templates WHERE org_id = $org GROUP BY key HAVING COUNT(*) > 1",
    "SELECT * FROM languages WHERE org_id = $org",
    "SELECT * FROM languages WHERE id = ? AND org_id = $org",
    "SELECT * FROM languages WHERE org_id = $org AND (id = ? OR name = ?)",
    "SELECT * FROM languages WHERE (id = ? OR name = ?) AND org_id = $org ORDER BY created_at LIMIT 1",
    "SELECT * FROM languages WHERE org_id IS $org",
    "SELECT * FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org WHERE j.org_id = $org",
    "SELECT j.id FROM jobs AS j LEFT JOIN variants v ON v.job_id = j.id AND v.org_id = $org WHERE j.org_id = $org",
    "SELECT * FROM jobs, batches WHERE jobs.org_id = $org AND batches.org_id = $org AND batches.id = jobs.batch_id",
    "SELECT * FROM variants WHERE org_id = $org AND job_id IN (SELECT id FROM jobs WHERE jobs.org_id = $org)",
    "SELECT * FROM jobs j WHERE j.org_id = $org AND EXISTS (SELECT 1 FROM variants v WHERE v.job_id = j.id AND v.org_id = $org)",
    "INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)",
    "INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?), ($org, ?, ?, ?)",
    "INSERT OR IGNORE INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)",
    "INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    "INSERT INTO org_settings (org_id, key, value) VALUES ($org, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value",
    "INSERT INTO refs (org_id, id, language_id, data, split, created_at) VALUES ($org, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE refs.org_id = $org",
    "INSERT INTO refs (org_id, id, language_id, data, split, created_at) VALUES ($org, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE excluded.org_id = refs.org_id",
    "INSERT INTO job_log (org_id, job_id, step, message, at) SELECT $org, id, 'x', 'y', ? FROM jobs WHERE org_id = $org AND batch_id = ?",
    "UPDATE jobs SET status = ?, issues = (SELECT json_group_array(value) FROM json_each(jobs.issues)) WHERE id = ? AND org_id = $org",
    "UPDATE jobs SET status = ? WHERE id IN (SELECT job_id FROM variants WHERE org_id = $org AND id = ?) AND org_id = $org",
    "DELETE FROM undo WHERE token = ? AND org_id = $org",
    "WITH son AS (SELECT id FROM jobs WHERE org_id = $org ORDER BY created_at DESC LIMIT 5) SELECT id FROM son",
    "SELECT purpose, COUNT(*) AS n FROM ai_calls WHERE created_at >= ? AND $org = org_id GROUP BY purpose HAVING COUNT(*) > 0",
    "SELECT id FROM jobs WHERE org_id = $org UNION SELECT job_id FROM variants WHERE org_id = $org",
    "SELECT 1 AS bir",
  ];
  it.each(accepted)("geçer: %s", (sql) => {
    expect(scopeProblems(scanSql(sql))).toEqual([]);
    expect(() => tdb.prepare(sql)).not.toThrow();
  });
});

describe("TenantDb: $org bağlama", () => {
  it("adlı `org` parametresi geçerli firmayla doldurulur; `?` parametreleri aynen kalır; firmalar birbirini görmez", () => {
    const { tdb } = setup();
    const byId = tdb.prepare("SELECT name FROM languages WHERE id = ? AND org_id = $org");
    const list = tdb.prepare("SELECT name FROM languages WHERE org_id = $org ORDER BY id");
    runInOrg("org-a", () => {
      expect(byId.get("dil-a")?.name).toBe("Dil A");
      expect(byId.get("dil-b")).toBeUndefined(); // başka firmanın kimliği: yok
      expect(names(list.all())).toEqual(["Dil A"]);
    });
    runInOrg("org-b", () => {
      expect(names(list.all())).toEqual(["Dil B"]);
      tdb.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)").run("dil-b2", "Dil B2", at);
      expect(names(list.all())).toEqual(["Dil B", "Dil B2"]);
      // Adlı parametreyle de: `org` eklenir, elle verilemez.
      expect(tdb.prepare("SELECT name FROM languages WHERE id = $id AND org_id = $org").get({ id: "dil-b2" })?.name).toBe("Dil B2");
      expect(() => tdb.prepare("SELECT name FROM languages WHERE org_id = $org").get({ org: "org-a" })).toThrow(/elle verilmez/);
    });
    runInOrg("org-a", () => expect(names(list.all())).toEqual(["Dil A"]));
  });

  it("deyim firmayı ÇALIŞTIRMA anında okur (bir kez hazırlanıp firmalar arasında kullanılabilir); söz zinciri bağlamı taşır", async () => {
    const { tdb } = setup();
    const list = tdb.prepare("SELECT name FROM languages WHERE org_id = $org");
    const seen = await Promise.all(
      (["org-a", "org-b"] as const).map((o) =>
        runInOrg(o, async () => {
          await new Promise((r) => setTimeout(r, 5));
          await Promise.resolve();
          return names(list.all());
        }),
      ),
    );
    expect(seen).toEqual([["Dil A"], ["Dil B"]]);
  });

  it("bağlamsız: İKİ kipte de hata (varsayılan firmaya düşülmez); bakım kapsamında firma okunmaz", () => {
    for (const mode of ["strict", "audit"] as const) {
      const { tdb, tenancy } = setup(mode);
      const stmt = tdb.prepare("SELECT name FROM languages WHERE org_id = $org");
      expect(() => stmt.all(), mode).toThrow(OrgContextError);
      expect(() => maintenance(() => stmt.all()), mode).toThrow(/bakım kapsamı/);
      expect(() => maintenance(() => tenancy.orgId("deneme")), mode).toThrow(OrgContextError);
      expect(runInOrg("org-b", () => names(stmt.all())), mode).toEqual(["Dil B"]);
      expect(tenancy.audit.total, mode).toBe(0);
    }
  });

  it("işlem: TenantDb ve bakım bağlantısı aynı işlemi paylaşır; hata bütün işlemi geri alır", () => {
    const { tdb, raw } = setup();
    const ins = tdb.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)");
    expect(() =>
      runInOrg("org-a", () =>
        tdb.tx(() => {
          ins.run("t1", "T1", at);
          maintenance(() => tdb.maintenance.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ('org-b', 't2', 'T2', ?)").run(at));
          throw new Error("dur");
        }),
      ),
    ).toThrow("dur");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM languages").get()?.n).toBe(2);
  });
});

describe("TenantDb: kurulum ve bakım erişimi", () => {
  it("install yalnız kurulum tablolarına; kiracı tablosu ve bilinmeyen tablo reddedilir", () => {
    const { tdb } = setup();
    expect(tdb.install.prepare("SELECT value FROM settings WHERE key = ?").get("install.defaultOrgId")?.value).toBe('"org-a"');
    expect(tdb.install.prepare("SELECT name FROM orgs ORDER BY id").all().map((r) => r.name)).toEqual(["A", "B"]);
    expect(() => tdb.install.prepare("SELECT * FROM languages")).toThrow(/kiracı tablosu/);
    expect(() => tdb.install.prepare("SELECT * FROM orgs o JOIN org_settings s ON s.org_id = o.id")).toThrow(/kiracı tablosu/);
    expect(() => tdb.install.prepare("SELECT * FROM builds")).toThrow(/tanınmayan tablo/);
  });

  it("sıkı kip: bakım bağlantısı yalnız maintenance(…) içinde (firma bağlamında da hata); orada kapsamsız erişim serbest", () => {
    const { tdb, tenancy } = setup("strict");
    expect(() => tdb.maintenance.prepare("SELECT COUNT(*) AS n FROM languages")).toThrow(MaintenanceScopeError);
    expect(() => tdb.maintenance.exec("DELETE FROM undo")).toThrow(/yalnız maintenance/);
    expect(() => tdb.maintenance.tx(() => 1)).toThrow(/yalnız maintenance/);
    expect(() => runInOrg("org-a", () => tdb.maintenance.prepare("SELECT 1"))).toThrow(/yalnız maintenance/);
    expect(maintenance(() => tdb.maintenance.prepare("SELECT COUNT(*) AS n FROM languages").get()?.n)).toBe(2);
    // Bakımda hazırlanıp dışarı taşınan deyim dışarıda çalışmaz (her çalıştırmada denetlenir).
    const st = maintenance(() => tdb.maintenance.prepare("SELECT id, name, org_id FROM languages"));
    expect(() => runInOrg("org-b", () => st.all())).toThrow(MaintenanceScopeError);
    expect(() => st.get()).toThrow(MaintenanceScopeError);
    expect(maintenance(() => st.all()).length).toBe(2);
    expect(tenancy.audit.total).toBe(0);
  });

  it("denetim kipi: bakım kapsamı dışındaki kullanım çalışır ve sayılır; bakım kapsamındaki sayılmaz", () => {
    const { tdb, tenancy } = setup("audit");
    expect(tdb.maintenance.prepare("SELECT COUNT(*) AS n FROM languages").get()?.n).toBe(2);
    runInOrg("org-b", () => tdb.maintenance.prepare("SELECT COUNT(*) AS n FROM languages").get());
    tdb.maintenance.exec("DELETE FROM undo");
    maintenance(() => tdb.maintenance.prepare("SELECT * FROM jobs").all());
    expect(tenancy.audit.list("raw-sql")).toEqual([
      { kind: "raw-sql", site: "SELECT COUNT(*) AS n FROM languages", count: 2 },
      { kind: "raw-sql", site: "DELETE FROM undo", count: 1 },
    ]);
    // Bakım kapsamında hazırlanan deyim dışarıda çalıştırılırsa da sayılır (her çalıştırmada denetim).
    const st = maintenance(() => tdb.maintenance.prepare("SELECT id FROM languages"));
    tenancy.audit.reset();
    runInOrg("org-b", () => st.all());
    expect(tenancy.audit.list("raw-sql")).toEqual([{ kind: "raw-sql", site: "SELECT id FROM languages", count: 1 }]);
    // Kapsamsız SQL TenantDb'de denetim kipinde de reddedilir.
    expect(() => tdb.prepare("SELECT * FROM languages")).toThrow(/firma kapsamı yok/);
  });
});

describe("şema öneki", () => {
  it("şema önekli ad (main.jobs) da kiracı tablosu sayılır ve reddedilir", () => {
    const { tdb } = setup();
    expect(() => tdb.prepare("SELECT * FROM main.languages WHERE org_id = $org")).toThrow(/şema öneki/);
    expect(() => tdb.install.prepare("SELECT COUNT(*) AS n FROM main.languages")).toThrow(/kiracı tablosu/);
  });
});
