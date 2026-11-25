#!/usr/bin/env node
// SellerOnData depo denetimi (Mesaj 10, plan §3.7). Bağımlılık yok: yalnız Node yerleşikleri ve salt okunur git.
//
//   node scripts/repo-check.mjs            izlenen + izlenmeyen (yok sayılmayan) bütün dosyalar, çalışma ağacından
//   node scripts/repo-check.mjs --staged   yalnız sahnelenmiş dosyalar, index'teki içerikle (pre-commit kancası)
//   node scripts/repo-check.mjs --json     makine okunur çıktı
//
// Çıktı: `HATA [kural] dosya:satır  açıklama` ya da `UYARI [kural] …`. HATA varsa çıkış kodu 1.
// Kurallar: K1 kontrol-karakteri, K2 gorunmez-karakter, K3 bom, K4 satir-sonu, K5 goc-rls, K6 paket-baglanti,
// K7 paket-kilit, K8 paket-bagimlilik, K9 surum-birligi, K10 belge-yolu (UYARI), K11 uzun-satir (UYARI; K10 ve K11 yalnız
// Markdown belgelerinde, kapsamı config `docs` bloğunda; SONRAKI-OTURUM dahil, ARSIV hariç). Ayarlar ve istisnalar: scripts/repo-check.config.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RULES = {
  K1: 'kontrol-karakteri',
  K2: 'gorunmez-karakter',
  K3: 'bom',
  K4: 'satir-sonu',
  K5: 'goc-rls',
  K6: 'paket-baglanti',
  K7: 'paket-kilit',
  K8: 'paket-bagimlilik',
  K9: 'surum-birligi',
  K10: 'belge-yolu',
  K11: 'uzun-satir',
};
export const HATA = 'HATA';
export const UYARI = 'UYARI';

function finding(level, code, file, line, message) {
  return { level, code, rule: RULES[code], file, line: line || 1, message };
}

// ---------------------------------------------------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------------------------------------------------

const globCache = new Map();
export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; s += '(?:.*/)?'; } else s += '.*';
      } else s += '[^/]*';
    } else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${s}$`);
  globCache.set(glob, re);
  return re;
}
export function matchGlob(file, glob) {
  const target = glob.includes('/') ? file : file.slice(file.lastIndexOf('/') + 1);
  return globToRegExp(glob).test(target);
}

function fileKind(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (/^dockerfile(\..*)?$/i.test(base) && !base.endsWith('.dockerignore')) return 'dockerfile';
  if (file.startsWith('.githooks/')) return 'githooks';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0'); }

// ---------------------------------------------------------------------------------------------------------------------
// K1–K4: metin dosyaları
// ---------------------------------------------------------------------------------------------------------------------

const CONTROL_NAMES = {
  0x00: 'NUL', 0x07: 'zil', 0x08: 'geri silme', 0x0b: 'dikey sekme', 0x0c: 'sayfa sonu', 0x1b: 'ESC', 0x7f: 'DEL',
};
const INVISIBLE_NAMES = {
  0x00ad: 'yumuşak tire', 0x200b: 'sıfır genişlikli boşluk', 0x200c: 'sıfır genişlikli ayırıcı',
  0x200d: 'sıfır genişlikli birleştirici', 0x200e: 'soldan sağa işareti', 0x200f: 'sağdan sola işareti',
  0x2028: 'satır ayırıcı', 0x2029: 'paragraf ayırıcı', 0x202a: 'yön gömme', 0x202b: 'yön gömme', 0x202c: 'yön sonu',
  0x202d: 'yön zorlama', 0x202e: 'yön zorlama (ters)', 0x2060: 'kelime birleştirici', 0x2061: 'görünmez işlem',
  0x2062: 'görünmez çarpı', 0x2063: 'görünmez ayırıcı', 0x2064: 'görünmez artı', 0x2066: 'yön yalıtma',
  0x2067: 'yön yalıtma', 0x2068: 'yön yalıtma', 0x2069: 'yön yalıtma sonu', 0xfeff: 'BOM / sıfır genişlikli bölünmez boşluk',
};
// eslint-disable-next-line no-control-regex -- K1 kuralı tam olarak bu baytları arar.
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// Kod noktaları sayıyla yazılır: kaynakta görünmez karakter ve ters eğik çizgi + u kaçışı yok (araçlar onu çevirebiliyor).
export const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const uEsc = (cp) => '\\' + 'u' + hex(cp, 4);
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_RANGES.map(([x, y]) => (x === y ? uEsc(x) : `${uEsc(x)}-${uEsc(y)}`)).join('')}]`, 'g');
const MAX_PER_FILE = 5;

function isAllowed(file, code, cfg) {
  return (cfg.allow || []).some((a) => a.rules.includes(code) && matchGlob(file, a.glob));
}
export function isExcluded(file, cfg) {
  return (cfg.exclude || []).some((e) => matchGlob(file, e.glob));
}

/**
 * Tek dosyanın K1–K4 denetimi.
 * meta: { index: 'lf'|'crlf'|'mixed'|'none'|'-text'|'', work: …, attr: 'text=auto' … }
 */
export function checkTextFile(file, buf, meta, cfg, ctx = {}) {
  const out = [];
  if (isExcluded(file, cfg)) return out;
  if (meta?.attr && /(^|\s)-text(\s|$)/.test(meta.attr)) return out;
  const kind = fileKind(file);
  if (cfg.binaryExtensions.includes(kind)) return out;
  const known = cfg.textExtensions.includes(kind);
  if (!known && buf.subarray(0, 8000).includes(0)) return out;

  // K1: bayt düzeyinde (UTF-8 çok baytlı dizileri 0x80 altı bayt içermez)
  if (!isAllowed(file, 'K1', cfg)) {
    const bin = buf.toString('latin1');
    CONTROL_RE.lastIndex = 0;
    let m;
    let count = 0;
    let lastLine = 0;
    while ((m = CONTROL_RE.exec(bin))) {
      const line = lineAt(bin, m.index);
      if (line === lastLine) continue;
      lastLine = line;
      count++;
      if (count > MAX_PER_FILE) continue;
      const b = m[0].charCodeAt(0);
      const name = CONTROL_NAMES[b] ? ` (${CONTROL_NAMES[b]})` : '';
      const hint = b === 0x08
        ? 'regex `\\b` istendiyse iki karakter olarak yaz; bayt gerekiyorsa `\\x08`'
        : `görünür kaçışla yaz (\`\\x${hex(b)}\`)`;
      out.push(finding(HATA, 'K1', file, line, `0x${hex(b)}${name} baytı görünmüyor: ${hint}.`));
    }
    if (count > MAX_PER_FILE) {
      out.push(finding(HATA, 'K1', file, lastLine, `ve ${count - MAX_PER_FILE} satır daha (toplam ${count}).`));
    }
  }

  const startsWithBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  // K2
  if (cfg.invisibleExtensions.includes(kind) && !isAllowed(file, 'K2', cfg)) {
    const text = buf.toString('utf8');
    INVISIBLE_RE.lastIndex = 0;
    let m;
    let count = 0;
    let lastLine = 0;
    while ((m = INVISIBLE_RE.exec(text))) {
      const cp = m[0].charCodeAt(0);
      if (cp === 0xfeff && m.index === 0 && (cfg.bomRequired.includes(kind) || cfg.bomForbidden.includes(kind))) {
        continue; // dosya başındaki BOM K3'ün işi
      }
      const line = lineAt(text, m.index);
      if (line === lastLine) continue;
      lastLine = line;
      count++;
      if (count > MAX_PER_FILE) continue;
      out.push(finding(HATA, 'K2', file, line,
        `U+${hex(cp, 4)} (${INVISIBLE_NAMES[cp] || 'görünmez'}) düz yazılmış: \`\\u${hex(cp, 4)}\` kaçışıyla yaz.`));
    }
    if (count > MAX_PER_FILE) {
      out.push(finding(HATA, 'K2', file, lastLine, `ve ${count - MAX_PER_FILE} satır daha (toplam ${count}).`));
    }
  }

  // K3
  if (!isAllowed(file, 'K3', cfg)) {
    if (cfg.bomRequired.includes(kind) && !startsWithBom) {
      out.push(finding(HATA, 'K3', file, 1,
        'BOM yok: Windows PowerShell 5.1 dosyayı ANSI okur, Türkçe harfler bozulur. UTF-8 BOM ile kaydet (bayt olarak EF BB BF).'));
    }
    if (cfg.bomForbidden.includes(kind) && startsWithBom) {
      out.push(finding(HATA, 'K3', file, 1, 'BOM ile başlıyor: ilk 3 baytı (EF BB BF) sil, BOM\'suz UTF-8 kaydet.'));
    }
  }

  // K4
  if (meta && cfg.lfRequired.some((g) => matchGlob(file, g)) && !isAllowed(file, 'K4', cfg)) {
    const idx = meta.index;
    if (idx === 'crlf' || idx === 'mixed') {
      out.push(finding(HATA, 'K4', file, 1,
        `index'te ${idx.toUpperCase()} satır sonu: Linux'ta \`bash\\r\` hatası verir. \`.gitattributes\` içinde \`eol=lf\`, sonra \`git add --renormalize ${file}\`.`));
    } else if (idx === '' && (meta.work === 'crlf' || meta.work === 'mixed')) {
      const normalizes = /\beol=lf\b/.test(meta.attr || '') || ['true', 'input'].includes(ctx.autocrlf);
      if (!normalizes) {
        out.push(finding(HATA, 'K4', file, 1,
          'CRLF satır sonu ve commit\'te LF\'ye çevrilmeyecek: `.gitattributes` içinde `eol=lf` tanımla ya da LF ile kaydet.'));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// K5: göç ayrıştırıcısı
// ---------------------------------------------------------------------------------------------------------------------
// Yöntem: SQL'i belirteçlere ayır (yorumlar, '…', E'…', "…", $etiket$…$etiket$ doğru kapanır), `;` ile ifadelere böl,
// her ifadeden olay çıkar (tablo oluştur/sil, RLS aç/kapat, veri okuyan ya da yazan ifade), olayları sırayla bir durum
// makinesinden geçir. DO bloklarının gövdesi de ayrıştırılır; gövdedeki dize sabitleri (EXECUTE format(...)) ayrıca
// ifade olarak ayrıştırılır, `%I` gibi dinamik adlar bloktaki ARRAY[...] listesine açılır.
//
// Kural: FORCE RLS'li bir tabloya (yazılan ya da okunan) dokunan veri ifadesi, o anda tabloda FORCE kapalı değilse
// HATA. Göç rolü tablo sahibidir; FORCE açıkken firma bağlamı olmadan ilke hiçbir satırı göstermez ve ifade hata
// vermeden boşa çalışır. Temkinli tarafta kalınır: emin olunamayan durum HATA'dır, gerekçeli `-- rls-ok:` ile geçilir.

// Not: bu dosyada `\u` kaçışı kaynakta yazılmaz (araçlar onu gerçek karaktere çevirebiliyor); kod noktaları sayıyla.
const isIdStart = (ch) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch > '\x7f';
const isIdChar = (ch) => isIdStart(ch) || (ch >= '0' && ch <= '9') || ch === '$';
function dollarTag(src, i) { // $$ ya da $etiket$ (etiket harf/_ ile başlar, rakam içerebilir)
  let j = i + 1;
  if (src[j] !== '$') {
    if (!isIdStart(src[j] || '')) return null;
    while (j < src.length && (isIdStart(src[j]) || (src[j] >= '0' && src[j] <= '9'))) j++;
    if (src[j] !== '$') return null;
  }
  return src.slice(i, j + 1);
}

export function lexSql(src, line0 = 1) {
  const toks = [];
  const errors = [];
  const n = src.length;
  let i = 0;
  let line = line0;
  const countNl = (a, b) => {
    let c = 0;
    for (let k = src.indexOf('\n', a); k !== -1 && k < b; k = src.indexOf('\n', k + 1)) c++;
    return c;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line;
      let depth = 1; // Postgres blok yorumları iç içe olabilir
      i += 2;
      while (i < n && depth) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; } else {
          if (src[i] === '\n') line++;
          i++;
        }
      }
      if (depth) errors.push({ line: startLine, what: 'kapanmamış /* yorum */' });
      continue;
    }
    // E'…' (ters eğik çizgi kaçışlı) ve U&'…' / U&"…"
    let escaped = false;
    if ((c === 'e' || c === 'E') && src[i + 1] === "'" && !isIdChar(src[i - 1] || '')) {
      escaped = true;
      i++;
    } else if ((c === 'u' || c === 'U') && src[i + 1] === '&' && (src[i + 2] === "'" || src[i + 2] === '"')
      && !isIdChar(src[i - 1] || '')) {
      i += 2;
    }
    const q = src[i];
    if (q === "'") {
      const startLine = line;
      const start = i + 1;
      let j = start;
      let val = '';
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (escaped && ch === '\\') { val += src.slice(j, j + 2); j += 2; continue; }
        if (ch === "'") {
          if (src[j + 1] === "'") { val += "'"; j += 2; continue; }
          closed = true;
          break;
        }
        val += ch;
        j++;
      }
      if (!closed) { errors.push({ line: startLine, what: "kapanmamış '…' dizesi" }); break; }
      toks.push({ t: 'str', v: val, line: startLine });
      line += countNl(i, j);
      i = j + 1;
      continue;
    }
    if (q === '"') {
      const startLine = line;
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { val += '"'; j += 2; continue; }
          closed = true;
          break;
        }
        val += src[j];
        j++;
      }
      if (!closed) { errors.push({ line: startLine, what: 'kapanmamış "…" adı' }); break; }
      toks.push({ t: 'qid', v: val, line: startLine });
      line += countNl(i, j);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = dollarTag(src, i);
      if (tag) {
        const start = i + tag.length;
        const end = src.indexOf(tag, start);
        if (end < 0) { errors.push({ line, what: `kapanmamış ${tag} … ${tag} bloğu` }); break; }
        toks.push({ t: 'dollar', v: src.slice(start, end), line, tag });
        line += countNl(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
      let j = i + 1;
      while (j < n && /[0-9]/.test(src[j])) j++;
      toks.push({ t: j > i + 1 ? 'param' : 'op', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      toks.push({ t: 'word', v: src.slice(i, j).toLowerCase(), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === ';') { toks.push({ t: 'semi', v: ';', line }); i++; continue; }
    toks.push({ t: 'op', v: c, line });
    i++;
  }
  return { toks, errors };
}

function splitStatements(toks) {
  const out = [];
  let cur = [];
  for (const tk of toks) {
    if (tk.t === 'semi') { if (cur.length) out.push(cur); cur = []; } else cur.push(tk);
  }
  if (cur.length) out.push(cur);
  return out;
}

const isWord = (tk, v) => tk && tk.t === 'word' && (v === undefined || tk.v === v);
const isOp = (tk, v) => tk && tk.t === 'op' && tk.v === v;

// Ad başlangıcı olamayan anahtar sözcükler (tablo konumunda görülünce tablo listesi biter).
const RESERVED = new Set([
  'select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'join', 'inner',
  'left', 'right', 'full', 'cross', 'natural', 'outer', 'on', 'using', 'set', 'values', 'returning', 'window', 'as',
  'with', 'and', 'or', 'not', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'default', 'into', 'for',
  'fetch', 'all', 'distinct', 'array', 'exists', 'in', 'is', 'like', 'between', 'by', 'update', 'delete', 'insert',
  'merge', 'tablesample', 'conflict', 'do', 'loop',
]);
// Önünde bunlar varsa UPDATE/DELETE/INSERT bir veri ifadesi değildir (ON UPDATE CASCADE, FOR UPDATE, GRANT UPDATE,
// AFTER UPDATE OR DELETE, ON CONFLICT DO UPDATE …).
const NON_DML_PREV = new Set(['on', 'for', 'after', 'before', 'of', 'or', ',', 'grant', 'revoke', 'do', 'instead', 'also', 'key', 'each']);
const NON_SELECT_PREV = new Set(['grant', 'revoke', ',', 'for']);
const CLAUSE_END = new Set(['where', 'group', 'having', 'order', 'limit', 'offset', 'window', 'returning', 'set', 'union', 'except', 'intersect', 'values', 'fetch']);
// Üst düzeyde veri okumayan/yazmayan ifadeler.
const NON_DATA_TOP = new Set([
  'grant', 'revoke', 'comment', 'lock', 'vacuum', 'analyze', 'analyse', 'reindex', 'cluster', 'notify', 'listen', 'unlisten',
  'discard', 'savepoint', 'release', 'commit', 'rollback', 'begin', 'start', 'end', 'abort', 'truncate', 'copy', 'prepare',
  'deallocate', 'security', 'checkpoint', 'load', 'import',
]);
// DO gövdesinde ifadenin başındaki PL/pgSQL sözcükleri.
const PLPGSQL_PREFIX = new Set(['begin', 'declare', 'loop', 'then', 'else', 'exception', 'end']);

const CATALOG_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

function prevKey(tk) {
  if (!tk) return null;
  if (tk.t === 'word' || tk.t === 'op') return tk.v;
  return tk.t;
}

/** Ad oku: a, "a", a.b, "a"."b", "a".%I, %I.%I … → { parts, dynamic, next } */
function readName(toks, i) {
  const parts = [];
  let dynamic = false;
  let j = i;
  for (;;) {
    const tk = toks[j];
    if (!tk) {
      if (parts.length) { dynamic = true; parts.push('%'); } // "şema". ile bitti: ad birleştirmeyle gelir
      break;
    }
    if (tk.t === 'qid') { parts.push(tk.v); j++; } else if (tk.t === 'word' && !(parts.length === 0 && RESERVED.has(tk.v))) {
      parts.push(tk.v); j++;
    } else if (isOp(tk, '%')) {
      dynamic = true;
      parts.push('%');
      j++;
      if (toks[j] && (toks[j].t === 'word' || toks[j].t === 'num' || toks[j].t === 'param') && toks[j].line === tk.line) j++;
    } else if (tk.t === 'str' || tk.t === 'dollar' || tk.t === 'param') {
      // EXECUTE 'UPDATE ' || quote_ident(t) … : ad dizeden gelir
      dynamic = true;
      parts.push('%');
      j++;
    } else {
      if (parts.length) { dynamic = true; parts.push('%'); } // "şema". sonrası ad yok: ad birleştirmeyle gelir
      break;
    }
    if (isOp(toks[j], '.')) { j++; continue; }
    break;
  }
  return parts.length ? { parts, dynamic, next: j } : null;
}

function tableRef(nameRes, defaultSchema, line, position) {
  // position 'table': a.b.c = katalog.şema.tablo; 'qualified': şema.tablo(.sütun)
  const p = nameRes.parts;
  let schema;
  let table;
  if (position === 'qualified') { schema = p[0]; table = p[1]; } else if (p.length >= 3) { schema = p[p.length - 2]; table = p[p.length - 1]; } else if (p.length === 2) { schema = p[0]; table = p[1]; } else { schema = defaultSchema; table = p[0]; }
  const dynamic = nameRes.dynamic || schema === '%' || table === '%';
  return { schema: schema === '%' ? null : schema, table: table === '%' ? null : table, dynamic, line };
}

function collectCteNames(toks) {
  const names = new Set();
  for (let i = 1; i < toks.length; i++) {
    if (!isWord(toks[i], 'as')) continue;
    let k = i + 1;
    if (isWord(toks[k], 'not')) k++;
    if (isWord(toks[k], 'materialized')) k++;
    if (!isOp(toks[k], '(')) continue;
    let j = i - 1;
    if (isOp(toks[j], ')')) { // name(col, …) AS (
      let depth = 0;
      for (; j >= 0; j--) {
        if (isOp(toks[j], ')')) depth++;
        else if (isOp(toks[j], '(')) { depth--; if (depth === 0) break; }
      }
      j--;
    }
    const nameTok = toks[j];
    const before = toks[j - 1];
    if (nameTok && (nameTok.t === 'word' || nameTok.t === 'qid') && (isWord(before, 'with') || isWord(before, 'recursive') || isOp(before, ','))) {
      names.add(nameTok.v);
    }
  }
  return names;
}

/**
 * Veri ifadesi taraması: yazılan hedefler ve okunan tablolar. Çok satırlı ifade, CTE (WITH … UPDATE), UPDATE … FROM,
 * DELETE … USING, INSERT … SELECT, MERGE … USING, alt sorgular, virgüllü FROM listeleri.
 */
function scanData(toks, ctx) {
  const targets = [];
  const reads = [];
  const ctes = collectCteNames(toks);
  let any = false;
  const frame = (o = {}) => ({ selectish: false, dml: null, fromClause: false, expect: false, ...o });
  const stack = [frame()];
  const addRead = (res, line, position) => {
    const ref = tableRef(res, ctx.defaultSchema, line, position);
    if (!ref.dynamic && res.parts.length === 1 && ctes.has(ref.table)) return;
    if (!ref.dynamic && (CATALOG_SCHEMAS.has(ref.schema) || (res.parts.length === 1 && ref.table.startsWith('pg_')))) return; // sistem kataloğu
    reads.push(ref);
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const pv = prevKey(toks[i - 1]);
    const fr = stack[stack.length - 1];
    if (isOp(tk, '(')) {
      if (fr.expect) { fr.expect = false; stack.push(frame({ selectish: true, fromClause: true, expect: true })); } else stack.push(frame());
      continue;
    }
    if (isOp(tk, ')')) { if (stack.length > 1) stack.pop(); continue; }
    if (isOp(tk, ',')) { if (fr.fromClause) fr.expect = true; continue; }

    const nameStart = tk.t === 'qid' || (tk.t === 'word' && !RESERVED.has(tk.v)) || isOp(tk, '%');
    if (fr.expect) {
      if (isWord(tk, 'only') || isWord(tk, 'lateral')) continue;
      if (nameStart) {
        const res = readName(toks, i);
        if (isOp(toks[res.next], '(') && !res.dynamic) { fr.expect = false; i = res.next - 1; continue; } // işlev
        addRead(res, tk.line, 'table');
        fr.expect = false;
        i = res.next - 1;
        continue;
      }
      fr.expect = false;
    }
    // nitelikli ad (şema.tablo) her konumda okuma sayılır
    if ((tk.t === 'qid' || tk.t === 'word') && isOp(toks[i + 1], '.') && ctx.knownSchemas.has(tk.v)) {
      const res = readName(toks, i);
      if (res.parts.length === 2 && isOp(toks[res.next], '(') && !res.dynamic) { i = res.next - 1; continue; } // şema.işlev(…)
      if (res.parts.length >= 2) {
        addRead(res, tk.line, 'qualified');
        i = res.next - 1;
        continue;
      }
    }
    if (tk.t !== 'word') continue;
    const w = tk.v;
    if (w === 'select' || w === 'perform') {
      if (!NON_SELECT_PREV.has(pv)) { fr.selectish = true; any = true; }
      continue;
    }
    if ((w === 'update' || w === 'delete' || w === 'insert' || w === 'merge') && !NON_DML_PREV.has(pv)) {
      let j = i + 1;
      if (w === 'update' && isWord(toks[j], 'set')) continue; // MERGE … WHEN MATCHED THEN UPDATE SET
      if (w === 'delete') { if (!isWord(toks[j], 'from')) continue; j++; }
      if (w === 'insert' || w === 'merge') { if (!isWord(toks[j], 'into')) continue; j++; }
      if (isWord(toks[j], 'only')) j++;
      const res = readName(toks, j);
      any = true;
      fr.selectish = true;
      fr.dml = w;
      if (!res) { targets.push({ schema: null, table: null, dynamic: true, line: tk.line }); continue; }
      targets.push(tableRef(res, ctx.defaultSchema, tk.line, 'table'));
      i = res.next - 1;
      continue;
    }
    if (w === 'from') {
      if (fr.selectish && pv !== 'distinct') { fr.fromClause = true; fr.expect = true; }
      continue;
    }
    if (w === 'join') { if (fr.selectish) { fr.fromClause = true; fr.expect = true; } continue; }
    if (w === 'using') { if (fr.dml === 'delete' || fr.dml === 'merge') { fr.fromClause = true; fr.expect = true; } continue; }
    if (w === 'into' && fr.selectish && !fr.dml) { // SELECT … INTO yeni_tablo FROM … (yeni tablo; okuma değil)
      continue;
    }
    if (CLAUSE_END.has(w)) fr.fromClause = false;
  }
  return { targets, reads, any };
}

const ROW_SEC = ['row', 'level', 'security'];
function seqAt(toks, i, words) {
  for (let k = 0; k < words.length; k++) if (!isWord(toks[i + k], words[k])) return false;
  return true;
}

/** Bir ifadeden olay listesi. mode: 'top' | 'plpgsql' | 'dynamic' (DO içindeki dize) */
function analyzeStatement(toks, ctx, mode, out) {
  let k = 0;
  if (mode !== 'top') {
    while (k < toks.length && toks[k].t === 'word' && PLPGSQL_PREFIX.has(toks[k].v)) {
      if (toks[k].v === 'end' && (isWord(toks[k + 1], 'if') || isWord(toks[k + 1], 'loop') || isWord(toks[k + 1], 'case'))) k++;
      k++;
    }
    if (isOp(toks[k], '<') && isOp(toks[k + 1], '<')) { // <<etiket>>
      while (k < toks.length && !(isOp(toks[k], '>') && isOp(toks[k + 1], '>'))) k++;
      k += 2;
    }
  }
  const body = toks.slice(k);
  if (!body.length) return;
  const first = body[0];
  const line = first.line;
  const w0 = first.t === 'word' ? first.v : null;

  if (w0 === 'do' && mode === 'top') { analyzeDo(body, ctx, out); return; }

  if (w0 === 'create') {
    let j = 1;
    while (body[j] && body[j].t === 'word' && ['or', 'replace', 'temp', 'temporary', 'unlogged', 'global', 'local'].includes(body[j].v)) j++;
    if (isWord(body[j], 'table')) {
      j++;
      if (isWord(body[j], 'if')) j += 3; // if not exists
      const res = readName(body, j);
      if (!res) return;
      const ref = tableRef(res, ctx.defaultSchema, line, 'table');
      out.push({ type: 'create', ref, line });
      // CREATE TABLE … AS SELECT: kaynak tablolar okunur
      let depth = 0;
      for (let m = res.next; m < body.length; m++) {
        if (isOp(body[m], '(')) depth++;
        else if (isOp(body[m], ')')) depth--;
        else if (depth === 0 && isWord(body[m], 'as')) {
          const scan = scanData(body.slice(m + 1), ctx);
          if (scan.reads.length) out.push({ type: 'data', line, targets: [], reads: scan.reads });
          break;
        }
      }
      return;
    }
    if (isWord(body[j], 'materialized') && isWord(body[j + 1], 'view')) {
      const asAt = body.findIndex((t, idx) => idx > j && isWord(t, 'as'));
      if (asAt > 0) {
        const scan = scanData(body.slice(asAt + 1), ctx);
        if (scan.reads.length) out.push({ type: 'data', line, targets: [], reads: scan.reads });
      }
    }
    return; // işlev, görünüm, dizin, ilke, tetikleyici, tür …: göç sırasında veri okumaz/yazmaz
  }

  if (w0 === 'alter') {
    if (!isWord(body[1], 'table')) return;
    let j = 2;
    if (isWord(body[j], 'if') && isWord(body[j + 1], 'exists')) j += 2;
    if (isWord(body[j], 'only')) j++;
    const res = readName(body, j);
    if (!res) return;
    const ref = tableRef(res, ctx.defaultSchema, line, 'table');
    let depth = 0;
    for (let m = res.next; m < body.length; m++) {
      if (isOp(body[m], '(')) { depth++; continue; }
      if (isOp(body[m], ')')) { depth--; continue; }
      if (depth) continue;
      let op = null;
      if (isWord(body[m], 'no') && seqAt(body, m + 1, ['force', ...ROW_SEC])) op = 'noforce';
      else if (isWord(body[m], 'force') && seqAt(body, m + 1, ROW_SEC) && !isWord(body[m - 1], 'no')) op = 'force';
      else if (isWord(body[m], 'enable') && seqAt(body, m + 1, ROW_SEC)) op = 'enable';
      else if (isWord(body[m], 'disable') && seqAt(body, m + 1, ROW_SEC)) op = 'disable';
      else if (isWord(body[m], 'rename') && isWord(body[m + 1], 'to')) {
        const to = readName(body, m + 2);
        if (to && !ref.dynamic) out.push({ type: 'rename', ref, to: to.parts[to.parts.length - 1], line });
        continue;
      }
      if (op) out.push({ type: 'rls', op, ref, line: body[m].line });
    }
    return;
  }

  if (w0 === 'drop') {
    if (!isWord(body[1], 'table')) return;
    let j = 2;
    if (isWord(body[j], 'if') && isWord(body[j + 1], 'exists')) j += 2;
    for (;;) {
      const res = readName(body, j);
      if (!res) break;
      out.push({ type: 'drop', ref: tableRef(res, ctx.defaultSchema, line, 'table'), line });
      if (!isOp(body[res.next], ',')) break;
      j = res.next + 1;
    }
    return;
  }

  if (w0 === 'set' || w0 === 'reset') {
    let j = 1;
    if (isWord(body[j], 'session') || isWord(body[j], 'local')) j++;
    if (w0 === 'set' && (isWord(body[j], 'role') || isWord(body[j], 'authorization') || (isWord(body[j - 1], 'session') && isWord(body[j], 'authorization')))) {
      const v = body[j + 1];
      const none = isWord(v, 'none') || isWord(v, 'default');
      out.push({ type: 'role', on: !none, line });
    } else if (w0 === 'reset' && (isWord(body[j], 'role') || isWord(body[j], 'all') || isWord(body[j], 'session'))) {
      out.push({ type: 'role', on: false, line });
    }
    return;
  }

  if (w0 === 'call' && mode === 'top') {
    out.push({ type: 'data', line, targets: [{ schema: null, table: null, dynamic: true, line }], reads: [], call: true });
    return;
  }

  if (mode === 'top' && w0 && NON_DATA_TOP.has(w0)) return;
  if (mode !== 'top' && (w0 === 'grant' || w0 === 'revoke' || w0 === 'comment')) return;

  const scan = scanData(body, ctx);
  if (scan.targets.length || (scan.any && scan.reads.length)) {
    // satır: ilk yazılan hedef (DO içinde IF … THEN UPDATE gibi), yoksa ifadenin başı
    out.push({ type: 'data', line: scan.targets[0]?.line ?? line, subLine: line, targets: scan.targets, reads: scan.any ? scan.reads : [] });
  }
}

function analyzeDo(toks, ctx, out) {
  const bodyTok = toks.find((t) => t.t === 'dollar' || t.t === 'str');
  if (!bodyTok) return;
  const { toks: inner, errors } = lexSql(bodyTok.v, bodyTok.line);
  for (const e of errors) out.push({ type: 'parse', line: e.line, what: e.what });
  // ARRAY[...] içindeki adlar: dinamik (%I) adların açılacağı liste
  const arrayNames = [];
  for (let i = 0; i < inner.length; i++) {
    if (isWord(inner[i], 'array') && isOp(inner[i + 1], '[')) {
      for (let j = i + 2; j < inner.length && !isOp(inner[j], ']'); j++) {
        if (inner[j].t === 'str' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner[j].v)) arrayNames.push(inner[j].v);
      }
    }
  }
  // ARRAY yoksa ad çözülmüş sayılmaz (değişkenden gelen ad bilinemez): dinamik veri ifadesi HATA olur.
  const doCtx = { ...ctx, dynamicNames: [...new Set(arrayNames)] };
  const start = out.length;
  for (const st of splitStatements(inner)) {
    analyzeStatement(st, doCtx, 'plpgsql', out);
    for (const t of st) {
      if (t.t !== 'str' && t.t !== 'dollar') continue;
      const nested = lexSql(t.v, t.line);
      for (const sub of splitStatements(nested.toks)) analyzeStatement(sub, doCtx, 'dynamic', out);
    }
  }
  // Dinamik adlar (%I) bu bloğun ARRAY[...] listesine açılır
  for (let i = start; i < out.length; i++) out[i].dynamicNames = doCtx.dynamicNames;
}

function q(s) { return `"${s}"`; }
function refName(r) { return r.table == null ? '(dinamik ad)' : `${q(r.schema ?? '?')}.${q(r.table)}`; }
function keyOf(r) { return `${r.schema}\x00${r.table}`; }

function expandRef(ref, ev, defaultSchema) {
  if (!ref.dynamic) return [ref];
  const names = ev.dynamicNames || [];
  if (!names.length || ref.table != null) return ref.table != null && ref.schema != null ? [ref] : null;
  return names.map((n) => ({ schema: ref.schema ?? defaultSchema, table: n, dynamic: false, line: ref.line, expanded: true }));
}

function rlsOkAt(lines, stmtLine) {
  for (let l = stmtLine - 1; l >= 1; l--) {
    const s = lines[l - 1];
    if (!/^\s*--/.test(s)) break;
    const m = /^\s*--\s*rls-ok\b\s*(:?)\s*(.*)$/i.exec(s);
    if (m) return m[1] === ':' && m[2].trim().length >= 3;
  }
  return false;
}

/**
 * Bir göç dosyasının K5 denetimi.
 * opts: { file, text, defaultSchema, rlsSchemas:Set, knownSchemas:Set, legacyReason?: string }
 */
export function checkMigration(opts) {
  const { file, text, defaultSchema } = opts;
  const found = [];
  const lines = text.split(/\r?\n/);
  const push = (line, message) => found.push({ line, message });

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*--\s*rls-ok\b\s*(:?)\s*(.*)$/i.exec(lines[i]);
    if (m && !(m[1] === ':' && m[2].trim().length >= 3)) {
      push(i + 1, '`-- rls-ok:` gerekçesiz: işaretten sonra nedenini yaz (ör. `-- rls-ok: tablo bu göçte boş`). Gerekçesiz işaret istisna sayılmaz.');
    }
  }

  const { toks, errors } = lexSql(text);
  for (const e of errors) push(e.line, `ayrıştırılamadı (${e.what}): göç denetlenemedi; SQL'i düzelt.`);
  const ctx = { defaultSchema, knownSchemas: opts.knownSchemas };
  const events = [];
  for (const st of splitStatements(toks)) {
    const evs = [];
    analyzeStatement(st, ctx, 'top', evs);
    for (const ev of evs) ev.stmtLine = st[0].line;
    events.push(...evs);
  }

  const isRlsSchema = (s) => s != null && opts.rlsSchemas.has(s);
  const state = new Map();
  const get = (ref) => {
    const key = keyOf(ref);
    if (!state.has(key)) {
      const on = isRlsSchema(ref.schema);
      state.set(key, { ref, enabled: on, forced: on, created: false, lowered: null, createLine: null });
    }
    return state.get(key);
  };
  const exempt = (ev) => rlsOkAt(lines, ev.line) || (ev.subLine != null && rlsOkAt(lines, ev.subLine)) || rlsOkAt(lines, ev.stmtLine);
  let roleChanged = false;

  for (const ev of events) {
    if (ev.type === 'parse') { push(ev.line, `ayrıştırılamadı (${ev.what}): DO bloğu denetlenemedi.`); continue; }
    if (ev.type === 'role') { roleChanged = ev.on; continue; }
    if (ev.type === 'create') {
      if (ev.ref.dynamic) continue;
      const st = { ref: ev.ref, enabled: false, forced: false, created: true, lowered: null, createLine: ev.line, exempt: exempt(ev) };
      state.set(keyOf(ev.ref), st);
      continue;
    }
    if (ev.type === 'drop') { if (!ev.ref.dynamic) state.set(keyOf(ev.ref), { ref: ev.ref, enabled: false, forced: false, created: false, dropped: true, lowered: null }); continue; }
    if (ev.type === 'rename') {
      const st = get(ev.ref);
      state.delete(keyOf(ev.ref));
      const ref = { ...ev.ref, table: ev.to };
      state.set(keyOf(ref), { ...st, ref });
      continue;
    }
    if (ev.type === 'rls') {
      const refs = expandRef(ev.ref, ev, defaultSchema);
      if (!refs) {
        if (ev.op === 'noforce' || ev.op === 'disable') {
          if (!exempt(ev)) push(ev.line, 'dinamik adla RLS kapatılıyor, tablo çözülemedi: sabit tablo adı yaz ya da üstüne `-- rls-ok: <neden>`.');
        }
        continue;
      }
      for (const r of refs) {
        const st = get(r);
        if (ev.op === 'noforce') { if (st.forced && st.enabled && st.lowered == null) st.lowered = { line: ev.line, op: 'NO FORCE', ev }; st.forced = false; }
        if (ev.op === 'disable') { if (st.enabled && st.lowered == null) st.lowered = { line: ev.line, op: 'DISABLE', ev }; st.enabled = false; }
        if (ev.op === 'force') st.forced = true;
        if (ev.op === 'enable') st.enabled = true;
        if (st.enabled && st.forced) st.lowered = null;
      }
      continue;
    }
    if (ev.type === 'data') {
      const bad = [];
      let unresolved = false;
      for (const r of [...ev.targets, ...ev.reads]) {
        const refs = expandRef(r, ev, defaultSchema);
        if (!refs) { unresolved = true; continue; }
        for (const rr of refs) {
          const st = get(rr);
          const active = roleChanged ? st.enabled : st.enabled && st.forced;
          if (active && !bad.some((b) => keyOf(b) === keyOf(rr))) bad.push(rr);
        }
      }
      if (exempt(ev)) continue;
      if (bad.length) {
        const why = roleChanged
          ? 'rol değiştirildi (SET ROLE): sahip olmayan rol için RLS açık'
          : 'FORCE RLS altında';
        push(ev.line, `${bad.map(refName).join(', ')} ${why}: göçte firma bağlamı yok, ifade hiçbir satırı görmez ve hata vermeden boşa çalışır. ` +
          'Önce `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`, ifadeden sonra yine `FORCE` yaz (20261112120000_import_report gibi).');
      }
      if (unresolved) {
        push(ev.line, ev.call
          ? 'CALL: çağrılan yordamın dokunduğu tablolar denetlenemez. Gerekmiyorsa kaldır, gerekiyorsa üstüne `-- rls-ok: <neden>`.'
          : 'dinamik SQL: tablo adı çözülemedi, RLS denetlenemez. Sabit tablo adı ya da ARRAY[...] listesi kullan, olmazsa üstüne `-- rls-ok: <neden>`.');
      }
    }
  }

  for (const st of state.values()) {
    if (st.lowered && !(st.enabled && st.forced) && !exempt(st.lowered.ev)) {
      push(st.lowered.line, `${refName(st.ref)} ${st.lowered.op} ile açıldı, göç sonunda geri kapanmıyor: güvenlik açığı. ` +
        `Veri ifadesinden sonra \`ALTER TABLE ${refName(st.ref)} ${st.lowered.op === 'DISABLE' ? 'ENABLE' : 'FORCE'} ROW LEVEL SECURITY\` ekle.`);
    }
    if (st.created && isRlsSchema(st.ref.schema) && !(st.enabled && st.forced) && !st.exempt) {
      const miss = [!st.enabled && 'ENABLE', !st.forced && 'FORCE'].filter(Boolean).join(' ve ');
      push(st.createLine, `yeni tablo ${refName(st.ref)} için ${miss} ROW LEVEL SECURITY yok: firma ilkesi olmadan tablo herkese açık. ` +
        'Aynı göçte init/disputes göçündeki DO bloğuyla RLS aç ya da üstüne `-- rls-ok: <neden>`.');
    }
  }

  found.sort((a, b) => a.line - b.line);
  const level = opts.legacyReason ? UYARI : HATA;
  const prefix = opts.legacyReason ? `bilinen eski göç (${opts.legacyReason}) ` : '';
  return found.map((f) => finding(level, 'K5', file, f.line, prefix + f.message));
}

// İki göç düzeni: Prisma (`…/prisma/migrations/<ad>/migration.sql`) ve düz SQL klasörü (`…/db/pg/migrations/<ad>.sql`,
// TagPress'in kendi çalıştırıcısı). İkisinde de klasör `migrations.dirs` içinde olmalı, göç adı (eski göç istisnası için) m[2].
const MIGRATION_RES = [/^(.*\/prisma\/migrations)\/([^/]+)\/migration\.sql$/, /^(.*\/db\/pg\/migrations)\/([^/]+)\.sql$/];
const migrationMatch = (file) => MIGRATION_RES.map((re) => re.exec(file)).find(Boolean) ?? null;
export function isMigration(file) { return migrationMatch(file) !== null; }

/**
 * Bütün göçler. files: [{ file, text }] (geçmiş için klasördeki tüm göçler), only: denetlenecek dosyalar (Set; yoksa hepsi)
 */
export function checkMigrations(files, cfg, only) {
  const out = [];
  const mc = cfg.migrations;
  const known = new Set([...mc.rlsSchemas, ...(mc.otherSchemas || []), ...mc.dirs.map((d) => d.defaultSchema)]);
  const rls = new Set(mc.rlsSchemas);
  // Göçlerde tablo tanımlanan şemalar da nitelikli ad olarak tanınır.
  const ddlSchemaRe = /\b(?:create|alter)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(")?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\./gi;
  for (const f of files) {
    for (const m of f.text.matchAll(ddlSchemaRe)) known.add(m[1] ? m[2] : m[2].toLowerCase());
  }
  // Herhangi bir göçte FORCE ROW LEVEL SECURITY görülen şema RLS'li sayılır (temkinli: şemanın her tablosu).
  for (const f of files) {
    const dir = mc.dirs.find((d) => f.file.startsWith(`${d.dir}/`));
    const { toks } = lexSql(f.text);
    const evs = [];
    for (const st of splitStatements(toks)) analyzeStatement(st, { defaultSchema: dir?.defaultSchema ?? null, knownSchemas: known }, 'top', evs);
    for (const ev of evs) if (ev.type === 'rls' && ev.op === 'force' && ev.ref.schema) rls.add(ev.ref.schema);
  }
  for (const f of files) {
    if (only && !only.has(f.file)) continue;
    const m = migrationMatch(f.file);
    const dir = mc.dirs.find((d) => d.dir === m[1]);
    if (!dir) {
      out.push(finding(HATA, 'K5', f.file, 1, `göç klasörü ayarda yok: scripts/repo-check.config.mjs "migrations.dirs" içine ${m[1]} ve varsayılan şemasını ekle.`));
      continue;
    }
    const legacy = (mc.legacy || []).find((l) => l.migration === m[2]);
    out.push(...checkMigration({
      file: f.file, text: f.text, defaultSchema: dir.defaultSchema, rlsSchemas: rls, knownSchemas: known, legacyReason: legacy?.reason,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sürüm aralıkları (semver alt kümesi: ^ ~ >= > <= < = x * a - b ||)
// ---------------------------------------------------------------------------------------------------------------------

function parseVer(s) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return [m[1], m[2], m[3]].map((p) => (p === undefined || /[xX*]/.test(p) ? null : Number(p)));
}
const cmpV = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const fill = (v) => v.map((x) => x ?? 0);

function comparatorInterval(c) {
  const ANY = { lo: [0, 0, 0], loInc: true, hi: null, hiInc: false };
  if (c === '' || c === '*' || c === 'x' || c === 'X' || c === 'latest') return ANY;
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] || '';
  const v = parseVer(m[2]);
  if (!v) return null;
  const [a, b, p] = v;
  if (a == null) return ANY;
  const lo = fill(v);
  const bumpLast = () => (b == null ? [a + 1, 0, 0] : p == null ? [a, b + 1, 0] : null);
  switch (op) {
    case '^': {
      let hi;
      if (a > 0 || b == null) hi = [a + 1, 0, 0];
      else if (b > 0 || p == null) hi = [0, b + 1, 0];
      else hi = [0, 0, p + 1];
      return { lo, loInc: true, hi, hiInc: false };
    }
    case '~': case '~>':
      return { lo, loInc: true, hi: b == null ? [a + 1, 0, 0] : [a, b + 1, 0], hiInc: false };
    case '>=': return { lo, loInc: true, hi: null, hiInc: false };
    case '>': { const nx = bumpLast(); return nx ? { lo: nx, loInc: true, hi: null, hiInc: false } : { lo, loInc: false, hi: null, hiInc: false }; }
    case '<': return { lo: [0, 0, 0], loInc: true, hi: lo, hiInc: false };
    case '<=': { const nx = bumpLast(); return nx ? { lo: [0, 0, 0], loInc: true, hi: nx, hiInc: false } : { lo: [0, 0, 0], loInc: true, hi: lo, hiInc: true }; }
    default: {
      const nx = bumpLast();
      return nx ? { lo, loInc: true, hi: nx, hiInc: false } : { lo, loInc: true, hi: lo, hiInc: true };
    }
  }
}
function intersectIv(x, y) {
  let lo = x.lo; let loInc = x.loInc;
  const c1 = cmpV(y.lo, x.lo);
  if (c1 > 0 || (c1 === 0 && !y.loInc)) { lo = y.lo; loInc = y.loInc && (c1 !== 0 || x.loInc); }
  let hi = x.hi; let hiInc = x.hiInc;
  if (y.hi && (!hi || cmpV(y.hi, hi) < 0 || (cmpV(y.hi, hi) === 0 && !y.hiInc))) { hi = y.hi; hiInc = y.hiInc && (!x.hi || cmpV(y.hi, x.hi) !== 0 || x.hiInc); }
  if (hi) {
    const c = cmpV(lo, hi);
    if (c > 0 || (c === 0 && !(loInc && hiInc))) return null;
  }
  return { lo, loInc, hi, hiInc };
}
/** Aralık → kesişim için aralık listesi; semver değilse null (file:, git, npm: …) */
export function parseRange(range) {
  if (typeof range !== 'string') return null;
  const r = range.trim();
  if (/^(file|link|git|git\+\w+|https?|npm|workspace|github):/.test(r) || /^[\w.-]+\/[\w.-]+/.test(r)) return null;
  const out = [];
  for (const part of r.split('||')) {
    let p = part.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(p);
    if (hy) p = `>=${hy[1]} <=${hy[2]}`;
    let iv = { lo: [0, 0, 0], loInc: true, hi: null, hiInc: false };
    for (const c of p.split(/\s+/).filter(Boolean)) {
      const ci = comparatorInterval(c);
      if (!ci) return null;
      iv = iv && intersectIv(iv, ci);
    }
    if (p === '') iv = comparatorInterval('');
    if (iv) out.push(iv);
  }
  return out;
}
export function rangesIntersect(a, b) {
  const ra = parseRange(a);
  const rb = parseRange(b);
  if (!ra || !rb) return true; // denetlenemez: kesişiyor say
  return ra.some((x) => rb.some((y) => intersectIv(x, y)));
}
export function rangeFloor(range) {
  const r = parseRange(range);
  if (!r || !r.length) return null;
  const any = r.some((iv) => !iv.hi && cmpV(iv.lo, [0, 0, 0]) === 0);
  if (any) return null;
  return r.map((iv) => iv.lo).sort(cmpV)[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// K6–K9: paketler
// ---------------------------------------------------------------------------------------------------------------------

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function jsonKeyLine(text, section, key) {
  if (!text) return 1;
  let from = 0;
  if (section) {
    const s = text.indexOf(`"${section}"`);
    if (s >= 0) from = s;
  }
  const k = text.indexOf(`"${key}"`, from);
  return k >= 0 ? lineAt(text, k) : 1;
}
function sameMap(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}
function diffMap(lockVal, real) {
  const keys = [...new Set([...Object.keys(lockVal || {}), ...Object.keys(real || {})])].sort();
  const parts = [];
  for (const k of keys) {
    const x = lockVal?.[k];
    const y = real?.[k];
    if (x === y) continue;
    parts.push(x === undefined ? `+${k} ${y}` : y === undefined ? `-${k}` : `${k} ${x} → ${y}`);
  }
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} …(+${parts.length - 3})` : parts.join(', ');
}
const norm = (p) => path.posix.normalize(p).replace(/\/$/, '');
const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
const joinRel = (dir, rel) => norm(path.posix.join(dir || '.', rel));

/**
 * src: { has(path), text(path) → string|null, paths: string[] (tüm dosyalar) }
 */
export function checkPackages(src, cfg) {
  const out = [];
  const pkgFiles = src.paths.filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/') && !isExcluded(p, cfg));
  const pkgs = new Map(); // dir → { file, json, text, lock, lockText }
  for (const file of pkgFiles) {
    const text = src.text(file);
    if (text == null) continue;
    let json;
    try { json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) {
      out.push(finding(HATA, 'K6', file, 1, `package.json okunamadı (${e.message.split('\n')[0]}).`));
      continue;
    }
    const dir = dirOf(file);
    const lockFile = dir ? `${dir}/package-lock.json` : 'package-lock.json';
    let lock = null;
    let lockText = null;
    if (src.has(lockFile)) {
      lockText = src.text(lockFile);
      try { lock = JSON.parse(lockText); } catch (e) {
        out.push(finding(HATA, 'K7', lockFile, 1, `kilit okunamadı (${e.message.split('\n')[0]}).`));
      }
    }
    pkgs.set(dir, { file, dir, json, text, lock, lockFile, lockText });
  }
  const label = (dir) => dir || '(kök)';

  // K6
  for (const p of pkgs.values()) {
    for (const sec of DEP_SECTIONS) {
      for (const [name, spec] of Object.entries(p.json[sec] || {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
        const target = joinRel(p.dir, spec.slice(5));
        const line = jsonKeyLine(p.text, sec, name);
        const t = pkgs.get(target);
        if (!t) {
          out.push(finding(HATA, 'K6', p.file, line, `${name}: "${spec}" yolunda package.json yok. Yolu düzelt.`));
        } else if (t.json.name !== name) {
          out.push(finding(HATA, 'K6', p.file, line, `${name}: "${spec}" hedefindeki paketin adı "${t.json.name}". Anahtar ile ad aynı olmalı.`));
        }
      }
    }
  }

  // K7
  for (const p of pkgs.values()) {
    if (!p.lock?.packages) continue;
    const fix = `${label(p.dir)} içinde \`npm install --package-lock-only\``;
    for (const [key, entry] of Object.entries(p.lock.packages)) {
      if (key === '' || key.startsWith('node_modules/') || key.includes('/node_modules/')) continue;
      const target = joinRel(p.dir, key);
      const real = pkgs.get(target);
      const line = jsonKeyLine(p.lockText, 'packages', key);
      if (!real) {
        out.push(finding(HATA, 'K7', p.lockFile, line, `kilitteki yerel paket "${key}" yok (${target}). ${fix}.`));
        continue;
      }
      const bad = [];
      if ((entry.version ?? null) !== (real.json.version ?? null)) bad.push(`version ${entry.version} → ${real.json.version}`);
      for (const sec of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        if (!sameMap(entry[sec], real.json[sec])) bad.push(`${sec}: ${diffMap(entry[sec], real.json[sec])}`);
      }
      if (bad.length) out.push(finding(HATA, 'K7', p.lockFile, line, `${real.json.name} kilitte eski (${bad.join('; ')}). ${fix}.`));
      if (!sameMap(entry.devDependencies, real.json.devDependencies)) {
        out.push(finding(UYARI, 'K7', p.lockFile, line,
          `${real.json.name} kilitte eski devDependencies (${diffMap(entry.devDependencies, real.json.devDependencies)}). ${fix}.`));
      }
    }
    // tüketicinin kendi file: bağları kilitte doğru yere bağlı mı
    for (const sec of DEP_SECTIONS) {
      for (const [name, spec] of Object.entries(p.json[sec] || {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
        const want = norm(spec.slice(5));
        const e = p.lock.packages[`node_modules/${name}`];
        const line = jsonKeyLine(p.lockText, 'packages', `node_modules/${name}`);
        if (!e) out.push(finding(HATA, 'K7', p.lockFile, line, `${name} kilitte yok. ${fix}.`));
        else if (!e.link || norm(e.resolved || '') !== want) {
          out.push(finding(HATA, 'K7', p.lockFile, line, `${name} kilitte "${e.resolved ?? e.version}" olarak çözülmüş, package.json "${spec}" diyor. ${fix}.`));
        }
      }
    }
  }

  // K8
  for (const img of cfg.sharedNodeModules || []) {
    const consumer = pkgs.get(img.consumer);
    if (!consumer) {
      out.push(finding(HATA, 'K8', `${img.consumer}/package.json`, 1, 'ayardaki tüketici bulunamadı: scripts/repo-check.config.mjs "sharedNodeModules" listesini düzelt.'));
      continue;
    }
    const cDeps = consumer.json.dependencies || {};
    const cDev = consumer.json.devDependencies || {};
    const seen = new Set();
    const queue = [];
    const enqueue = (fromDir, deps) => {
      for (const spec of Object.values(deps || {})) {
        if (typeof spec === 'string' && spec.startsWith('file:')) {
          const t = joinRel(fromDir, spec.slice(5));
          if (!seen.has(t) && pkgs.has(t)) { seen.add(t); queue.push(t); }
        }
      }
    };
    enqueue(consumer.dir, cDeps);
    while (queue.length) {
      const lp = pkgs.get(queue.shift());
      const peers = Object.fromEntries(Object.entries(lp.json.peerDependencies || {})
        .filter(([n]) => !lp.json.peerDependenciesMeta?.[n]?.optional));
      for (const [sec, deps] of [['dependencies', lp.json.dependencies || {}], ['peerDependencies', peers]]) {
        for (const [name, spec] of Object.entries(deps)) {
          if (name.startsWith('@types/')) continue;
          const line = jsonKeyLine(lp.text, sec, name);
          const where = `${lp.json.name} (${sec})`;
          if (typeof spec === 'string' && spec.startsWith('file:')) {
            const t = joinRel(lp.dir, spec.slice(5));
            const cs = cDeps[name];
            if (!(typeof cs === 'string' && cs.startsWith('file:') && joinRel(consumer.dir, cs.slice(5)) === t)) {
              out.push(finding(HATA, 'K8', lp.file, line,
                `${where} ${name} ister; ${img.consumer} "dependencies" içinde aynı yere "file:" bağı yok. İmajda paket bulunamaz: ${img.consumer}/package.json'a ekle.`));
            }
            continue;
          }
          const cs = cDeps[name];
          if (cs === undefined) {
            const devOnly = cDev[name] !== undefined ? ' (yalnız devDependencies\'te; `--omit=dev` imajında yok)' : '';
            out.push(finding(HATA, 'K8', lp.file, line,
              `${where} ${name} ${spec} ister; ${img.consumer} "dependencies" içinde yok${devOnly}. İmaj node_modules'u paylaştığı için çalışma anında bulunamaz: ${img.consumer}/package.json "dependencies"e ekle.`));
          } else if (!rangesIntersect(spec, cs)) {
            out.push(finding(HATA, 'K8', lp.file, line,
              `${where} ${name} ${spec} ister, ${img.consumer} ${cs} kuruyor; aralıklar kesişmiyor. Sürümleri hizala.`));
          }
        }
      }
      enqueue(lp.dir, lp.json.dependencies);
    }
  }

  // K9 ortak kütüphaneler
  const vc = cfg.versions;
  for (const lib of vc.libs) {
    const entries = [];
    for (const p of pkgs.values()) {
      if (vc.exceptions.some((e) => e.pkg === p.dir && e.lib === lib)) continue;
      for (const sec of ['dependencies', 'devDependencies']) {
        const spec = p.json[sec]?.[lib];
        if (spec === undefined) continue;
        const floor = rangeFloor(spec);
        const lockV = p.lock?.packages?.[`node_modules/${lib}`]?.version;
        const lockMaj = lockV ? Number(String(lockV).split('.')[0]) : null;
        if (!floor) continue;
        entries.push({ p, sec, spec, maj: floor[0], min: floor[1], lockV, lockMaj });
      }
    }
    if (entries.length < 2 && !entries.some((e) => e.lockMaj != null && e.lockMaj !== e.maj)) continue;
    const mode = (vals) => {
      const c = new Map();
      for (const v of vals) c.set(v, (c.get(v) || 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
    };
    const major = mode(entries.map((e) => e.maj));
    const others = (pred) => [...new Set(entries.filter(pred).map((e) => label(e.p.dir)))].slice(0, 3).join(', ');
    for (const e of entries) {
      const line = jsonKeyLine(e.p.text, e.sec, lib);
      if (e.maj !== major) {
        out.push(finding(HATA, 'K9', e.p.file, line,
          `${lib} ${e.spec}: ana sürüm ${e.maj}, diğer paketlerde ${major} (${others((x) => x.maj === major)}). Hizala ya da ayarda gerekçeli istisna yaz.`));
      } else if (e.lockMaj != null && e.lockMaj !== e.maj) {
        out.push(finding(HATA, 'K9', e.p.lockFile, jsonKeyLine(e.p.lockText, 'packages', `node_modules/${lib}`),
          `${lib}: kilitte ${e.lockV} çözülmüş, package.json ${e.spec} diyor. ${label(e.p.dir)} içinde \`npm install --package-lock-only\`.`));
      }
    }
    const same = entries.filter((e) => e.maj === major);
    const minor = mode(same.map((e) => e.min));
    for (const e of same) {
      if (e.min !== minor) {
        out.push(finding(UYARI, 'K9', e.p.file, jsonKeyLine(e.p.text, e.sec, lib),
          `${lib} ${e.spec}: küçük sürüm ${major}.${e.min}, çoğunluk ${major}.${minor} (${others((x) => x.maj === major && x.min === minor)}).`));
      }
    }
  }

  // K9 Node sürümü: .nvmrc = kök engines alt sınırı; Dockerfile FROM node: aynı ana sürüm (E5 sonrası tam eşit)
  const nvmText = src.has('.nvmrc') ? src.text('.nvmrc') : null;
  const nvm = nvmText ? nvmText.trim().replace(/^v/, '') : null;
  const nvmV = nvm ? parseVer(nvm) : null;
  if (!nvmV) {
    out.push(finding(UYARI, 'K9', '.nvmrc', 1, '`.nvmrc` yok ya da okunamadı: Node sürümü sabit değil.'));
  } else {
    const root = pkgs.get('');
    const eng = root?.json.engines?.node;
    if (!eng) {
      out.push(finding(UYARI, 'K9', 'package.json', 1, 'kök package.json\'da "engines.node" yok.'));
    } else {
      const floor = rangeFloor(eng);
      if (!floor || cmpV(floor, fill(nvmV)) !== 0) {
        out.push(finding(HATA, 'K9', 'package.json', jsonKeyLine(root.text, 'engines', 'node'),
          `"engines.node" ${eng} alt sınırı .nvmrc (${nvm}) ile aynı değil. İkisini eşitle.`));
      }
    }
    for (const f of src.paths.filter((p) => fileKind(p) === 'dockerfile' && !isExcluded(p, cfg))) {
      const text = src.text(f);
      if (text == null) continue;
      const lines = text.split(/\r?\n/);
      lines.forEach((l, i) => {
        const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?(?:library\/)?node:([^\s@]+)/i.exec(l);
        if (!m) return;
        const tag = m[1];
        const vm = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag);
        if (!vm) {
          out.push(finding(HATA, 'K9', f, i + 1, `node:${tag} sürüm belirtmiyor: .nvmrc (${nvm}) ile aynı sürümü yaz.`));
          return;
        }
        if (Number(vm[1]) !== nvmV[0]) {
          out.push(finding(HATA, 'K9', f, i + 1, `node:${tag} ana sürümü .nvmrc (${nvm}) ile aynı değil.`));
        } else if (vc.dockerNodeExact && `${vm[1]}.${vm[2]}.${vm[3]}` !== nvm) {
          out.push(finding(HATA, 'K9', f, i + 1, `node:${tag} .nvmrc (${nvm}) ile tam eşit değil: \`node:${nvm}-alpine\` yaz.`));
        }
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// K10–K11: Markdown belgeleri (yalnız UYARI)
// ---------------------------------------------------------------------------------------------------------------------

const DOC_ROOTS = ['Platform/', 'Deciship/', 'Tagpress/', 'scripts/', 'tools/', 'SONRAKI-OTURUM/', '.github/', '.githooks/', '.claude/'];
const DOC_SKIP_RE = /[*<>{}$…]|\.\.\./;

export function isDocFile(file, cfg) {
  const d = cfg.docs;
  if (!d || !/\.md$/i.test(file)) return false;
  return d.include.some((g) => matchGlob(file, g)) && !d.exclude.some((e) => matchGlob(file, e.glob));
}

/** Backtick içi aralığı depo yoluna çevirir; yol gibi görünmüyorsa null. */
function docPathOf(span) {
  const t = span.trim();
  if (!DOC_ROOTS.some((r) => t.startsWith(r)) || DOC_SKIP_RE.test(t)) return null;
  let p = t.split(/\s+/)[0];
  p = p.replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '');
  p = p.replace(/[.,;:!?)\]]+$/, '');
  p = p.replace(/\/+$/, '');
  return p || null;
}

/** Tek Markdown dosyasının K10 ve K11 denetimi (UYARI). exists(yol): depo köküne göre yol var mı. */
export function checkDocFile(file, text, exists, cfg) {
  const out = [];
  if (!isDocFile(file, cfg)) return out;
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const lines = text.split('\n');
  const max = cfg.docs.maxLineLength;
  let longCount = 0;
  let first = null;
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > max) {
      longCount++;
      if (!first) first = { line: i + 1, len: line.length };
    }
    if (isAllowed(file, 'K10', cfg) || !line.includes('`')) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const p = docPathOf(m[1]);
      if (!p) continue;
      if (exists(p) || (dir && exists(`${dir}/${p}`))) continue;
      out.push(finding(UYARI, 'K10', file, i + 1, `belgedeki yol yok: ${p}`));
    }
  });
  if (longCount && !isAllowed(file, 'K11', cfg)) {
    out.push(finding(UYARI, 'K11', file, first.line,
      `${longCount} satır ${max} karakteri aşıyor (ilk: satır ${first.line}, ${first.len} karakter)`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Koşu
// ---------------------------------------------------------------------------------------------------------------------

let gitCwd = ROOT;
function git(args, input) {
  const r = spawnSync('git', args, { cwd: gitCwd, input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr?.toString().trim() || r.error?.message}`);
  return r.stdout;
}

function parseEol(buf) {
  const meta = new Map();
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const head = rec.slice(0, tab);
    const file = rec.slice(tab + 1);
    const m = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\s*$/.exec(head);
    meta.set(file, m ? { index: m[1], work: m[2], attr: m[3] } : { index: '', work: '', attr: '' });
  }
  return meta;
}

function catFileBatch(paths) {
  const res = new Map();
  if (!paths.length) return res;
  const out = git(['cat-file', '--batch'], paths.map((p) => `:${p}`).join('\n') + '\n');
  let pos = 0;
  for (const p of paths) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!m) { res.set(p, null); continue; }
    const size = Number(m[2]);
    res.set(p, m[1] === 'blob' ? out.subarray(pos, pos + size) : null);
    pos += size + 1;
  }
  return res;
}

const PKG_RELATED = (p) => /(^|\/)package(-lock)?\.json$/.test(p) || p === '.nvmrc' || fileKind(p) === 'dockerfile';

/** root: denetlenen git deposu (varsayılan bu depo; testler geçici depo verir). */
export function run({ staged = false, cfg, root = ROOT }) {
  const t0 = performance.now();
  gitCwd = root;
  let autocrlf = '';
  try { autocrlf = git(['config', '--get', 'core.autocrlf']).toString().trim().toLowerCase(); } catch { /* ayarsız */ }
  const findings = [];
  let checkPaths;
  let allPaths;
  let meta;
  let readBuf;
  let wantMig;
  let wantPkg;
  let docPaths;
  let docRead = null;
  if (!staged) {
    meta = parseEol(git(['ls-files', '-z', '--eol', '--cached', '--others', '--exclude-standard']));
    for (const p of [...meta.keys()]) if (isExcluded(p, cfg)) meta.delete(p);
    const cache = new Map();
    readBuf = (p) => {
      if (cache.has(p)) return cache.get(p);
      let b = null;
      try { b = readFileSync(path.join(root, p)); } catch { /* silinmiş */ }
      cache.set(p, b);
      return b;
    };
    allPaths = [...meta.keys()].filter((p) => readBuf(p) !== null);
    checkPaths = allPaths;
    wantMig = true;
    wantPkg = true;
    // K10/K11 kapsamı genel `exclude`tan geniştir (SONRAKI-OTURUM dahil): ayrı liste.
    docPaths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8')
      .split('\x00').filter((p) => p && isDocFile(p, cfg));
    docRead = (p) => { try { return readFileSync(path.join(root, p)); } catch { return null; } };
  } else {
    const stagedList = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).toString('utf8').split('\x00').filter(Boolean);
    checkPaths = stagedList.filter((p) => !isExcluded(p, cfg));
    wantMig = checkPaths.some(isMigration);
    wantPkg = checkPaths.some(PKG_RELATED);
    // Hız: `ls-files --eol` çalışma ağacının tamamını okur; burada index satır sonu blob'dan, öznitelik check-attr'dan.
    allPaths = wantMig || wantPkg
      ? git(['ls-files', '-z', '--cached']).toString('utf8').split('\x00').filter((p) => p && !isExcluded(p, cfg))
      : checkPaths;
    docPaths = stagedList.filter((p) => isDocFile(p, cfg));
    const need = new Set([...checkPaths, ...docPaths]);
    if (wantMig) for (const p of allPaths) if (isMigration(p)) need.add(p);
    if (wantPkg) for (const p of allPaths) if (PKG_RELATED(p)) need.add(p);
    const blobs = catFileBatch([...need]);
    readBuf = (p) => blobs.get(p) ?? null;
    meta = new Map();
    if (checkPaths.length) {
      const attrs = git(['check-attr', '-z', '--stdin', 'text', 'eol'], checkPaths.join('\x00')).toString('utf8').split('\x00');
      const attr = new Map();
      for (let i = 0; i + 2 < attrs.length; i += 3) {
        const [p, name, val] = [attrs[i], attrs[i + 1], attrs[i + 2]];
        if (val === 'unspecified') continue;
        const cur = attr.get(p) || [];
        cur.push(name === 'text' ? (val === 'unset' ? '-text' : val === 'set' ? 'text' : `text=${val}`) : `${name}=${val}`);
        attr.set(p, cur);
      }
      for (const p of checkPaths) {
        const b = readBuf(p);
        let index = 'none';
        if (b) {
          let crlf = 0;
          let lf = 0;
          for (let k = b.indexOf(0x0a); k !== -1; k = b.indexOf(0x0a, k + 1)) { lf++; if (k > 0 && b[k - 1] === 0x0d) crlf++; }
          index = b.includes(0) ? '-text' : lf === 0 ? 'none' : crlf === 0 ? 'lf' : crlf === lf ? 'crlf' : 'mixed';
        }
        meta.set(p, { index, work: '', attr: (attr.get(p) || []).join(' ') });
      }
    }
  }

  for (const p of checkPaths) {
    const b = readBuf(p);
    if (b) findings.push(...checkTextFile(p, b, meta.get(p), cfg, { autocrlf }));
  }
  if (docPaths.length) {
    const exists = (p) => existsSync(path.join(root, p));
    const read = docRead || readBuf;
    for (const p of docPaths) {
      const b = read(p);
      if (b) findings.push(...checkDocFile(p, b.toString('utf8'), exists, cfg));
    }
  }
  if (wantMig) {
    const migs = allPaths.filter((p) => isMigration(p) && !isExcluded(p, cfg))
      .map((p) => ({ file: p, text: readBuf(p)?.toString('utf8') })).filter((f) => f.text != null);
    const only = staged ? new Set(checkPaths.filter(isMigration)) : null;
    findings.push(...checkMigrations(migs, cfg, only));
  }
  if (wantPkg) {
    const set = new Set(allPaths);
    findings.push(...checkPackages({
      paths: allPaths, has: (p) => set.has(p) && readBuf(p) !== null, text: (p) => readBuf(p)?.toString('utf8') ?? null,
    }, cfg));
  }
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === HATA ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, files: checkPaths.length, ms: Math.round(performance.now() - t0) };
}

export function format(res) {
  const lines = res.findings.map((f) => `${f.level} [${f.rule}] ${f.file}:${f.line}  ${f.message}`);
  const e = res.findings.filter((f) => f.level === HATA).length;
  const w = res.findings.length - e;
  lines.push(`repo-check: ${e} HATA, ${w} UYARI (${res.files} dosya, ${res.ms} ms)`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--staged', '--json'].includes(a));
  if (unknown.length) {
    console.error(`repo-check: bilinmeyen bayrak ${unknown.join(' ')}. Kullanım: node scripts/repo-check.mjs [--staged] [--json]`);
    process.exit(2);
  }
  const { default: cfg } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'repo-check.config.mjs')).href);
  let res;
  try {
    res = run({ staged: args.includes('--staged'), cfg });
  } catch (e) {
    console.error(`repo-check: ${e.message}`);
    process.exit(2);
  }
  const errors = res.findings.filter((f) => f.level === HATA).length;
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: errors === 0, errors, warnings: res.findings.length - errors, files: res.files, ms: res.ms, findings: res.findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${format(res)}\n`);
  }
  process.exitCode = errors ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
