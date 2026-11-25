import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MessageChannel, type MessagePort, Worker, receiveMessageOnPort } from "node:worker_threads";

/**
 * Senkron Postgres köprüsü (plan §2.2, karar b): `pg` bir çalışan iş parçacığında (`worker.ts`) tek bağlantıyla çalışır;
 * ana iş parçacığı isteği gönderir ve yanıt gelene kadar `Atomics.wait` ile bekler. TagPress servisleri senkron kalır
 * (bugünkü SQLite'ın tek bağlantılı, sıralı modeli). Bedel: sorgu süresince olay döngüsü bekler.
 *
 * Kurallar:
 * - Tek bağlantı; `lock_timeout` 5 sn, `statement_timeout` 30 sn, `idle_in_transaction_session_timeout` 60 sn (async
 *   havuzdaki bir işlemin kilidini beklerken süreç sonsuza dek donmaz, hata alır).
 * - Her ifade istenen bağlamı (`app.org_id`, `app.scope`) taşır; çalışan, bağlantının değeri farklıysa önce yazar.
 * - `begin/commit/rollback` tek işlem; iç içe işlemi `PgTenantDb.tx` dıştakine katar (köprüde iç içe BEGIN hatadır).
 * - Yanıt `waitMs` içinde gelmezse çalışan durdurulur, istek `BridgeError` (`TP_BRIDGE_TIMEOUT`) ile düşer; sonraki istek
 *   (işlem dışında) yeni çalışan ve bağlantıyla sürer. İşlem içindeyken kopan bağlantı işlemi kaybeder (`TP_TX_LOST`).
 */

export type SqlCtx = { org: string; scope: string };

export interface BridgeOptions {
  connectionString: string;
  /** Kilit bekleme sınırı (ms). Varsayılan 5000. */
  lockTimeoutMs?: number;
  /** İfade süresi sınırı (ms). Varsayılan 30000. */
  statementTimeoutMs?: number;
  /** İşlem içinde boşta kalma sınırı (ms). Varsayılan 60000. */
  idleInTransactionTimeoutMs?: number;
  /** Ana tarafın yanıt bekleme sınırı (ms). Varsayılan `statementTimeoutMs + 15000`. */
  waitMs?: number;
  /** Bağlantının `search_path`'i (verilmezse rolün varsayılanı; uygulama rolünde `tagpress, pg_temp`). */
  searchPath?: string;
  applicationName?: string;
}

export interface BridgeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: string[];
  command: string;
}

/** Postgres'in döndürdüğü hata (SQLSTATE `code` korunur). Benzersizlik ihlalinde SQLite uyumlu `errcode` da vardır. */
export class PgQueryError extends Error {
  /** Postgres SQLSTATE (ör. `23505`). */
  readonly code: string;
  /** SQLite'ın genişletilmiş hata kodunun karşılığı (yakalayan servisler için; ör. birincil anahtar 1555, benzersiz 2067). */
  readonly errcode?: number;
  readonly detail?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly sql: string;

  constructor(e: Record<string, string | undefined>, sql: string) {
    super(e.message ?? "Postgres hatası");
    this.name = "PgQueryError";
    this.code = e.code ?? "";
    this.sql = sql;
    if (e.detail) this.detail = e.detail;
    if (e.constraint) this.constraint = e.constraint;
    if (e.table) this.table = e.table;
    if (e.column) this.column = e.column;
    const errcode = sqliteErrcode(this.code, e.constraint);
    if (errcode !== undefined) this.errcode = errcode;
  }
}

/** Köprünün kendi hatası (zaman aşımı, kapalı köprü, kopan işlem, çalışan düştü). */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/**
 * SQLSTATE → SQLite genişletilmiş kodu (yalnız servislerin ayırt ettiği kısıt ihlalleri). Postgres birincil anahtar
 * kısıtının adı `<tablo>_pkey`'dir.
 */
function sqliteErrcode(code: string, constraint: string | undefined): number | undefined {
  if (code === "23505") return constraint?.endsWith("_pkey") ? 1555 : 2067; // SQLITE_CONSTRAINT_PRIMARYKEY / _UNIQUE
  if (code === "23503") return 787; // SQLITE_CONSTRAINT_FOREIGNKEY
  if (code === "23502") return 1299; // SQLITE_CONSTRAINT_NOTNULL
  if (code === "23514") return 275; // SQLITE_CONSTRAINT_CHECK
  return undefined;
}

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: Record<string, string> };

/** Çalışan dosyası: kaynakta `worker.ts`, derlenmiş çıktıda `worker.js` (köprüyle aynı klasör). */
function workerUrl(): URL {
  const own = import.meta.url;
  const ts = new URL("./worker.ts", own);
  const js = new URL("./worker.js", own);
  if (own.endsWith(".js") && existsSync(fileURLToPath(js))) return js;
  return existsSync(fileURLToPath(ts)) ? ts : js;
}

export class SyncPgBridge {
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private signal: Int32Array | null = null;
  private seq = 0;
  private tx = false;
  private closed = false;
  private readonly waitMs: number;
  private readonly settings: Record<string, string>;

  constructor(private readonly opts: BridgeOptions) {
    const statement = opts.statementTimeoutMs ?? 30_000;
    this.waitMs = opts.waitMs ?? statement + 15_000;
    this.settings = {
      lock_timeout: `${opts.lockTimeoutMs ?? 5_000}ms`,
      statement_timeout: `${statement}ms`,
      idle_in_transaction_session_timeout: `${opts.idleInTransactionTimeoutMs ?? 60_000}ms`,
      ...(opts.searchPath ? { search_path: opts.searchPath } : {}),
    };
    // Bağlantı hemen kurulur: yanlış adres ya da parola açılışta görünür (çalışan kapatılır).
    try {
      this.request({ op: "connect" }, "connect", this.connectWaitMs());
    } catch (err) {
      this.dropWorker();
      this.closed = true;
      throw err;
    }
  }

  /** İşlem açık mı (bu köprünün bağlantısında). */
  get inTransaction(): boolean {
    return this.tx;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Tek ifade, `$1…$n` parametreleriyle. */
  query(sql: string, params: readonly unknown[], ctx: SqlCtx): BridgeResult {
    return this.request({ op: "query", sql, params, ctx }, sql) as BridgeResult;
  }

  /** Parametresiz, birden çok ifade içerebilen metin (basit sorgu protokolü). Son ifadenin sonucu döner. */
  exec(sql: string, ctx: SqlCtx): BridgeResult {
    return this.request({ op: "query", sql, params: [], ctx, multi: true }, sql) as BridgeResult;
  }

  begin(): void {
    if (this.tx) throw new BridgeError("İşlem zaten açık (iç içe işlem dıştakine katılmalı).", "TP_TX_NESTED");
    this.request({ op: "begin" }, "BEGIN");
    this.tx = true;
  }

  commit(): void {
    try {
      this.request({ op: "commit" }, "COMMIT");
    } finally {
      this.tx = false;
    }
  }

  rollback(): void {
    if (!this.tx) return;
    try {
      // Çalışan düştüyse işlem bağlantıyla birlikte gitmiştir; yeni çalışan açmaya gerek yok.
      if (this.worker) this.request({ op: "rollback" }, "ROLLBACK");
    } finally {
      this.tx = false;
    }
  }

  /** `fn`'i tek işlemde çalıştırır (açık işlem varsa ona katılır). Yalnız eşzamanlı işlevler. */
  transaction<T>(fn: () => T): T {
    if (this.tx) return fn();
    this.begin();
    let out: T;
    try {
      out = fn();
    } catch (err) {
      try {
        this.rollback();
      } catch {
        // Asıl hata korunur.
      }
      throw err;
    }
    this.commit();
    return out;
  }

  /** Bağlantıyı kapatır (eşzamanlı); çalışan sonlandırılır. Sonraki istekler `TP_BRIDGE_CLOSED`. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    let ended: Promise<unknown> = Promise.resolve();
    try {
      if (this.worker) {
        try {
          this.request({ op: "close" }, "close", 5_000);
        } catch {
          // Kapanışta yanıt gelmezse çalışan yine sonlandırılır.
        }
        ended = this.worker.terminate();
      }
    } finally {
      this.closed = true;
      this.tx = false;
      this.port?.close();
      this.worker = null;
      this.port = null;
    }
    return ended.then(() => undefined);
  }

  // ---------------------------------------------------------------- iç

  private spawn(): void {
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const w = new Worker(workerUrl(), {
      workerData: {
        port: port2,
        signal: sab,
        connectionString: this.opts.connectionString,
        settings: this.settings,
        applicationName: this.opts.applicationName ?? "tagpress",
      },
      transferList: [port2],
    });
    // Çalışan süreci ayakta tutmasın; olaylar (ana taraf beklerken işlenemez) yalnız sonraki isteği etkiler.
    w.unref();
    w.on("error", () => this.dropWorker());
    w.on("exit", () => {
      if (this.worker === w) this.dropWorker();
    });
    this.worker = w;
    this.port = port1;
    this.signal = new Int32Array(sab);
  }

  private dropWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.port?.close();
    this.port = null;
    this.signal = null;
    if (w) void w.terminate().catch(() => undefined);
  }

  /** Bağlantı kurma (çalışanın açılışı + TCP + kimlik) sorgu sınırından ayrıdır: kısa `waitMs` yavaş makinede bağlanmayı düşürmesin. */
  private connectWaitMs(): number {
    return Math.max(this.waitMs, 15_000);
  }

  private request(msg: Record<string, unknown>, sql: string, waitMs = this.waitMs): unknown {
    if (this.closed) throw new BridgeError("Veritabanı köprüsü kapalı.", "TP_BRIDGE_CLOSED");
    if (!this.worker) {
      if (this.tx) throw new BridgeError("Veritabanı bağlantısı işlem sürerken koptu; işlem geri alındı.", "TP_TX_LOST");
      this.spawn();
      if (msg.op !== "connect") this.request({ op: "connect" }, "connect", this.connectWaitMs());
    }
    const port = this.port!;
    const signal = this.signal!;
    const id = ++this.seq;
    port.postMessage({ ...msg, id });
    const deadline = Date.now() + waitMs;
    // Çalışan her yanıttan sonra sayacı artırır ve uyandırır. Sayaç kutuya bakmadan ÖNCE okunur: yanıt arada gelirse
    // `wait` beklemeden döner (kayıp uyandırma yok).
    for (;;) {
      const seen = Atomics.load(signal, 0);
      let got = receiveMessageOnPort(port);
      while (got && (got.message as Reply).id !== id) got = receiveMessageOnPort(port); // eski/kimliksiz yanıt atılır
      if (got) {
        const r = got.message as Reply;
        if (r.ok) return r.result;
        if (r.error.code === "TP_WORKER_CRASH") this.dropWorker();
        if (r.error.code?.startsWith("TP_")) throw new BridgeError(r.error.message ?? "Veritabanı köprüsü hatası", r.error.code);
        throw new PgQueryError(r.error, sql);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        this.dropWorker();
        throw new BridgeError(`Veritabanı ${waitMs} ms içinde yanıt vermedi: ${head(sql)}`, "TP_BRIDGE_TIMEOUT");
      }
      Atomics.wait(signal, 0, seen, left);
    }
  }
}

function head(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}
