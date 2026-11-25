/**
 * Senkron Postgres köprüsünün çalışan iş parçacığı (`bridge.ts` başlatır; plan §2.2). Tek `pg.Client` bağlantısı tutar,
 * ana iş parçacığının isteklerini SIRAYLA işler ve her yanıttan sonra paylaşılan sinyali (`Atomics.notify`) uyandırır;
 * ana iş parçacığı o sırada `Atomics.wait` ile bekler.
 *
 * Bu dosya Node'a doğrudan verilir (Vite/tsx dönüşümü olmadan da çalışsın): yalnız silinebilir tip sözdizimi, göreli
 * içe aktarma yok.
 *
 * Bağlam: her istek istenen `{ org, scope }` değerini taşır. Bağlantının o anki `app.org_id` / `app.scope` değeri farklıysa
 * ifadeden önce `set_config` yazılır: işlem dışında oturum düzeyinde (`false`), işlem içinde işlem düzeyinde (`true`;
 * COMMIT/ROLLBACK sonrası oturum değerine döner). Değerin izi bağlantının sahibi olan bu iş parçacığında tutulur;
 * bağlantı yeniden kurulunca iz sıfırlanır (eski bağlam sızmaz).
 *
 * İşlem içinde her ifade kendi kayıt noktasında (`SAVEPOINT`) çalışır: hata veren ifade yalnız kendini geri alır, işlem
 * sürer (SQLite'ın ifade düzeyi atomikliği; servisler işlem içinde hatayı yakalayıp devam edebilir).
 */
import { workerData, type MessagePort } from "node:worker_threads";
import pg from "pg";

type Ctx = { org: string; scope: string };
type Req =
  | { op: "connect" }
  | { op: "query"; sql: string; params: unknown[]; ctx: Ctx; multi?: boolean }
  | { op: "begin" }
  | { op: "commit" }
  | { op: "rollback" }
  | { op: "close" };

interface Data {
  port: MessagePort;
  signal: SharedArrayBuffer;
  connectionString: string;
  settings: Record<string, string>;
  applicationName: string;
}

const data = workerData as Data;
const port = data.port;
const signal = new Int32Array(data.signal);

// ---------------------------------------------------------------- tür çözümleyicileri (yalnız bu bağlantı)

const OID = { bool: 16, int8: 20, json: 114, numeric: 1700, jsonb: 3802, date: 1082, timestamp: 1114, timestamptz: 1184, interval: 1186 };

/** node:sqlite'ın verdiğiyle aynı biçim: tam sayı ve ondalık `number`, mantıksal 0/1, JSON metin. */
function typeParser(oid: number): (value: string) => unknown {
  switch (oid) {
    case OID.int8:
      return (v) => {
        const n = Number(v);
        // Güvenli aralık dışı tam sayı kaybolmasın: bigint (servis kodunda açıkça görünür).
        return Number.isSafeInteger(n) ? n : BigInt(v);
      };
    case OID.numeric:
      return (v) => Number(v);
    case OID.bool:
      return (v) => (v === "t" || v === "true" ? 1 : 0);
    case OID.json:
    case OID.jsonb:
    case OID.date:
    case OID.timestamp:
    case OID.timestamptz:
    case OID.interval:
      return (v) => v;
    default:
      return pg.types.getTypeParser(oid as never) as (v: string) => unknown;
  }
}

// ---------------------------------------------------------------- bağlantı durumu

let client: pg.Client | null = null;
/** Bağlantı koptu (istemci `error` olayı ya da sorgu sırasında bağlantı hatası). */
let broken = false;
let inTx = false;
/** İşlem sürerken bağlantı koptu: işlem kayıp; yalnız ROLLBACK kabul edilir. */
let txLost = false;
/** Bağlantının oturum düzeyindeki bağlam değeri (bilinmiyorsa null). */
let session: Ctx | null = null;
/** İşlem içindeki geçerli değer (işlem yoksa null). */
let local: Ctx | null = null;

async function connect(): Promise<void> {
  const c = new pg.Client({ connectionString: data.connectionString, application_name: data.applicationName, types: { getTypeParser: typeParser as never } });
  c.on("error", () => {
    broken = true;
  });
  c.on("end", () => {
    broken = true;
  });
  await c.connect();
  try {
    for (const [k, v] of Object.entries(data.settings)) await c.query("SELECT set_config($1, $2, false)", [k, v]);
    await c.query("SELECT set_config('app.org_id', '', false), set_config('app.scope', '', false)");
  } catch (err) {
    await c.end().catch(() => undefined);
    throw err;
  }
  client = c;
  broken = false;
  session = { org: "", scope: "" };
  local = null;
}

async function ensure(): Promise<pg.Client> {
  if (txLost) throw tagged(new Error("Veritabanı bağlantısı işlem sürerken koptu; işlem geri alındı."), "TP_TX_LOST");
  if (client && !broken) return client;
  if (inTx) {
    txLost = true;
    throw tagged(new Error("Veritabanı bağlantısı işlem sürerken koptu; işlem geri alındı."), "TP_TX_LOST");
  }
  const old = client;
  client = null;
  session = null;
  if (old) await old.end().catch(() => undefined);
  await connect();
  return client!;
}

function tagged(err: Error, code: string): Error {
  (err as Error & { code?: string }).code = code;
  return err;
}

/** Bağlantı düzeyi hata mı (sorgu hatası değil): kopma, ağ, istemcinin kapanması. */
function connectionLost(err: unknown): boolean {
  if (broken) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^(08|57P0[1-3])/.test(code)) return true; // bağlantı istisnaları, yönetici kapatması
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return true; // ECONNRESET, EPIPE …
  const msg = err instanceof Error ? err.message : String(err);
  return /Connection terminated|Client has encountered a connection error|not queryable/i.test(msg);
}

async function applyCtx(c: pg.Client, ctx: Ctx): Promise<void> {
  const cur = inTx ? local : session;
  if (cur && cur.org === ctx.org && cur.scope === ctx.scope) return;
  await c.query("SELECT set_config('app.org_id', $1, $3), set_config('app.scope', $2, $3)", [ctx.org, ctx.scope, inTx]);
  if (inTx) local = { ...ctx };
  else session = { ...ctx };
}

type Out = { rows: Record<string, unknown>[]; rowCount: number; fields: string[]; command: string };

function shape(r: pg.QueryResult | pg.QueryResult[]): Out {
  const last = Array.isArray(r) ? r[r.length - 1] : r;
  if (!last) return { rows: [], rowCount: 0, fields: [], command: "" };
  return { rows: last.rows ?? [], rowCount: last.rowCount ?? 0, fields: (last.fields ?? []).map((f) => f.name), command: last.command ?? "" };
}

async function query(req: Extract<Req, { op: "query" }>): Promise<Out> {
  const c = await ensure();
  try {
    await applyCtx(c, req.ctx);
    const run = () => (req.multi ? c.query(req.sql) : c.query({ text: req.sql, values: req.params }));
    if (!inTx) return shape((await run()) as pg.QueryResult);
    await c.query("SAVEPOINT tp_stmt");
    let out: Out;
    try {
      out = shape((await run()) as pg.QueryResult);
    } catch (err) {
      if (connectionLost(err)) throw err;
      // Yalnız bu ifade geri alınır; işlem sürer (set_config kayıt noktasından önce yazıldığı için korunur).
      await c.query("ROLLBACK TO SAVEPOINT tp_stmt");
      await c.query("RELEASE SAVEPOINT tp_stmt");
      throw err;
    }
    await c.query("RELEASE SAVEPOINT tp_stmt");
    return out;
  } catch (err) {
    if (connectionLost(err)) {
      broken = true;
      if (inTx) txLost = true;
    }
    throw err;
  }
}

async function handle(req: Req): Promise<unknown> {
  switch (req.op) {
    case "connect":
      await ensure();
      return null;
    case "query":
      return query(req);
    case "begin": {
      if (inTx) throw new Error("İşlem zaten açık (iç içe BEGIN).");
      const c = await ensure();
      await c.query("BEGIN");
      inTx = true;
      txLost = false;
      local = session ? { ...session } : null;
      return null;
    }
    case "commit": {
      if (!inTx) throw new Error("Açık işlem yok (COMMIT).");
      try {
        if (txLost) throw tagged(new Error("Veritabanı bağlantısı işlem sürerken koptu; işlem geri alındı."), "TP_TX_LOST");
        const r = await client!.query("COMMIT");
        // Hatalı durumdaki işlemde COMMIT sessizce ROLLBACK olur: bunu başarı sayma.
        if (r.command === "ROLLBACK") throw tagged(new Error("İşlem tamamlanamadı (veritabanı geri aldı)."), "TP_TX_ABORTED");
      } catch (err) {
        if (connectionLost(err)) broken = true;
        throw err;
      } finally {
        inTx = false;
        txLost = false;
        local = null;
      }
      return null;
    }
    case "rollback": {
      if (!inTx) return null;
      try {
        if (!txLost && client && !broken) await client.query("ROLLBACK");
      } catch (err) {
        if (connectionLost(err)) broken = true;
        else throw err;
      } finally {
        inTx = false;
        txLost = false;
        local = null;
      }
      return null;
    }
    case "close": {
      const c = client;
      client = null;
      if (c) await c.end().catch(() => undefined);
      return null;
    }
  }
}

/** Hata nesnesi yapılandırılmış kopyayla taşınabilsin diye düz alanlara. */
function serialize(err: unknown): Record<string, unknown> {
  const e = (err ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { message: err instanceof Error ? err.message : String(err) };
  for (const k of ["code", "severity", "detail", "hint", "position", "schema", "table", "column", "dataType", "constraint", "routine", "where"]) {
    if (e[k] !== undefined && e[k] !== null) out[k] = String(e[k]);
  }
  return out;
}

/** İşlenmekte olan isteğin kimliği (yanıt eşleşmesi; ana taraf kimliği tutmayan yanıtı atar). */
let pending: number | null = null;

function reply(msg: { id: number } & Record<string, unknown>): void {
  if (pending === msg.id) pending = null;
  port.postMessage(msg);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}

port.on("message", (msg: Req & { id: number }) => {
  pending = msg.id;
  handle(msg).then(
    (result) => {
      reply({ id: msg.id, ok: true, result });
      if (msg.op === "close") port.close();
    },
    (err: unknown) => reply({ id: msg.id, ok: false, error: serialize(err) }),
  );
});

// Beklenmeyen hata iş parçacığını düşürmesin; bekleyen istek varsa yanıtsız kalmasın (ana taraf zaman aşımıyla da korunur).
process.on("uncaughtException", (err) => {
  broken = true;
  if (inTx) txLost = true;
  if (pending !== null) reply({ id: pending, ok: false, error: { ...serialize(err), code: "TP_WORKER_CRASH" } });
});
process.on("unhandledRejection", () => {
  broken = true;
});
