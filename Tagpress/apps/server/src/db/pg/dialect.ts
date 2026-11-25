/**
 * SQLite → Postgres mekanik çevirici (plan §2.3). TagPress'in SQL'i tek kaynaktır (SQLite yazımı); köprü her ifadeyi
 * hazırlarken buradan geçirir. Kurallar BİLEREK dardır:
 * - `?` (ve `?NNN`) → `$n`; adlı parametreler (`$org`, `$member`, …) → `$n` (aynı ad aynı numara).
 * - `LIKE` → `ILIKE` (SQLite'ın LIKE'ı ASCII'de harf duyarsız), `==` → `=`, `IFNULL(` → `COALESCE(`.
 * - `BEGIN IMMEDIATE|DEFERRED|EXCLUSIVE` → `BEGIN`.
 * - Kimlik sütunlu tablolara (`IDENTITY_TABLES`) `INSERT` → sonuna `RETURNING id` (`lastInsertRowid`).
 * - Sonuç sütun adları: Postgres tırnaksız adı küçük harfe çevirir (`AS jobId` → `jobid`); metinde geçen karışık harfli
 *   adların eşlemesi döner, köprü sonuç anahtarlarını geri çevirir.
 * Tanınmayan SQLite yapısı (`json_*`, `rowid`, `COLLATE NOCASE`, `PRAGMA`, `sqlite_master`, `group_concat`, tarih
 * işlevleri, `INSERT OR …` …) AÇIK HATA verir (`DialectError`): o ifade `dialectSql(db, { sqlite, pg })` ile ikiye ayrılır.
 * Metin değişmezleri, tırnaklı adlar ve yorumlar olduğu gibi kalır.
 */

/** `lastInsertRowid` gereken (SQLite'ta AUTOINCREMENT, Postgres'te kimlik sütunlu) tablolar. */
export const IDENTITY_TABLES = ["job_log", "design_session_entries", "adjust_log", "design_session_turns", "profile_revisions"] as const;
const IDENTITY = new Set<string>(IDENTITY_TABLES);

/** Çevrilmiş ifadedeki `$n`'nin kaynağı: `pos` = kaçıncı `?` (0'dan), `named` = adlı parametre (öneksiz ad). */
export type ParamSlot = { kind: "pos"; index: number } | { kind: "named"; name: string };

export interface PgSql {
  /** Postgres metni. */
  text: string;
  /** `$1…$n` sırasıyla kaynağı. */
  slots: ParamSlot[];
  /** `?` sayısı. */
  positional: number;
  /** Metindeki adlı parametreler (öneksiz). */
  named: string[];
  /** Küçük harf sütun adı → metindeki yazımı (yalnız karışık harfli adlar). */
  rename: Map<string, string>;
  /** `RETURNING id` eklendi (`run()` `lastInsertRowid`'i buradan okur). */
  returnsId: boolean;
  /**
   * `RETURNING id` eklenmemiş metin. Bakım bağlantısı bunu kullanır: RETURNING, RLS'de yeni satıra SELECT ilkesi ister;
   * kuyruk kapsamının yalnız ekleme ilkesi olan tablolarında (ör. `design_session_entries`) ekleme reddedilirdi.
   */
  plainText: string;
  /**
   * `INSERT … ON CONFLICT … DO UPDATE … WHERE <t>.org_id = $org`: SQLite'ta çatışan satır başka firmanınsa güncelleme
   * atlanır (0 değişiklik); Postgres RLS aynı durumda hata verir (42501, UPDATE ilkesinin USING'i). Köprü bu hatayı
   * SQLite'taki gibi 0 değişiklik sayar (ifade zaten geri alınmıştır).
   */
  upsertOrgGuard: boolean;
}

export class DialectError extends Error {
  constructor(
    readonly sql: string,
    readonly problems: string[],
  ) {
    super(`Postgres'e çevrilemeyen SQLite yapısı: ${problems.join("; ")} — dialectSql(db, { sqlite, pg }) ile iki yazım verin: ${head(sql)}`);
    this.name = "DialectError";
  }
}

/** SQLite'a özgü, mekanik çevrilmeyen işlevler (ardından `(` gelince). */
const SQLITE_FUNCS = new Set([
  "group_concat",
  "instr",
  "strftime",
  "datetime",
  "date",
  "time",
  "julianday",
  "unixepoch",
  "typeof",
  "printf",
  "iif",
  "last_insert_rowid",
  "changes",
  "total_changes",
  "randomblob",
  "zeroblob",
  "hex",
  "unhex",
  "quote",
  "likely",
  "unlikely",
  "likelihood",
  "char",
  "glob",
  "total",
  "sqlite_version",
]);
/** SQLite JSON1 işlevleri (metin üzerinde çalışır; Postgres yazımı `::jsonb` ile ayrı verilir). */
const SQLITE_JSON = new Set([
  "json",
  "json_extract",
  "json_valid",
  "json_each",
  "json_tree",
  "json_type",
  "json_set",
  "json_insert",
  "json_replace",
  "json_remove",
  "json_patch",
  "json_quote",
  "json_array",
  "json_object",
  "json_array_length",
  "json_group_array",
  "json_group_object",
  "json_error_position",
  "jsonb_extract",
]);
/** Adı geçince ret (bağlamdan bağımsız). */
const SQLITE_WORDS = new Set(["rowid", "_rowid_", "oid", "pragma", "sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_sequence", "autoincrement", "glob", "vacuum", "attach", "detach"]);

type Tok = { kind: "word" | "param" | "num" | "op" | "str" | "qid" | "space" | "comment"; text: string };

/** Sözcükler, parametreler, değişmezler; metin değişmezi, tırnaklı ad ve yorum tek parça (içine bakılmaz). */
function lex(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j]!)) j++;
      out.push({ kind: "space", text: sql.slice(i, j) });
      i = j;
    } else if (c === "-" && d === "-") {
      const e = sql.indexOf("\n", i);
      const j = e < 0 ? n : e;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "/" && d === "*") {
      const e = sql.indexOf("*/", i + 2);
      const j = e < 0 ? n : e + 2;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out.push({ kind: "str", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      out.push({ kind: "qid", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === "`" || c === "[") {
      // SQLite'ın öbür tırnaklı ad yazımları Postgres'te yok.
      const close = c === "[" ? "]" : "`";
      const e = sql.indexOf(close, i + 1);
      const j = e < 0 ? n : e + 1;
      out.push({ kind: "qid", text: `"${sql.slice(i + 1, j - 1).replaceAll('"', '""')}"` });
      i = j;
    } else if (c === "$" && d === "$") {
      // Postgres dolar tırnağı ($$…$$): olduğu gibi (yalnız pg yazımında olur).
      const e = sql.indexOf("$$", i + 2);
      const j = e < 0 ? n : e + 2;
      out.push({ kind: "str", text: sql.slice(i, j) });
      i = j;
    } else if (c === "?" || ((c === "$" || c === "@") && d !== undefined && /[A-Za-z_0-9]/.test(d)) || (c === ":" && d !== undefined && /[A-Za-z_]/.test(d) && sql[i - 1] !== ":")) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push({ kind: "param", text: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      out.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && d !== undefined && /[0-9]/.test(d))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j++;
      out.push({ kind: "num", text: sql.slice(i, j) });
      i = j;
    } else {
      const two = sql.slice(i, i + 2);
      const three = sql.slice(i, i + 3);
      const t = three === "->>" ? three : ["==", "!=", "<>", "<=", ">=", "||", "::", "->", "#>", "<<", ">>", "@>", "<@"].includes(two) ? (two === "#>" && sql[i + 2] === ">" ? "#>>" : two) : c;
      out.push({ kind: "op", text: t });
      i += t.length;
    }
  }
  return out;
}

const cache = new Map<string, PgSql>();

/** SQLite yazımını Postgres'e çevirir (sonuç önbellekte). Çevrilemezse `DialectError`. */
export function toPg(sql: string): PgSql {
  const hit = cache.get(sql);
  if (hit) return hit;
  const out = translate(sql);
  if (cache.size > 5000) cache.clear();
  cache.set(sql, out);
  return out;
}

function translate(sql: string): PgSql {
  const toks = lex(sql);
  const problems: string[] = [];
  const slots: ParamSlot[] = [];
  const namedIndex = new Map<string, number>();
  const named: string[] = [];
  const rename = new Map<string, string>();
  let positional = 0;
  let maxNumbered = 0;
  const parts: string[] = [];
  const sig = toks.filter((t) => t.kind !== "space" && t.kind !== "comment");
  const at = (k: number) => sig[k];
  const word = (t: Tok | undefined) => (t?.kind === "word" ? t.text.toLowerCase() : null);

  // İfade başı: BEGIN kipi, INSERT OR, REPLACE INTO.
  const first = word(at(0));
  if (first === "begin" && ["immediate", "deferred", "exclusive"].includes(word(at(1)) ?? "")) {
    return { text: "BEGIN", plainText: "BEGIN", slots: [], positional: 0, named: [], rename, returnsId: false, upsertOrgGuard: false };
  }
  if (first === "replace") problems.push("REPLACE INTO");
  if (first === "insert" && word(at(1)) === "or") problems.push(`INSERT OR ${at(2)?.text ?? ""}`.trim());

  let si = -1; // sig içindeki konum
  for (const t of toks) {
    if (t.kind !== "space" && t.kind !== "comment") si++;
    if (t.kind === "param") {
      const p = t.text;
      if (p === "?") {
        slots.push({ kind: "pos", index: positional++ });
        parts.push(`$${slots.length}`);
      } else if (p.startsWith("?")) {
        const k = Number(p.slice(1));
        if (!Number.isInteger(k) || k < 1) problems.push(`geçersiz parametre ${p}`);
        maxNumbered = Math.max(maxNumbered, k);
        slots.push({ kind: "pos", index: k - 1 });
        parts.push(`$${slots.length}`);
      } else if (p.startsWith("$") && /^\$[A-Za-z_]\w*$/.test(p)) {
        const name = p.slice(1);
        let idx = namedIndex.get(name);
        if (idx === undefined) {
          slots.push({ kind: "named", name });
          idx = slots.length;
          namedIndex.set(name, idx);
          named.push(name);
        }
        parts.push(`$${idx}`);
      } else {
        problems.push(`parametre yazımı ${p} (yalnız ? ve $ad)`);
        parts.push(p);
      }
      continue;
    }
    if (t.kind === "word") {
      const w = t.text.toLowerCase();
      const next = at(si + 1);
      const isCall = next?.kind === "op" && next.text === "(";
      if (SQLITE_WORDS.has(w)) problems.push(w);
      else if (isCall && (SQLITE_FUNCS.has(w) || SQLITE_JSON.has(w))) {
        // `date(` / `time(` / `char(` tür adı da olabilir ama SQLite yazımında hep işlevdir.
        problems.push(`${w}()`);
      }
      if (w === "collate") {
        const c = word(next);
        if (c && c !== "c" && !/^"/.test(next?.text ?? "")) problems.push(`COLLATE ${next?.text}`);
      }
      if (w === "like") {
        parts.push(t.text === "like" ? "ilike" : "ILIKE");
        continue;
      }
      if (w === "ifnull" && isCall) {
        parts.push("COALESCE");
        continue;
      }
      if (/[A-Z]/.test(t.text) && /[a-z]/.test(t.text)) rename.set(w, t.text);
      parts.push(t.text);
      continue;
    }
    if (t.kind === "op" && t.text === "==") {
      parts.push("=");
      continue;
    }
    parts.push(t.text);
  }
  if (maxNumbered && positional) problems.push("? ile ?NNN birlikte");
  if (maxNumbered) positional = maxNumbered;

  let text = parts.join("");
  const plainText = text;
  let returnsId = false;
  if (first === "insert" && word(at(1)) === "into") {
    const table = word(at(2));
    const hasReturning = sig.some((t) => word(t) === "returning");
    if (table && IDENTITY.has(table) && !hasReturning) {
      text = `${text.replace(/[\s;]+$/u, "")} RETURNING id`;
      returnsId = true;
    }
  }
  if (problems.length) throw new DialectError(sql, [...new Set(problems)]);
  return { text, plainText, slots, positional, named, rename, returnsId, upsertOrgGuard: upsertGuard(sig) };
}

/** `INSERT … ON CONFLICT … DO UPDATE … WHERE … org_id = $org …` biçimi mi (yalnız DO UPDATE'ten sonraki WHERE). */
function upsertGuard(sig: Tok[]): boolean {
  const w = (t: Tok | undefined) => (t?.kind === "word" ? t.text.toLowerCase() : "");
  if (w(sig[0]) !== "insert") return false;
  const doIdx = sig.findIndex((t, i) => w(t) === "do" && w(sig[i + 1]) === "update" && sig.slice(0, i).some((x, j) => w(x) === "on" && w(sig[j + 1]) === "conflict"));
  if (doIdx < 0) return false;
  const where = sig.findIndex((t, i) => i > doIdx && w(t) === "where");
  if (where < 0) return false;
  const tail = sig.slice(where);
  return tail.some((t, i) => w(t) === "org_id" && tail[i + 1]?.text === "=" && tail[i + 2]?.kind === "param" && tail[i + 2]!.text.toLowerCase() === "$org");
}

/**
 * Parametresiz çok ifadeli metin (bakım `exec`, göç dışı). Parametre içeremez; geri kalan kurallar aynı. İfadeler `;` ile
 * ayrılır ve tek metin olarak gider (basit sorgu protokolü).
 */
export function toPgScript(sql: string): string {
  const out = toPg(sql);
  if (out.slots.length) throw new DialectError(sql, ["exec parametre almaz"]);
  return out.text;
}

function head(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}
