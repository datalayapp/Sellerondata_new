import { isInstallTable, isTenantTable } from "./tables.ts";

/**
 * SQL'in dar taraması (gerçek ayrıştırıcı değil): hangi tablolara dokunuyor, her kiracı tablosu geçişi kendi firma
 * kapsamıyla (`<takma ad>.org_id = $org`) sınırlı mı. Amaç kapsamın UNUTULMASINI ve mantık hatasını yakalamak; kabul
 * edilen biçimler bilerek dardır, anlaşılmayan biçim REDDEDİLİR. Ret mesajı ne yazılması gerektiğini söyler.
 *
 * Kabul edilen kapsam: `[t.]org_id = $org` (ya da `==`, `IS`, `$org = [t.]org_id`) yalnız WHERE, JOIN … ON, HAVING
 * ve ON CONFLICT … WHERE içinde, koşulun EN DIŞINDA ve AND ile bağlı. Aynı derinlikte OR, önünde NOT ya da parantez
 * içinde kalan karşılaştırma sayılmaz. Her kiracı tablosu geçişi (FROM, JOIN, UPDATE, DELETE, alt sorgu) kendi takma
 * adıyla (yoksa tablo adıyla) kapsamlanır; takma adsız `org_id = $org` yalnız tek kaynaklı sorguda geçer.
 * INSERT: sütun listesinde `org_id`, değeri tam olarak `$org`; kiracı tablosunda REPLACE / OR REPLACE yok;
 * `ON CONFLICT … DO UPDATE` yalnız çatışma hedefinde `org_id` varsa ya da `WHERE <t>.org_id = $org`
 * (`excluded.org_id = <t>.org_id`) ile.
 */
export interface SqlScan {
  /** Adı geçen kiracı tabloları (tekrarsız, küçük harf; şema önekliler dahil). */
  tenantTables: string[];
  /** Adı geçen kurulum tabloları (`settings`, `orgs`). */
  installTables: string[];
  /** FROM/JOIN/INTO/UPDATE ardındaki, hiçbir listede olmayan tablo adları (CTE ve tablo işlevleri hariç). */
  unknownTables: string[];
  hasOrgParam: boolean;
  /** Birden çok ifade (`;` ardından metin). */
  multiple: boolean;
  /** Kapsam sorunları (kiracı tablosu yoksa boş). */
  problems: string[];
  /**
   * Anlaşılamayan biçim (ör. tek tırnaklı tablo adı `FROM 'languages'`, parantezli birleşim): kiracı tablosu adı
   * görülmese de RET (tablo adı tarayıcının göremeyeceği biçimde yazılmış olabilir).
   */
  unparsed: string[];
}

/** Yorumları ve metin değişmezlerini atar, tırnaklı adları düz ada çevirir. */
export function normalizeSql(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e;
      out += " ";
    } else if (c === "/" && n === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      out += " ";
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      out += " '' ";
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const e = sql.indexOf(close, i + 1);
      out += ` ${e < 0 ? sql.slice(i + 1) : sql.slice(i + 1, e)} `;
      i = e < 0 ? sql.length : e + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- belirteçler ve parantez ağacı

type Tok = { t: "id" | "param" | "num" | "str" | "op"; v: string; u: string };
type Group = { t: "group"; items: Node[] };
type Node = Tok | Group;

const TOKEN =
  /\s+|(\$[A-Za-z_]\w*|\?\d*|:[A-Za-z_]\w*|@[A-Za-z_]\w*)|([A-Za-z_][\w$]*)|(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|('')|(==|!=|<>|<=|>=|\|\||<<|>>|->>|->|[-+*/%=<>&|~(),.;])|(.)/gy;

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(s); m && m[0] !== ""; m = TOKEN.exec(s)) {
    const v = m[0];
    if (m[1]) out.push({ t: "param", v, u: v.toLowerCase() });
    else if (m[2]) out.push({ t: "id", v, u: v.toUpperCase() });
    else if (m[3]) out.push({ t: "num", v, u: v });
    else if (m[4]) out.push({ t: "str", v, u: v });
    else if (m[5] || m[6]) out.push({ t: "op", v, u: v });
  }
  return out;
}

function tree(toks: Tok[]): { items: Node[]; balanced: boolean } {
  const stack: Node[][] = [[]];
  for (const k of toks) {
    if (k.t === "op" && k.v === "(") stack.push([]);
    else if (k.t === "op" && k.v === ")") {
      if (stack.length === 1) return { items: stack[0]!, balanced: false };
      const items = stack.pop()!;
      stack[stack.length - 1]!.push({ t: "group", items });
    } else stack[stack.length - 1]!.push(k);
  }
  return { items: stack[0]!, balanced: stack.length === 1 };
}

const isGroup = (n: Node | undefined): n is Group => n?.t === "group";
const isTok = (n: Node | undefined): n is Tok => !!n && n.t !== "group";
const kw = (n: Node | undefined, ...words: string[]): boolean => isTok(n) && n.t === "id" && words.includes(n.u);
const op = (n: Node | undefined, ...ops: string[]): boolean => isTok(n) && n.t === "op" && ops.includes(n.v);
const ident = (n: Node | undefined): n is Tok => isTok(n) && n.t === "id";
const isOrgParam = (n: Node | undefined): boolean => isTok(n) && n.t === "param" && n.u === "$org";
const startsQuery = (g: Group) => kw(g.items[0], "SELECT", "WITH", "VALUES");

/** `from`'dan sonra ilk anahtar kelimenin yeri; yoksa `items.length`. */
function indexKw(items: Node[], from: number, words: string[]): number {
  for (let i = from; i < items.length; i++) if (kw(items[i], ...words)) return i;
  return items.length;
}

function splitTop(items: Node[], at: (n: Node) => boolean): Node[][] {
  const out: Node[][] = [[]];
  for (const n of items) {
    if (at(n)) out.push([]);
    else out[out.length - 1]!.push(n);
  }
  return out;
}

const SQL_FUNCS = /^(json_each|json_tree|pragma_\w+|generate_series)$/i;
const SYSTEM_TABLES = /^(sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_sequence)$/i;

// ---------------------------------------------------------------- çözümleme

interface Ref {
  name: string;
  alias: string | null;
  schema: string | null;
}

interface Ctx {
  problems: string[];
  unknown: Set<string>;
  ctes: Set<string>;
  consumed: Set<Tok>;
}

const CLAUSES = ["WHERE", "GROUP", "HAVING", "WINDOW", "ORDER", "LIMIT", "RETURNING"];
const JOIN_MODS = ["LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL", "OUTER"];
const FROM_STOP = ["ON", "USING", "INDEXED", "NOT", "WHERE", "SET", "JOIN", "SELECT", "VALUES", "DEFAULT", "WITH", "UNION", "INTERSECT", "EXCEPT", ...JOIN_MODS, ...CLAUSES];

type Cmp = { kind: "org" | "excluded"; qual: string | null; other?: string | null };

/**
 * Koşul bölgesi. `only`: bu bölgedeki kapsam karşılaştırmasının sayıldığı tablolar (takma ad ya da ad); null = hepsi.
 * Dış birleşimde korunan taraf ON ile süzülmez (eşleşmeyen satırı yine gelir): LEFT JOIN'in ON'u yalnız sağdaki
 * (birleşen) tabloyu, RIGHT JOIN'inki yalnız soldakileri kapsamlar; FULL JOIN'inki hiçbirini. WHERE herkesi.
 */
type Cond = { region: Node[]; only: Set<string> | null };

/**
 * Koşul bölgesindeki (tek derinlik) geçerli kapsam karşılaştırmaları. Geçersizlerin nedeni `bad`'e yazılır.
 * Biçimler: `[q.]org_id (=|==|IS) $org`, `$org (=|==) [q.]org_id`, `excluded.org_id = [q.]org_id` (ve tersi).
 */
function comparisons(region: Node[]): { ok: Cmp[]; bad: string[] } {
  const ok: Cmp[] = [];
  const bad: string[] = [];
  const hasOr = region.some((n) => kw(n, "OR"));
  const col = (i: number): { qual: string | null; end: number } | null => {
    if (ident(region[i]) && op(region[i + 1], ".") && ident(region[i + 2]) && (region[i + 2] as Tok).u === "ORG_ID") return { qual: (region[i] as Tok).v.toLowerCase(), end: i + 2 };
    if (ident(region[i]) && (region[i] as Tok).u === "ORG_ID" && !op(region[i - 1], ".")) return { qual: null, end: i };
    return null;
  };
  for (let i = 0; i < region.length; i++) {
    let found: { start: number; end: number; cmp: Cmp } | null = null;
    const left = col(i);
    if (left) {
      const o = region[left.end + 1];
      if ((op(o, "=", "==") || (kw(o, "IS") && !kw(region[left.end + 2], "NOT"))) && isOrgParam(region[left.end + 2])) {
        found = { start: i, end: left.end + 2, cmp: { kind: "org", qual: left.qual } };
      } else if (op(o, "=", "==")) {
        const right = col(left.end + 2);
        if (right && (left.qual === "excluded") !== (right.qual === "excluded")) {
          const target = left.qual === "excluded" ? right.qual : left.qual;
          found = { start: i, end: right.end, cmp: { kind: "excluded", qual: target } };
        }
      }
    } else if (isOrgParam(region[i]) && op(region[i + 1], "=", "==")) {
      const right = col(i + 2);
      if (right) found = { start: i, end: right.end, cmp: { kind: "org", qual: right.qual } };
    }
    if (!found) continue;
    const prev = region[found.start - 1];
    const next = region[found.end + 1];
    if (kw(prev, "NOT")) bad.push('kapsam karşılaştırmasının önünde NOT olamaz ("NOT org_id = $org" başka firmaları seçer)');
    else if (hasOr) bad.push('koşulda en dışta OR var; kapsamı "org_id = $org AND (… OR …)" biçiminde yazın');
    else if ((prev && !kw(prev, "AND")) || (next && !kw(next, "AND"))) bad.push('kapsam karşılaştırması koşulun en dışında, AND ile bağlı olmalı (parantez dışında: "… AND org_id = $org")');
    else ok.push(found.cmp);
    i = found.end;
  }
  return { ok, bad };
}

/** Bölgede (tek derinlik ya da iç içe) kapsam karşılaştırmasına benzeyen bir şey var mı (yanlış yerde yazılmışı bulmak için). */
function mentionsScope(items: Node[]): boolean {
  if (items.some((n) => isGroup(n) && mentionsScope(n.items))) return true;
  const r = comparisons(items);
  return r.ok.length + r.bad.length > 0;
}

/** Tablo adı (`ad` ya da `şema.ad`) ve takma ad; `k` ilk belirteç. Dönen `next` sonraki belirteç. */
function readTable(items: Node[], k: number, ctx: Ctx): { ref: Ref; next: number } | null {
  if (!ident(items[k])) return null;
  let schema: string | null = null;
  let nameTok = items[k] as Tok;
  let i = k + 1;
  if (op(items[i], ".") && ident(items[i + 1])) {
    schema = nameTok.v.toLowerCase();
    nameTok = items[i + 1] as Tok;
    i += 2;
  }
  ctx.consumed.add(nameTok);
  let alias: string | null = null;
  if (kw(items[i], "AS") && ident(items[i + 1])) {
    alias = (items[i + 1] as Tok).v.toLowerCase();
    i += 2;
  } else if (ident(items[i]) && !kw(items[i], ...FROM_STOP)) {
    alias = (items[i] as Tok).v.toLowerCase();
    i += 1;
  }
  return { ref: { name: nameTok.v.toLowerCase(), alias, schema }, next: i };
}

function classify(ref: Ref, ctx: Ctx): void {
  const n = ref.name;
  if (isTenantTable(n) || isInstallTable(n) || ctx.ctes.has(n) || SYSTEM_TABLES.test(n)) return;
  ctx.unknown.add(n);
}

/** FROM bölgesi: kaynaklar ve JOIN … ON koşulları (birleşim türüyle). */
function parseFrom(region: Node[], ctx: Ctx): { refs: Ref[]; conds: Cond[]; subqueries: number } {
  const refs: Ref[] = [];
  const conds: Cond[] = [];
  let subqueries = 0;
  const segments: { items: Node[]; join: string }[] = [{ items: [], join: "" }];
  for (const n of region) {
    if (op(n, ",")) segments.push({ items: [], join: "CROSS" });
    else if (kw(n, "JOIN")) {
      const cur = segments[segments.length - 1]!.items;
      const mods: string[] = [];
      while (kw(cur[cur.length - 1], ...JOIN_MODS)) mods.unshift((cur.pop() as Tok).u);
      segments.push({ items: [], join: mods.find((m) => m === "LEFT" || m === "RIGHT" || m === "FULL") ?? "INNER" });
    } else segments[segments.length - 1]!.items.push(n);
  }
  const keysBefore: string[] = [];
  for (const { items: s, join } of segments) {
    if (!s.length) continue;
    let i = 0;
    let key: string | null = null;
    if (isGroup(s[0])) {
      if (!startsQuery(s[0])) {
        ctx.problems.push("FROM içinde parantezli birleşim desteklenmez; JOIN'leri parantezsiz yazın");
        continue;
      }
      subqueries++;
      i = 1;
      if (kw(s[i], "AS")) i++;
      if (ident(s[i]) && !kw(s[i], ...FROM_STOP)) i++;
    } else if (ident(s[0]) && isGroup(s[1])) {
      // tablo işlevi: json_each(…)
      if (!SQL_FUNCS.test((s[0] as Tok).v)) ctx.unknown.add((s[0] as Tok).v.toLowerCase());
      i = 2;
      if (kw(s[i], "AS")) i++;
      if (ident(s[i]) && !kw(s[i], ...FROM_STOP)) i++;
    } else {
      const t = readTable(s, 0, ctx);
      if (!t) {
        ctx.problems.push("FROM bölümü anlaşılamadı (tablo adı tırnaksız ya da çift tırnaklı yazılır)");
        continue;
      }
      classify(t.ref, ctx);
      refs.push(t.ref);
      key = t.ref.alias ?? t.ref.name;
      i = t.next;
    }
    if (kw(s[i], "ON")) {
      const only = join === "LEFT" ? new Set(key ? [key] : []) : join === "RIGHT" ? new Set(keysBefore) : join === "FULL" ? new Set<string>() : null;
      conds.push({ region: s.slice(i + 1), only });
    } else if (kw(s[i], "USING") && isGroup(s[i + 1]) && i + 2 === s.length) {
      // USING kapsam taşımaz
    } else if (i < s.length) ctx.problems.push("FROM bölümü anlaşılamadı (yalnız `tablo [AS] ad [ON …]` biçimi)");
    if (key) keysBefore.push(key);
  }
  return { refs, conds, subqueries };
}

/** Bir kapsamdaki kiracı tablosu geçişlerinin her biri kendi karşılaştırmasıyla sınırlı mı. */
function bind(refs: Ref[], subqueries: number, condList: Cond[], elsewhere: Node[][], ctx: Ctx): void {
  const ok: Cmp[] = [];
  /** Dış birleşimin ON'unda korunan taraf için yazılmış (sayılmayan) karşılaştırmalar. */
  const preserved = new Set<string>();
  for (const c of condList) {
    const r = comparisons(c.region);
    for (const x of r.ok.filter((y) => y.kind === "org")) {
      if (!c.only || (x.qual !== null && c.only.has(x.qual))) ok.push(x);
      else if (x.qual !== null) preserved.add(x.qual);
    }
    ctx.problems.push(...r.bad);
  }
  const conds = condList.map((c) => c.region);
  const tenant = refs.filter((r) => isTenantTable(r.name));
  const single = tenant.length === 1 && refs.length === 1 && subqueries === 0;
  for (const r of tenant) {
    const key = r.alias ?? r.name;
    const label = r.alias ? `${r.name} (${r.alias})` : r.name;
    if (r.schema) {
      ctx.problems.push(`${label}: şema öneki (${r.schema}.) yazmayın`);
      continue;
    }
    if (ok.some((c) => c.qual === key || (c.qual === null && single))) continue;
    const nested = conds.find((c) => c.some((n) => isGroup(n) && !startsQuery(n) && mentionsScope(n.items)));
    if (preserved.has(key)) {
      ctx.problems.push(`${label}: dış birleşimde korunan tablonun kapsamı ON içinde sayılmaz (eşleşmeyen satırları yine gelir); "${key}.org_id = $org" WHERE içinde yazılır`);
    } else if (nested) {
      ctx.problems.push(
        nested.some((n) => kw(n, "OR"))
          ? 'koşulda en dışta OR var; kapsamı "org_id = $org AND (… OR …)" biçiminde yazın'
          : `${label}: kapsam karşılaştırması koşulun en dışında, AND ile bağlı olmalı (parantez içindeki sayılmaz): "… AND ${key}.org_id = $org"`,
      );
    } else if (ok.some((c) => c.qual === null)) ctx.problems.push(`${label}: çok kaynaklı sorguda kapsamı takma adla yazın: "${key}.org_id = $org"`);
    else if (elsewhere.some(mentionsScope)) ctx.problems.push(`${label}: "org_id = $org" yalnız WHERE ya da JOIN … ON içinde sayılır (SELECT listesi, HAVING, ORDER BY sayılmaz)`);
    else ctx.problems.push(`${label} için firma kapsamı yok: "${key}.org_id = $org" ekleyin (WHERE ya da JOIN … ON içinde, AND ile)`);
  }
}

/** Düz SELECT (UNION parçası). `items[0]` SELECT ya da VALUES. Dönen: SELECT listesi (INSERT … SELECT denetimi için). */
function selectScope(items: Node[], ctx: Ctx): Node[] | null {
  if (kw(items[0], "VALUES")) return null;
  const fromI = indexKw(items, 1, ["FROM"]);
  const selectList = items.slice(1, fromI);
  if (fromI === items.length) return selectList;
  const fromEnd = indexKw(items, fromI + 1, CLAUSES);
  const from = parseFrom(items.slice(fromI + 1, fromEnd), ctx);
  const region = (word: string) => {
    const i = indexKw(items, fromEnd, [word]);
    return i < items.length ? items.slice(i + 1, indexKw(items, i + 1, CLAUSES.filter((c) => c !== word))) : [];
  };
  const where = region("WHERE");
  // HAVING kapsam yeri değildir: gruplama başka firmanın satırlarını da toplar, HAVING yalnız grubu süzer.
  const having = region("HAVING");
  const order = region("ORDER");
  bind(from.refs, from.subqueries, [...from.conds, { region: where, only: null }], [selectList, having, order], ctx);
  return selectList;
}

function selectCompound(items: Node[], ctx: Ctx): Node[] | null {
  const parts = splitTop(items, (n) => kw(n, "UNION", "INTERSECT", "EXCEPT"));
  let first: Node[] | null = null;
  parts.forEach((p, i) => {
    const body = kw(p[0], "ALL") ? p.slice(1) : p;
    const list = selectScope(body, ctx);
    if (i === 0) first = list;
  });
  return parts.length === 1 ? first : null;
}

/** SET bölgesinde `org_id =` ataması. */
function assignsOrg(set: Node[]): boolean {
  return splitTop(set, (n) => op(n, ",")).some((a) => {
    const i = ident(a[0]) && op(a[1], ".") ? 2 : 0;
    return ident(a[i]) && a[i]!.u === "ORG_ID" && op(a[i + 1], "=");
  });
}

function updateScope(items: Node[], ctx: Ctx): void {
  let i = 1;
  let replace = false;
  if (kw(items[1], "OR")) {
    replace = kw(items[2], "REPLACE");
    i = 3;
  }
  const t = readTable(items, i, ctx);
  if (!t) return void ctx.problems.push("UPDATE anlaşılamadı");
  classify(t.ref, ctx);
  const tenant = isTenantTable(t.ref.name);
  if (tenant && replace) ctx.problems.push(`UPDATE OR REPLACE kiracı tablosunda (${t.ref.name}) yasak: çatışan satırı (başka firmanınki olabilir) siler`);
  const setI = indexKw(items, t.next, ["SET"]);
  const setEnd = indexKw(items, setI + 1, ["FROM", "WHERE", "RETURNING"]);
  if (assignsOrg(items.slice(setI + 1, setEnd))) ctx.problems.push("org_id değiştirilemez");
  let refs = [t.ref];
  let conds: Cond[] = [];
  let subqueries = 0;
  let k = setEnd;
  if (kw(items[k], "FROM")) {
    const e = indexKw(items, k + 1, ["WHERE", "RETURNING"]);
    const f = parseFrom(items.slice(k + 1, e), ctx);
    refs = [...refs, ...f.refs];
    conds = f.conds;
    subqueries = f.subqueries;
    k = e;
  }
  const where = kw(items[k], "WHERE") ? items.slice(k + 1, indexKw(items, k + 1, ["RETURNING"])) : [];
  bind(refs, subqueries, [...conds, { region: where, only: null }], [items.slice(setI + 1, setEnd)], ctx);
}

function deleteScope(items: Node[], ctx: Ctx): void {
  if (!kw(items[1], "FROM")) return void ctx.problems.push("DELETE anlaşılamadı");
  const t = readTable(items, 2, ctx);
  if (!t) return void ctx.problems.push("DELETE anlaşılamadı");
  classify(t.ref, ctx);
  const w = indexKw(items, t.next, ["WHERE"]);
  const where = w < items.length ? items.slice(w + 1, indexKw(items, w + 1, ["RETURNING", "ORDER", "LIMIT"])) : [];
  bind([t.ref], 0, [{ region: where, only: null }], [], ctx);
}

function insertScope(items: Node[], ctx: Ctx): void {
  let i = 1;
  let replace = kw(items[0], "REPLACE");
  if (!replace && kw(items[1], "OR")) {
    replace = kw(items[2], "REPLACE");
    i = 3;
  }
  if (!kw(items[i], "INTO")) return void ctx.problems.push("INSERT anlaşılamadı");
  const t = readTable(items, i + 1, ctx);
  if (!t) return void ctx.problems.push("INSERT anlaşılamadı");
  classify(t.ref, ctx);
  const tenant = isTenantTable(t.ref.name);
  let k = t.next;
  const cols = isGroup(items[k]) ? splitTop((items[k] as Group).items, (n) => op(n, ",")).map((c) => (c.length === 1 && ident(c[0]) ? c[0].v.toLowerCase() : "?")) : null;
  if (cols) k++;
  const orgPos = cols?.indexOf("org_id") ?? -1;
  if (tenant) {
    if (t.ref.schema) ctx.problems.push(`${t.ref.name}: şema öneki (${t.ref.schema}.) yazmayın`);
    if (replace) ctx.problems.push(`REPLACE / INSERT OR REPLACE kiracı tablosunda (${t.ref.name}) yasak: çatışan satırı (başka firmanınki olabilir) silip bu firma adına yazar; "ON CONFLICT(…) DO UPDATE … WHERE ${t.ref.alias ?? t.ref.name}.org_id = $org" kullanın`);
    if (orgPos < 0) ctx.problems.push(`INSERT INTO ${t.ref.name}: sütun listesinde org_id yok ("(org_id, …) VALUES ($org, …)")`);
  }
  const conflictI = (() => {
    for (let j = k; j < items.length; j++) if (kw(items[j], "ON") && kw(items[j + 1], "CONFLICT")) return j;
    return indexKw(items, k, ["RETURNING"]);
  })();
  const body = items.slice(k, conflictI);
  const exact = (item: Node[] | undefined) => !!item && item.length === 1 && isOrgParam(item[0]);
  const valueMsg = `INSERT INTO ${t.ref.name}: org_id değeri tam olarak $org olmalı`;
  if (kw(body[0], "VALUES")) {
    for (const g of splitTop(body.slice(1), (n) => op(n, ","))) {
      if (g.length !== 1 || !isGroup(g[0])) {
        if (tenant) ctx.problems.push("VALUES anlaşılamadı");
        continue;
      }
      if (tenant && orgPos >= 0 && !exact(splitTop(g[0].items, (n) => op(n, ","))[orgPos])) ctx.problems.push(valueMsg);
    }
  } else if (kw(body[0], "SELECT", "WITH")) {
    const list = analyzeStatement(body, ctx, false);
    if (tenant && orgPos >= 0) {
      if (!list) ctx.problems.push(`INSERT INTO ${t.ref.name} … SELECT: yalnız düz SELECT (WITH ve UNION olmadan)`);
      else if (!exact(splitTop(list, (n) => op(n, ","))[orgPos])) ctx.problems.push(valueMsg);
    }
  } else if (tenant) ctx.problems.push(`INSERT INTO ${t.ref.name}: VALUES ya da SELECT gerekli`);

  // ON CONFLICT … DO UPDATE: çatışan satır başka firmanın olabilir.
  for (let j = conflictI; j < items.length; j++) {
    if (!(kw(items[j], "ON") && kw(items[j + 1], "CONFLICT"))) continue;
    let c = j + 2;
    const target = isGroup(items[c]) ? (items[c] as Group).items : null;
    if (target) c++;
    // Kısmi dizin koşulu (`ON CONFLICT(…) WHERE … DO …`) atlanır.
    if (kw(items[c], "WHERE")) c = indexKw(items, c + 1, ["DO"]);
    if (!kw(items[c], "DO")) {
      if (tenant) ctx.problems.push("ON CONFLICT anlaşılamadı");
      continue;
    }
    if (kw(items[c + 1], "NOTHING")) continue;
    if (!(kw(items[c + 1], "UPDATE") && kw(items[c + 2], "SET"))) {
      ctx.problems.push("ON CONFLICT anlaşılamadı");
      continue;
    }
    const setStart = c + 3;
    let end = setStart;
    while (end < items.length && !kw(items[end], "WHERE", "RETURNING") && !(kw(items[end], "ON") && kw(items[end + 1], "CONFLICT"))) end++;
    if (assignsOrg(items.slice(setStart, end))) ctx.problems.push("org_id değiştirilemez");
    let where: Node[] = [];
    if (kw(items[end], "WHERE")) {
      let e = end + 1;
      while (e < items.length && !kw(items[e], "RETURNING") && !(kw(items[e], "ON") && kw(items[e + 1], "CONFLICT"))) e++;
      where = items.slice(end + 1, e);
    }
    if (!tenant) continue;
    const r = comparisons(where);
    ctx.problems.push(...r.bad);
    const keys = new Set([t.ref.name, t.ref.alias, null]);
    const targetHasOrg = !!target && target.some((n) => ident(n) && n.u === "ORG_ID");
    if (!targetHasOrg && !r.ok.some((x) => keys.has(x.qual))) {
      const key = t.ref.alias ?? t.ref.name;
      ctx.problems.push(`ON CONFLICT … DO UPDATE kiracı tablosunda (${t.ref.name}) başka firmanın satırını güncelleyebilir: çatışma hedefine org_id koyun ya da "DO UPDATE SET … WHERE ${key}.org_id = $org" yazın`);
    }
  }
}

/** Bir ifade (ya da alt sorgu): WITH, SELECT/VALUES, INSERT, UPDATE, DELETE. Düz SELECT'in listesini döndürür. */
function analyzeStatement(items: Node[], ctx: Ctx, visit = true): Node[] | null {
  let i = 0;
  if (kw(items[0], "WITH")) {
    i = kw(items[1], "RECURSIVE") ? 2 : 1;
    while (ident(items[i])) {
      ctx.ctes.add((items[i] as Tok).v.toLowerCase());
      i++;
      if (isGroup(items[i]) && !kw(items[i + 1], "AS")) break;
      if (isGroup(items[i])) i++;
      if (!kw(items[i], "AS")) break;
      i++;
      if (kw(items[i], "NOT")) i++;
      if (kw(items[i], "MATERIALIZED")) i++;
      if (!isGroup(items[i])) break;
      i++;
      if (op(items[i], ",")) i++;
      else break;
    }
  }
  const rest = items.slice(i);
  let list: Node[] | null = null;
  if (kw(rest[0], "SELECT", "VALUES")) {
    const l = selectCompound(rest, ctx);
    list = i === 0 ? l : null;
  }
  else if (kw(rest[0], "INSERT", "REPLACE")) insertScope(rest, ctx);
  else if (kw(rest[0], "UPDATE")) updateScope(rest, ctx);
  else if (kw(rest[0], "DELETE")) deleteScope(rest, ctx);
  if (visit) visitGroups(items, ctx);
  return list;
}

function visitGroups(items: Node[], ctx: Ctx): void {
  for (const n of items) {
    if (!isGroup(n)) continue;
    if (startsQuery(n)) analyzeStatement(n.items, ctx);
    else visitGroups(n.items, ctx);
  }
}

/** Ağaçtaki bütün belirteçler; `prev`/`next` aynı derinlikte. */
function* walk(items: Node[]): Generator<{ tok: Tok; prev: Node | undefined; next: Node | undefined }> {
  for (let i = 0; i < items.length; i++) {
    const n = items[i]!;
    if (isGroup(n)) yield* walk(n.items);
    else yield { tok: n, prev: items[i - 1], next: items[i + 1] };
  }
}

const cache = new Map<string, SqlScan>();
const UNPARSED = /anlaşılamadı|dengesiz|çözümlenemedi|parantezli birleşim/;

export function scanSql(sql: string): SqlScan {
  const hit = cache.get(sql);
  if (hit) return hit;
  const { items, balanced } = tree(tokenize(normalizeSql(sql)));
  const statements = splitTop(items, (n) => op(n, ";")).filter((s) => s.length);
  const tenant = new Set<string>();
  const install = new Set<string>();
  let hasOrgParam = false;
  for (const { tok } of walk(items)) {
    if (tok.t === "param" && tok.u === "$org") hasOrgParam = true;
    if (tok.t !== "id") continue;
    const n = tok.v.toLowerCase();
    if (isTenantTable(n)) tenant.add(n);
    else if (isInstallTable(n)) install.add(n);
  }
  const ctx: Ctx = { problems: [], unknown: new Set(), ctes: new Set(), consumed: new Set() };
  if (!balanced) ctx.problems.push("parantezler dengesiz");
  try {
    for (const s of statements) analyzeStatement(s, ctx);
    // Tablo konumu dışında (ya da anlaşılmayan bir ifadede) geçen kiracı tablosu adı: şüphede ret.
    for (const { tok, next } of walk(items)) {
      if (tok.t === "id" && isTenantTable(tok.v) && !ctx.consumed.has(tok) && !op(next, ".")) {
        ctx.problems.push(`kiracı tablosu adı tanınan bir tablo konumunda değil: ${tok.v.toLowerCase()} (FROM/JOIN/UPDATE/DELETE FROM/INSERT INTO ardında yazın)`);
      }
    }
  } catch (err) {
    ctx.problems.push(`SQL çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scan: SqlScan = {
    tenantTables: [...tenant],
    installTables: [...install],
    unknownTables: [...ctx.unknown],
    hasOrgParam,
    multiple: statements.length > 1,
    problems: [...new Set(ctx.problems)],
    unparsed: [...new Set(ctx.problems.filter((p) => UNPARSED.test(p)))],
  };
  if (cache.size > 5000) cache.clear();
  cache.set(sql, scan);
  return scan;
}

/** Firma kapsamı sorunları (kiracı tablosuna dokunan ifade için); boş dizi: geçerli. Kurallar dosya başında. */
export function scopeProblems(scan: SqlScan): string[] {
  if (!scan.tenantTables.length) return scan.unparsed;
  if (scan.problems.length) return scan.problems;
  return scan.hasOrgParam ? [] : ["firma kapsamı ($org) yok"];
}

/** Günlük ve sayaç için SQL'in kısa hâli. */
export function sqlHead(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
