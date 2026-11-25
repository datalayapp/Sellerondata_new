import type { SQLInputValue, SQLOutputValue, StatementResultingChanges, StatementSync } from "node:sqlite";
import { type Db, tx } from "../db/database.ts";
import { inMaintenance, maybeOrg } from "./context.ts";
import { type SqlScan, normalizeSql, scanSql, scopeProblems, sqlHead } from "./sql-scan.ts";
import type { Tenancy } from "./tenancy.ts";

/** Kapsam kuralına uymayan SQL (programlama hatası; kullanıcıya 500). */
export class UnscopedSqlError extends Error {
  constructor(
    readonly sql: string,
    readonly problems: string[],
  ) {
    super(`Firma kapsamı hatası: ${problems.join("; ")} — ${sqlHead(sql)}`);
    this.name = "UnscopedSqlError";
  }
}

export type Params = (SQLInputValue | Record<string, SQLInputValue>)[];
/** Sonuç satırı (iki veritabanında aynı değer türleri: null, number, bigint, string, Uint8Array). */
export type Row = Record<string, SQLOutputValue>;

// ---------------------------------------------------------------- ortak arayüz (S5): SQLite ve Postgres aynı yüzü verir

/** Hazırlanmış ifade. `$org` ve `$member` adlı parametrelerini arayüz bağlar; elle verilmez. */
export interface StatementLike {
  run(...params: Params): StatementResultingChanges;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
  /** Postgres'te `all` üzerinden (satırlar önce okunur). */
  iterate(...params: Params): Iterator<Row>;
  readonly sourceSQL: string;
}

/** Bakım ifadesi: yalnız konumsal parametre. */
export interface MaintenanceStatementLike {
  run(...params: SQLInputValue[]): StatementResultingChanges;
  get(...params: SQLInputValue[]): Row | undefined;
  all(...params: SQLInputValue[]): Row[];
  iterate(...params: SQLInputValue[]): Iterator<Row>;
  readonly sourceSQL: string;
}

export type SqlDialect = "sqlite" | "pg";

/**
 * Servislerin ve rotaların veritabanına tek yolu (S5). `SqliteTenantDb` (yerel kip, bu dosya) ve `PgTenantDb`
 * (platform kipi, `db/pg/pg-tenant-db.ts`) bunu uygular. Kurallar ikisinde aynı: kapsamsız SQL reddedilir, bağlamsız
 * çağrı hata, `tx` iç içe çağrıda dıştakine katılır, yalnız eşzamanlı işlevler.
 */
export interface TenantDbLike {
  readonly dialect: SqlDialect;
  readonly tenancy: Tenancy;
  prepare(sql: string): StatementLike;
  tx<T>(fn: () => T): T;
  orgId(site?: string): string;
  readonly install: { prepare(sql: string): StatementLike; tx<T>(fn: () => T): T };
  readonly maintenance: { prepare(sql: string): MaintenanceStatementLike; exec(sql: string): void; tx<T>(fn: () => T): T };
}

/**
 * Mekanik çevrilemeyen SQL'in iki yazımı (plan §2.3): veritabanına göre biri seçilir. İki yazım da kapsam taramasından
 * (`$org`) geçer; Postgres yazımı ayrıca çeviriciden geçer (`?` ve `$org` kullanılır, `$1` yazılmaz).
 */
export function dialectSql(db: Pick<TenantDbLike, "dialect">, v: { sqlite: string; pg: string }): string {
  return db.dialect === "pg" ? v.pg : v.sqlite;
}

/**
 * Ekleme sırası sütunu (eşit sıralama anahtarında kararlı sıra): SQLite `rowid`, Postgres `ins_seq` (kimlik sütunu;
 * yalnız `rowid` ile sıralanan tablolarda: `gen_tasks`, `learn_runs`, `print_pages`, `print_items`, `design_sessions`).
 */
export function insertOrder(db: Pick<TenantDbLike, "dialect">): string {
  return db.dialect === "pg" ? "ins_seq" : "rowid";
}

/** Geçerli bağlamın üyesi (`$member`): platform kipinde jetondaki üyelik, yerelde ve bakımda null. */
export function currentMemberId(): string | null {
  return maybeOrg()?.memberId ?? null;
}

const MEMBER_PARAM = /\$member\b/i;
/** SQL `$member` adlı parametresini içeriyor mu (yorum ve metin değişmezleri hariç). */
export function usesMemberParam(sql: string): boolean {
  return MEMBER_PARAM.test(normalizeSql(sql));
}

/** `TenantDb.prepare` kuralları (iki veritabanında aynı); uymazsa `UnscopedSqlError`. */
export function checkTenantSql(sql: string): SqlScan {
  const s = scanSql(sql);
  const problems = s.multiple ? ["tek ifade olmalı"] : [];
  if (s.installTables.length) problems.push(`kurulum tablosu (${s.installTables.join(", ")}) yalnız TenantDb.install ile`);
  if (s.unknownTables.length) problems.push(`tanınmayan tablo: ${s.unknownTables.join(", ")} (kiracı tablosuysa org/tables.ts TENANT_TABLES'a ekleyin)`);
  problems.push(...scopeProblems(s));
  if (problems.length) throw new UnscopedSqlError(sql, problems);
  return s;
}

/** `TenantDb.install.prepare` kuralları (iki veritabanında aynı); uymazsa `UnscopedSqlError`. */
export function checkInstallSql(sql: string): SqlScan {
  const s = scanSql(sql);
  const problems: string[] = [];
  if (s.multiple) problems.push("tek ifade olmalı");
  if (s.tenantTables.length) problems.push(`kiracı tablosu (${s.tenantTables.join(", ")}) kurulum erişimiyle okunmaz; TenantDb.prepare kullanın`);
  if (s.unknownTables.length) problems.push(`tanınmayan tablo: ${s.unknownTables.join(", ")}`);
  problems.push(...s.unparsed);
  if (problems.length) throw new UnscopedSqlError(sql, problems);
  return s;
}

/** Adlı nesnede elle verilmemesi gereken parametreler (arayüz bağlar). */
export function assertNoReservedNamed(named: Record<string, unknown>): void {
  if (Object.hasOwn(named, "org") || Object.hasOwn(named, "$org")) throw new Error("`org` parametresi elle verilmez (TenantDb ekler).");
  if (Object.hasOwn(named, "member") || Object.hasOwn(named, "$member")) throw new Error("`member` parametresi elle verilmez (TenantDb ekler).");
}

export function isNamed(v: unknown): v is Record<string, SQLInputValue> {
  if (v === null || typeof v !== "object" || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------- SQLite uygulaması

/** node:sqlite deyiminin dar sarmalayıcısı: çalışırken adlı `org` (geçerli firma) ve `member` (üye) parametrelerini ekler. */
export class TenantStatement implements StatementLike {
  constructor(
    private readonly stmt: StatementSync,
    private readonly org: (() => string) | null,
    private readonly member = false,
  ) {}

  run(...params: Params): StatementResultingChanges {
    return this.stmt.run(...(this.bind(params) as [Record<string, SQLInputValue>, ...SQLInputValue[]]));
  }

  get(...params: Params): Row | undefined {
    return this.stmt.get(...(this.bind(params) as [Record<string, SQLInputValue>, ...SQLInputValue[]]));
  }

  all(...params: Params): Row[] {
    return this.stmt.all(...(this.bind(params) as [Record<string, SQLInputValue>, ...SQLInputValue[]]));
  }

  iterate(...params: Params): Iterator<Row> {
    return this.stmt.iterate(...(this.bind(params) as [Record<string, SQLInputValue>, ...SQLInputValue[]]));
  }

  get sourceSQL(): string {
    return this.stmt.sourceSQL;
  }

  private bind(params: Params): Params {
    if (!this.org && !this.member) return params;
    const extra: Record<string, SQLInputValue> = {};
    if (this.org) extra.org = this.org();
    if (this.member) extra.member = currentMemberId();
    const [first, ...rest] = params;
    if (isNamed(first)) {
      assertNoReservedNamed(first);
      return [{ ...first, ...extra }, ...rest];
    }
    return [extra, ...params];
  }
}

/** Kurulum tabloları (`settings`, `orgs`): firma kapsamı yok; kiracı tablosuna dokunan SQL reddedilir. */
export class InstallDb {
  constructor(private readonly db: Db) {}

  prepare(sql: string): TenantStatement {
    checkInstallSql(sql);
    return new TenantStatement(this.db.prepare(sql), null);
  }

  tx<T>(fn: () => T): T {
    return tx(this.db, fn);
  }
}

/**
 * Kurulum geneli bakım bağlantısı (ham, kapsam denetimi yok; her firmanın satırına erişir): açılışta kurtarma, kalıcı
 * temizlik, göç, betikler ve testlerin kendi denetimleri. Yalnız `maintenance(…)` içinde çalışır; dışında sıkı kipte
 * hata, denetim kipinde (`TAGPRESS_TENANCY=audit`) çalışır ve sayılır (`tenancy.audit`, tür `raw-sql`).
 */
export class MaintenanceDb {
  constructor(
    private readonly db: Db,
    private readonly tenancy: Tenancy,
  ) {}

  /**
   * Deyim sarılır: bakım kapsamı HER çalıştırmada denetlenir (bakımda hazırlanıp dışarı taşınan deyim dışarıda
   * kapsamsız çalışmasın). Sıkı kipte hazırlama da bakım dışında hata verir.
   */
  prepare(sql: string): MaintenanceStatement {
    if (!inMaintenance() && this.tenancy.strict) throw new MaintenanceScopeError(sql);
    return new MaintenanceStatement(this.db.prepare(sql), () => this.require(sql));
  }

  exec(sql: string): void {
    this.require(sql);
    this.db.exec(sql);
  }

  tx<T>(fn: () => T): T {
    this.require("tx");
    return tx(this.db, fn);
  }

  private require(sql: string): void {
    requireMaintenance(this.tenancy, sql);
  }
}

/** Bakım kapsamı denetimi (iki veritabanında aynı): sıkı kipte kapsam dışı hata, denetim kipinde sayılır. */
export function requireMaintenance(tenancy: Tenancy, sql: string): void {
  if (inMaintenance()) return;
  if (tenancy.strict) throw new MaintenanceScopeError(sql);
  tenancy.audit.record("raw-sql", sqlHead(sql));
}

/** Bakım deyimi: her çalıştırmada bakım kapsamı denetlenir (`MaintenanceDb.prepare`). */
export class MaintenanceStatement implements MaintenanceStatementLike {
  constructor(
    private readonly stmt: StatementSync,
    private readonly check: () => void,
  ) {}

  run(...params: SQLInputValue[]): StatementResultingChanges {
    this.check();
    return this.stmt.run(...params);
  }

  get(...params: SQLInputValue[]): Row | undefined {
    this.check();
    return this.stmt.get(...params);
  }

  all(...params: SQLInputValue[]): Row[] {
    this.check();
    return this.stmt.all(...params);
  }

  iterate(...params: SQLInputValue[]): Iterator<Row> {
    this.check();
    return this.stmt.iterate(...params);
  }

  get sourceSQL(): string {
    return this.stmt.sourceSQL;
  }
}

/** Bakım bağlantısı bakım kapsamı dışında kullanıldı (sıkı kip; programlama hatası, kullanıcıya 500). */
export class MaintenanceScopeError extends Error {
  constructor(readonly sql: string) {
    super(`Bakım bağlantısı yalnız maintenance(…) içinde kullanılır: ${sqlHead(sql)}`);
    this.name = "MaintenanceScopeError";
  }
}

/**
 * Servislerin ve rotaların veritabanına tek yolu (ham bağlantı verilmez); yerel kip (node:sqlite).
 * - `prepare(sql)`: kiracı tablosuna dokunan SQL `$org` içermeli (kurallar: `scopeProblems`); çalışırken `org` adlı
 *   parametresi geçerli firmayla, `member` adlı parametresi geçerli üyeyle (yerelde null) doldurulur; `?` parametreleri
 *   aynen kalır. Kapsamsız SQL HER kipte reddedilir. Kurulum tablosu (`settings`, `orgs`) ve listede olmayan tablo burada
 *   da reddedilir.
 * - `install`: kurulum tabloları. `maintenance`: bakım kapsamında, kapsamsız.
 * - Bağlamsız çağrı (firma bağlamı yok ya da bakım kapsamı) her kipte hata.
 *
 * Platform kipinde aynı arayüzle `PgTenantDb` (`db/pg/pg-tenant-db.ts`: senkron köprü + RLS). Servisler türü `TenantDb`
 * (= `TenantDbLike`) olarak görür; `new TenantDb(…)` bu SQLite uygulamasını kurar.
 */
export class SqliteTenantDb implements TenantDbLike {
  readonly dialect = "sqlite" as const;
  readonly install: InstallDb;
  readonly maintenance: MaintenanceDb;

  constructor(
    private readonly db: Db,
    readonly tenancy: Tenancy,
  ) {
    this.install = new InstallDb(db);
    this.maintenance = new MaintenanceDb(db, tenancy);
  }

  prepare(sql: string): TenantStatement {
    const s = checkTenantSql(sql);
    const site = sqlHead(sql);
    return new TenantStatement(this.db.prepare(sql), s.hasOrgParam ? () => this.tenancy.orgId(site) : null, usesMemberParam(sql));
  }

  /** Geçerli firma (bağlamsızsa hata). */
  orgId(site = "TenantDb.orgId"): string {
    return this.tenancy.orgId(site);
  }

  /** İşlem (iç içe çağrıda dıştaki kullanılır; bakım bağlantısıyla açılmış işlem de dahil). Yalnız eşzamanlı işlevler. */
  tx<T>(fn: () => T): T {
    return tx(this.db, fn);
  }
}

/** Değer olarak SQLite uygulaması (`new TenantDb(db, tenancy)`), tür olarak ortak arayüz (`TenantDbLike`). */
export const TenantDb = SqliteTenantDb;
export type TenantDb = TenantDbLike;
