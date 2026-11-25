import type { SQLInputValue, StatementResultingChanges } from "node:sqlite";
import { inMaintenance, maybeOrg } from "../../org/context.ts";
import { sqlHead } from "../../org/sql-scan.ts";
import {
  type MaintenanceStatementLike,
  MaintenanceScopeError,
  type Params,
  type Row,
  type StatementLike,
  type TenantDbLike,
  assertNoReservedNamed,
  checkInstallSql,
  checkTenantSql,
  currentMemberId,
  isNamed,
  requireMaintenance,
} from "../../org/tenant-db.ts";
import type { Tenancy } from "../../org/tenancy.ts";
import { type BridgeResult, PgQueryError, type SqlCtx, SyncPgBridge } from "./bridge.ts";
import { type PgSql, toPg, toPgScript } from "./dialect.ts";

/**
 * `TenantDbLike`'ın Postgres uygulaması (platform kipi; plan §2.2, S5). Servis kodu SQLite'takiyle aynıdır:
 * - Kapsam kuralları aynı (`checkTenantSql`, `checkInstallSql`, bakım kapsamı). Ek olarak Postgres RLS: her ifade
 *   bağlantının `app.org_id`'si geçerli firmayla aynıyken çalışır (köprü farklıysa önce yazar). Bağlamsız ifadede
 *   `app.org_id` boştur: kiracı tablosu satırı görünmez, yazılamaz (kapanırken bile sızmaz).
 * - Bakım (`maintenance`): `app.org_id` boş, `app.scope = 'queue'` (TP-SEMA'nın listelediği tablolarda firmalar arası
 *   okuma/güncelleme ilkesi). Kurulum (`install`): `app.org_id` geçerli firma ya da boş.
 * - SQL metni `toPg` ile çevrilir (`?` → `$n`, `LIKE` → `ILIKE` …); çevrilemeyen yapı hazırlarken hata verir.
 * - `tx`: köprünün tek işlemi; iç içe çağrı dıştakine katılır; işlem içinde her ifade kayıt noktasında (hata veren ifade
 *   yalnız kendini geri alır, SQLite gibi).
 */
export class PgTenantDb implements TenantDbLike {
  readonly dialect = "pg" as const;
  readonly install: PgInstallDb;
  readonly maintenance: PgMaintenanceDb;

  constructor(
    readonly bridge: SyncPgBridge,
    readonly tenancy: Tenancy,
  ) {
    this.install = new PgInstallDb(bridge);
    this.maintenance = new PgMaintenanceDb(bridge, tenancy);
  }

  prepare(sql: string): StatementLike {
    const s = checkTenantSql(sql);
    const site = sqlHead(sql);
    const pg = toPg(sql);
    // Kiracı tablosuna dokunan ifade firma bağlamı ister ($org olmasa da: RLS bağlamı yazılmalı).
    const needsOrg = s.hasOrgParam || s.tenantTables.length > 0;
    return new PgStatement(this.bridge, sql, pg, () => {
      const org = needsOrg ? this.tenancy.orgId(site) : (maybeOrg()?.orgId ?? "");
      return { ctx: { org, scope: "" }, org };
    });
  }

  orgId(site = "TenantDb.orgId"): string {
    return this.tenancy.orgId(site);
  }

  tx<T>(fn: () => T): T {
    return this.bridge.transaction(fn);
  }
}

class PgInstallDb {
  constructor(private readonly bridge: SyncPgBridge) {}

  prepare(sql: string): StatementLike {
    checkInstallSql(sql);
    return new PgStatement(this.bridge, sql, toPg(sql), () => ({ ctx: { org: maybeOrg()?.orgId ?? "", scope: "" }, org: null }));
  }

  tx<T>(fn: () => T): T {
    return this.bridge.transaction(fn);
  }
}

/** Bakım bağlamı: firma yok, kapsam `queue` (RLS'nin firmalar arası bakım ilkeleri). */
export const MAINTENANCE_CTX: SqlCtx = { org: "", scope: "queue" };

class PgMaintenanceDb {
  constructor(
    private readonly bridge: SyncPgBridge,
    private readonly tenancy: Tenancy,
  ) {}

  prepare(sql: string): MaintenanceStatementLike {
    if (!inMaintenance() && this.tenancy.strict) throw new MaintenanceScopeError(sql);
    const pg = toPg(sql);
    // Bakımda lastInsertRowid kullanılmaz; RETURNING kuyruk kapsamında SELECT ilkesi isterdi (dialect.ts `plainText`).
    const stmt = new PgStatement(this.bridge, sql, pg.returnsId ? { ...pg, text: pg.plainText, returnsId: false } : pg, () => {
      requireMaintenance(this.tenancy, sql);
      return { ctx: MAINTENANCE_CTX, org: null };
    });
    return stmt as MaintenanceStatementLike;
  }

  exec(sql: string): void {
    requireMaintenance(this.tenancy, sql);
    this.bridge.exec(toPgScript(sql), MAINTENANCE_CTX);
  }

  tx<T>(fn: () => T): T {
    requireMaintenance(this.tenancy, "tx");
    return this.bridge.transaction(fn);
  }
}

type Bound = { ctx: SqlCtx; org: string | null };

/** Postgres ifadesi: her çalıştırmada bağlam ve parametreler bağlanır, köprüden geçer. */
export class PgStatement implements StatementLike {
  constructor(
    private readonly bridge: SyncPgBridge,
    readonly sourceSQL: string,
    private readonly pg: PgSql,
    private readonly bound: () => Bound,
  ) {}

  run(...params: Params): StatementResultingChanges {
    let r: BridgeResult;
    try {
      r = this.exec(params);
    } catch (err) {
      // Başka firmanın satırıyla çatışan korumalı ekleme-güncelleme: SQLite'taki gibi 0 değişiklik (dialect.ts `upsertOrgGuard`).
      if (this.pg.upsertOrgGuard && err instanceof PgQueryError && err.code === "42501" && /USING expression/.test(err.message)) return { changes: 0, lastInsertRowid: 0 };
      throw err;
    }
    const id = this.pg.returnsId ? r.rows[0]?.id : undefined;
    return { changes: r.rowCount, lastInsertRowid: typeof id === "number" || typeof id === "bigint" ? id : id == null ? 0 : Number(id) };
  }

  get(...params: Params): Row | undefined {
    return this.rows(this.exec(params))[0];
  }

  all(...params: Params): Row[] {
    return this.rows(this.exec(params));
  }

  iterate(...params: Params): Iterator<Row> {
    return this.all(...params)[Symbol.iterator]();
  }

  private exec(params: Params): BridgeResult {
    const b = this.bound();
    const values = bindValues(this.pg, params, b.org, this.sourceSQL);
    return this.bridge.query(this.pg.text, values, b.ctx);
  }

  /** Postgres'in küçük harfe çevirdiği karışık harfli sütun adları metindeki yazımına döner. */
  private rows(r: BridgeResult): Row[] {
    const rows = r.rows as Row[];
    const ren = this.pg.rename;
    if (!ren.size || !r.fields.some((f) => ren.has(f) && ren.get(f) !== f)) return rows;
    return rows.map((row) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) out[ren.get(k) ?? k] = v;
      return out;
    });
  }
}

/** node:sqlite'ın bağladığı değer türleri; ötekiler (mantıksal, undefined, nesne) SQLite gibi reddedilir. */
function checkValue(v: unknown, sql: string): SQLInputValue {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError(`Bağlanamayan parametre türü (${v === undefined ? "undefined" : typeof v}): ${sqlHead(sql)}`);
}

/** `$1…$n` değerleri: `?` sırayla, adlılar ilk adlı nesneden; `$org` ve `$member` arayüzden. */
export function bindValues(pg: PgSql, params: Params, org: string | null, sql: string): unknown[] {
  let named: Record<string, SQLInputValue> | null = null;
  let positional = params as unknown[];
  const [first, ...rest] = params;
  if (isNamed(first)) {
    assertNoReservedNamed(first);
    named = first;
    positional = rest;
  }
  if (positional.length > pg.positional) throw new RangeError(`Fazla parametre (${positional.length}, beklenen ${pg.positional}): ${sqlHead(sql)}`);
  return pg.slots.map((slot) => {
    if (slot.kind === "pos") return slot.index < positional.length ? checkValue(positional[slot.index], sql) : null;
    if (slot.name === "org") {
      if (org === null) throw new Error(`$org yalnız kiracı ifadesinde bağlanır: ${sqlHead(sql)}`);
      return org;
    }
    if (slot.name === "member") return currentMemberId();
    if (!named) throw new Error(`Adlı parametre verilmedi ($${slot.name}): ${sqlHead(sql)}`);
    const key = Object.hasOwn(named, slot.name) ? slot.name : Object.hasOwn(named, `$${slot.name}`) ? `$${slot.name}` : null;
    if (key === null) throw new Error(`Adlı parametre verilmedi ($${slot.name}): ${sqlHead(sql)}`);
    return checkValue(named[key], sql);
  });
}
