import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localOrg, maintenance, runInOrg } from "../../org/context.ts";
import { Tenancy } from "../../org/tenancy.ts";
import { MaintenanceScopeError, UnscopedSqlError, dialectSql } from "../../org/tenant-db.ts";
import { type TestPgDb, createTestDb } from "../../test/pg.ts";
import { uuidv7 } from "../../util/ids.ts";
import { BridgeError, PgQueryError, SyncPgBridge } from "./bridge.ts";
import { DialectError } from "./dialect.ts";
import { PgTenantDb } from "./pg-tenant-db.ts";

/**
 * Senkron köprü ve `PgTenantDb` (plan §2.2, S5): hata yayılımı, işlem ve geri alma, iç içe işlem, ifade düzeyi
 * atomiklik, bağlam (firma) sızıntısı, kilit ve ifade zaman aşımı, köprü zaman aşımı, bağlantı kopması, kapanış.
 * Uygulama rolüyle (`sod_tagpress`, RLS altında); testin gözü süper kullanıcı bağlantısı.
 */

let db: TestPgDb;
let su: pg.Client;
const bridges: SyncPgBridge[] = [];
const A = uuidv7();
const B = uuidv7();
const none = { org: "", scope: "" };

const open = (o: Partial<ConstructorParameters<typeof SyncPgBridge>[0]> = {}) => {
  const b = new SyncPgBridge({ connectionString: db.appUrl, ...o });
  bridges.push(b);
  return b;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = async (sql: string, params: unknown[] = []) => Number((await su.query(sql, params)).rows[0].n);

beforeAll(async () => {
  db = await createTestDb();
  su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  await su.query("SET search_path = tagpress");
  // İki firma (test eki `orgs` → `Company`) ve köprü testlerinin kendi tablosu (RLS'li, uygulama rolüne açık).
  await su.query("INSERT INTO orgs (id, name, source, created_at) VALUES ($1, 'A', 'local', 'x'), ($2, 'B', 'local', 'x')", [A, B]);
  await su.query(`CREATE TABLE tagpress.bridge_t (id int PRIMARY KEY, org_id text NOT NULL DEFAULT current_setting('app.org_id', true), v text, n int8, f numeric, b bytea)`);
  await su.query("ALTER TABLE tagpress.bridge_t ENABLE ROW LEVEL SECURITY; ALTER TABLE tagpress.bridge_t FORCE ROW LEVEL SECURITY");
  await su.query("CREATE POLICY org_isolation ON tagpress.bridge_t USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true))");
  await su.query("GRANT SELECT, INSERT, UPDATE, DELETE ON tagpress.bridge_t TO sod_tagpress");
});

afterAll(async () => {
  for (const b of bridges) await b.close();
  await su?.end();
  await db?.drop();
});

describe("köprü: sorgu ve türler", () => {
  it("türler node:sqlite gibi: int8/numeric number, bool 0/1, json metin, bytea Uint8Array; karışık harfli ad korunur", () => {
    const b = open();
    const r = b.query(
      `SELECT 9007199254740991::int8 AS big, 9223372036854775807::int8 AS huge, 1.25::numeric AS num, true AS t, false AS f, '{"a": 1}'::jsonb AS j, '\\x0102'::bytea AS bin, $1::text AS p`,
      ["x"],
      none,
    );
    const row = r.rows[0]!;
    expect(row).toMatchObject({ big: 9007199254740991, num: 1.25, t: 1, f: 0, j: '{"a": 1}', p: "x" });
    // Güvenli aralık dışı tam sayı kaybolmaz.
    expect(row.huge).toBe(9223372036854775807n);
    expect(row.bin).toBeInstanceOf(Uint8Array);
    expect([...(row.bin as Uint8Array)]).toEqual([1, 2]);
  });

  it("oturum ayarları: lock_timeout 5s, statement_timeout 30s, idle_in_transaction 60s", () => {
    const b = open();
    const r = b.query(
      "SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i",
      [],
      none,
    ).rows[0];
    expect(r).toEqual({ l: "5s", s: "30s", i: "1min" });
  });

  it("Postgres hatası SQLSTATE ile yayılır; köprü sonra da çalışır", () => {
    const b = open();
    let err: unknown;
    try {
      b.query("SELEC 1", [], none);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PgQueryError);
    expect((err as PgQueryError).code).toBe("42601");
    expect(() => b.query("SELECT 1/0", [], none)).toThrow(expect.objectContaining({ code: "22012" }));
    expect(b.query("SELECT 2 AS n", [], none).rows).toEqual([{ n: 2 }]);
  });

  it("benzersizlik ihlali yakalanabilir: SQLSTATE 23505 + SQLite uyumlu errcode (birincil anahtar 1555)", () => {
    const b = open();
    const ctx = { org: A, scope: "" };
    b.query("INSERT INTO bridge_t (id, v) VALUES (100, 'a')", [], ctx);
    let err: PgQueryError | undefined;
    try {
      b.query("INSERT INTO bridge_t (id, v) VALUES (100, 'b')", [], ctx);
    } catch (e) {
      err = e as PgQueryError;
    }
    expect(err?.code).toBe("23505");
    expect(err?.errcode).toBe(1555);
    expect(err?.constraint).toBe("bridge_t_pkey");
  });
});

describe("köprü: işlem", () => {
  it("commit kalıcı, hata atan işlev geri alınır", async () => {
    const b = open();
    const ctx = { org: A, scope: "" };
    b.transaction(() => b.query("INSERT INTO bridge_t (id, v) VALUES (1, 'kalır')", [], ctx));
    expect(() =>
      b.transaction(() => {
        b.query("INSERT INTO bridge_t (id, v) VALUES (2, 'gider')", [], ctx);
        throw new Error("vazgeç");
      }),
    ).toThrow("vazgeç");
    expect(b.inTransaction).toBe(false);
    expect(await count("SELECT count(*) AS n FROM bridge_t WHERE id IN (1, 2)")).toBe(1);
  });

  it("iç içe işlem tek işlemdir (aynı işlem kimliği); içteki hata yakalanırsa dıştaki sürer", async () => {
    const b = open();
    const tdb = new PgTenantDb(b, new Tenancy({ mode: "strict" }));
    const ctx = { org: A, scope: "" };
    const ids: unknown[] = [];
    tdb.tx(() => {
      ids.push(b.query("SELECT txid_current() AS x", [], ctx).rows[0]!.x);
      b.query("INSERT INTO bridge_t (id, v) VALUES (10, 'dış')", [], ctx);
      try {
        tdb.tx(() => {
          ids.push(b.query("SELECT txid_current() AS x", [], ctx).rows[0]!.x);
          b.query("INSERT INTO bridge_t (id, v) VALUES (11, 'iç')", [], ctx);
          throw new Error("iç hata");
        });
      } catch {
        // SQLite'taki gibi: içteki işlev dıştakine katıldı, yazdığı satır işlemde kalır.
      }
      expect(b.inTransaction).toBe(true);
    });
    expect(ids[0]).toBe(ids[1]);
    expect(await count("SELECT count(*) AS n FROM bridge_t WHERE id IN (10, 11)")).toBe(2);
  });

  it("işlem içinde hata veren ifade yalnız kendini geri alır (SQLite gibi); işlem sürer ve kalıcı olur", async () => {
    const b = open();
    const ctx = { org: A, scope: "" };
    b.transaction(() => {
      b.query("INSERT INTO bridge_t (id, v) VALUES (20, 'a')", [], ctx);
      expect(() => b.query("INSERT INTO bridge_t (id, v) VALUES (20, 'yinelenen')", [], ctx)).toThrow(PgQueryError);
      b.query("INSERT INTO bridge_t (id, v) VALUES (21, 'b')", [], ctx);
    });
    expect((await su.query("SELECT id, v FROM bridge_t WHERE id IN (20, 21) ORDER BY id")).rows).toEqual([
      { id: 20, v: "a" },
      { id: 21, v: "b" },
    ]);
  });

  it("iç içe BEGIN köprüde hata (dıştakine katılma PgTenantDb.tx / transaction ile)", () => {
    const b = open();
    b.begin();
    expect(() => b.begin()).toThrow(expect.objectContaining({ code: "TP_TX_NESTED" }));
    b.rollback();
    expect(b.inTransaction).toBe(false);
  });
});

describe("köprü: firma bağlamı (RLS)", () => {
  it("A bağlamındaki ifadeden sonra B yalnız kendini görür; bağlamsız ifade hiçbir satır görmez", () => {
    const b = open();
    b.query("INSERT INTO bridge_t (id, v) VALUES (30, 'A satırı')", [], { org: A, scope: "" });
    b.query("INSERT INTO bridge_t (id, v) VALUES (31, 'B satırı')", [], { org: B, scope: "" });
    expect(b.query("SELECT id FROM bridge_t WHERE id IN (30, 31)", [], { org: A, scope: "" }).rows).toEqual([{ id: 30 }]);
    expect(b.query("SELECT id FROM bridge_t WHERE id IN (30, 31)", [], { org: B, scope: "" }).rows).toEqual([{ id: 31 }]);
    expect(b.query("SELECT id FROM bridge_t WHERE id IN (30, 31)", [], none).rows).toEqual([]);
    // B bağlamında A'nın satırı yazılamaz (WITH CHECK).
    expect(() => b.query("INSERT INTO bridge_t (id, org_id, v) VALUES (32, $1, 'sızma')", [A], { org: B, scope: "" })).toThrow(expect.objectContaining({ code: "42501" }));
  });

  it("işlem içinde bağlam değişimi işlem düzeyinde; işlem bitince oturum değeri geri gelir", () => {
    const b = open();
    const org = () => b.query("SELECT current_setting('app.org_id', true) AS o", [], { org: B, scope: "" }).rows[0]!.o;
    b.query("SELECT 1", [], { org: B, scope: "" });
    b.transaction(() => {
      expect(b.query("SELECT current_setting('app.org_id', true) AS o", [], { org: A, scope: "" }).rows[0]!.o).toBe(A);
      expect(b.query("SELECT id FROM bridge_t WHERE id = 31", [], { org: A, scope: "" }).rows).toEqual([]);
    });
    expect(org()).toBe(B);
    // Geri alınan işlemde de.
    expect(() =>
      b.transaction(() => {
        b.query("SELECT 1", [], { org: A, scope: "" });
        throw new Error("geri");
      }),
    ).toThrow("geri");
    expect(b.query("SELECT current_setting('app.org_id', true) AS o", [], none).rows[0]!.o).toBe("");
  });

  it("PgTenantDb: firma bağlamı her ifadede yazılır; $org ve $member arayüzden bağlanır", () => {
    const b = open();
    const tdb = new PgTenantDb(b, new Tenancy({ mode: "strict" }));
    runInOrg(A, () => tdb.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, 'Dil A', 'x')").run(`la-${A}`));
    runInOrg(B, () => tdb.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, 'Dil B', 'x')").run(`lb-${B}`));
    const names = (org: string) => runInOrg(org, () => tdb.prepare("SELECT name FROM languages WHERE org_id = $org ORDER BY name").all().map((r) => r.name));
    expect(names(A)).toEqual(["Dil A"]);
    expect(names(B)).toEqual(["Dil B"]);
    // `$org` olmayan bir koşulla bile (kapsam taraması reddeder) değil: RLS ayrıca sınırlar.
    const member = runInOrg({ ...localOrg(A), memberId: "uye-1", source: "platform" }, () => tdb.prepare("SELECT $member AS m, $org AS o").get());
    expect(member).toEqual({ m: "uye-1", o: A });
    expect(runInOrg(A, () => tdb.prepare("SELECT $member AS m").get())).toEqual({ m: null });
    // Bağlamsız ve kapsamsız çağrılar her kipte hata.
    expect(() => tdb.prepare("SELECT name FROM languages WHERE org_id = $org").all()).toThrow(/Firma bağlamı yok/);
    expect(() => tdb.prepare("SELECT name FROM languages")).toThrow(UnscopedSqlError);
    expect(() => tdb.prepare("SELECT json_extract(name, '$.a') AS x FROM languages WHERE org_id = $org")).toThrow(DialectError);
    expect(dialectSql(tdb, { sqlite: "s", pg: "p" })).toBe("p");
  });

  it("bakım bağlantısı yalnız maintenance(…) içinde; bağlamı firma yok + kapsam queue", () => {
    const b = open();
    const tdb = new PgTenantDb(b, new Tenancy({ mode: "strict" }));
    expect(() => tdb.maintenance.prepare("SELECT 1")).toThrow(MaintenanceScopeError);
    const r = maintenance(() => tdb.maintenance.prepare("SELECT current_setting('app.org_id', true) AS o, current_setting('app.scope', true) AS s").get());
    expect(r).toEqual({ o: "", s: "queue" });
    // Bakımda hazırlanıp dışarı taşınan ifade dışarıda çalışmaz.
    const stmt = maintenance(() => tdb.maintenance.prepare("SELECT 1 AS n"));
    expect(() => stmt.get()).toThrow(MaintenanceScopeError);
    // Firma bağlamına dönünce kapsam temizlenir.
    expect(runInOrg(A, () => tdb.prepare("SELECT current_setting('app.scope', true) AS s, $org AS o").get())).toEqual({ s: "", o: A });
  });

  it("kimlik sütunlu tabloya eklemede lastInsertRowid (RETURNING id)", () => {
    const b = open();
    const tdb = new PgTenantDb(b, new Tenancy({ mode: "strict" }));
    const ins = () => runInOrg(A, () => tdb.prepare("INSERT INTO job_log (org_id, job_id, step, message, at) VALUES ($org, 'j1', 'adim', 'ileti', 'x')").run());
    const r1 = ins();
    const r2 = ins();
    expect(r1.changes).toBe(1);
    expect(typeof r1.lastInsertRowid).toBe("number");
    expect(Number(r2.lastInsertRowid)).toBeGreaterThan(Number(r1.lastInsertRowid));
  });
});

describe("köprü: zaman aşımları, kopma, kapanış", () => {
  it("kilit zaman aşımı süreci dondurmaz: başka bağlantının tuttuğu satır beklenirken hata (55P03), köprü sürer", async () => {
    const b = open({ lockTimeoutMs: 300 });
    b.query("INSERT INTO bridge_t (id, v) VALUES (40, 'kilitli')", [], { org: A, scope: "" });
    const holder = new pg.Client({ connectionString: db.superUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM tagpress.bridge_t WHERE id = 40 FOR UPDATE");
      const t0 = Date.now();
      expect(() => b.query("UPDATE bridge_t SET v = 'yeni' WHERE id = 40", [], { org: A, scope: "" })).toThrow(expect.objectContaining({ code: "55P03" }));
      expect(Date.now() - t0).toBeLessThan(5000);
      // İşlem içinde de: ifade geri alınır, işlem sürer.
      b.transaction(() => {
        expect(() => b.query("UPDATE bridge_t SET v = 'yeni' WHERE id = 40", [], { org: A, scope: "" })).toThrow(expect.objectContaining({ code: "55P03" }));
        b.query("INSERT INTO bridge_t (id, v) VALUES (41, 'sonra')", [], { org: A, scope: "" });
      });
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await count("SELECT count(*) AS n FROM bridge_t WHERE id = 41")).toBe(1);
  });

  it("ifade zaman aşımı (57014)", () => {
    const b = open({ statementTimeoutMs: 200 });
    expect(() => b.query("SELECT pg_sleep(3)", [], none)).toThrow(expect.objectContaining({ code: "57014" }));
    expect(b.query("SELECT 1 AS n", [], none).rows).toEqual([{ n: 1 }]);
  });

  it("köprü yanıt sınırı aşılınca çalışan durur (TP_BRIDGE_TIMEOUT); sonraki istek yeni bağlantıyla sürer", () => {
    const b = open({ statementTimeoutMs: 10_000, waitMs: 300 });
    const t0 = Date.now();
    expect(() => b.query("SELECT pg_sleep(3)", [], none)).toThrow(BridgeError);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(b.query("SELECT 3 AS n", [], none).rows).toEqual([{ n: 3 }]);
  });

  it("işlem dışında kopan bağlantı yeniden kurulur; bağlam yeniden yazılır (eski bağlam sızmaz)", async () => {
    const b = open();
    const pid = b.query("SELECT pg_backend_pid() AS p", [], { org: A, scope: "" }).rows[0]!.p;
    await su.query("SELECT pg_terminate_backend($1)", [pid]);
    await sleep(300);
    const r = b.query("SELECT pg_backend_pid() AS p, current_setting('app.org_id', true) AS o", [], { org: B, scope: "" }).rows[0]!;
    expect(r.p).not.toBe(pid);
    expect(r.o).toBe(B);
  });

  it("işlem sürerken kopan bağlantı işlemi kaybeder (TP_TX_LOST); geri alma temiz, sonra köprü sürer", async () => {
    const b = open();
    const ctx = { org: A, scope: "" };
    b.begin();
    b.query("INSERT INTO bridge_t (id, v) VALUES (50, 'kayıp')", [], ctx);
    const pid = b.query("SELECT pg_backend_pid() AS p", [], ctx).rows[0]!.p;
    await su.query("SELECT pg_terminate_backend($1)", [pid]);
    await sleep(300);
    expect(() => b.query("SELECT 1", [], ctx)).toThrow(expect.objectContaining({ code: "TP_TX_LOST" }));
    expect(() => b.commit()).toThrow();
    expect(b.inTransaction).toBe(false);
    expect(b.query("SELECT 4 AS n", [], ctx).rows).toEqual([{ n: 4 }]);
    expect(await count("SELECT count(*) AS n FROM bridge_t WHERE id = 50")).toBe(0);
  });

  it("kapanış: açık işlem geri alınır, sonraki istek TP_BRIDGE_CLOSED, ikinci kapanış sorunsuz", async () => {
    const b = open();
    b.begin();
    b.query("INSERT INTO bridge_t (id, v) VALUES (60, 'kapanışta gider')", [], { org: A, scope: "" });
    await b.close();
    await b.close();
    expect(() => b.query("SELECT 1", [], none)).toThrow(expect.objectContaining({ code: "TP_BRIDGE_CLOSED" }));
    await sleep(100);
    expect(await count("SELECT count(*) AS n FROM bridge_t WHERE id = 60")).toBe(0);
  });

  it("yanlış parola açılışta hata verir", () => {
    const u = new URL(db.appUrl);
    u.password = "yanlis";
    expect(() => new SyncPgBridge({ connectionString: u.toString() })).toThrow(expect.objectContaining({ code: "28P01" }));
  });
});
