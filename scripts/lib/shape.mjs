// Yanıt şekli (Mesaj 10, 15-B2): gerçek API yanıtının alan adları ve türleri, değerleri değil.
// Gerçek API testleri `shapeOf` ile şekli depoya yazar; sahte API testleri kendi yanıtlarını `compareShape` ile ona karşı sınar.
// Yalnız Node yerleşikleri; TypeScript testlerinden de (vitest, node --test) içe aktarılır.
//
// Şekil dili (JSON):
//   "string" | "number" | "boolean" | "null"     ilkel
//   []                                            boş dizi (öğe türü bilinmiyor)
//   [<şekil>]                                     dizi; bütün öğelerin birleşik şekli
//   { "alan": <şekil>, "secimli?": <şekil> }      nesne; adı "?" ile biten alan bazı örneklerde yok
//   { "*": <şekil> }                              kayıt (anahtarlar kimlik, tarih, sayı ya da para kodu)
//   { "$oneOf": [<şekil>, ...] }                  birleşim (ör. nesne ya da null)

const RECORD_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}(-\d{2})?|\d+|[A-Z]{3})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const kindOf = (s) => (typeof s === 'string' ? s : Array.isArray(s) ? 'array' : '$oneOf' in s ? 'union' : '*' in s && Object.keys(s).length === 1 ? 'record' : 'object');

/**
 * Bir değerin şekli. `opts.records`: kayıt sayılacak yollar (ör. ["$.byCarrier"]); kimlik/tarih/sayı/para kodu
 * anahtarlı nesneler kendiliğinden kayıt sayılır. `opts.opaque`: içine bakılmayacak yollar (şekli "any" yazılır).
 */
export function shapeOf(value, opts = {}, at = '$') {
  if ((opts.opaque ?? []).includes(at)) return 'any';
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return [];
    return [value.map((v) => shapeOf(v, opts, `${at}[]`)).reduce(mergeShapes)];
  }
  if (isObj(value)) {
    const keys = Object.keys(value);
    const asRecord = (opts.records ?? []).includes(at) || (keys.length > 0 && keys.every((k) => RECORD_KEY.test(k)));
    // boş kayıt (ör. `records` ile işaretli `{}`): değer türü bilinmiyor, "null" yazılır
    if (asRecord) return { '*': keys.length ? keys.map((k) => shapeOf(value[k], opts, `${at}.*`)).reduce(mergeShapes) : 'null' };
    const out = {};
    for (const k of keys.sort()) out[k] = shapeOf(value[k], opts, `${at}.${k}`);
    return out;
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'any';
}

const members = (s) => (isObj(s) && '$oneOf' in s ? s.$oneOf : [s]);
const bare = (k) => (k.endsWith('?') ? k.slice(0, -1) : k);

/** İki şekli birleştirir (aynı alanın farklı örneklerdeki hâlleri). */
export function mergeShapes(a, b) {
  if (a === 'any' || b === 'any') return 'any';
  const all = [...members(a), ...members(b)];
  const groups = new Map();
  for (const s of all) {
    const k = kindOf(s);
    const key = k === 'object' || k === 'record' || k === 'array' ? k : s;
    if (!groups.has(key)) { groups.set(key, s); continue; }
    const prev = groups.get(key);
    if (k === 'array') groups.set(key, !prev.length ? s : !s.length ? prev : [mergeShapes(prev[0], s[0])]);
    else if (k === 'record') groups.set(key, { '*': mergeShapes(prev['*'], s['*']) });
    else if (k === 'object') groups.set(key, mergeObjects(prev, s));
  }
  const list = [...groups.values()];
  return list.length === 1 ? list[0] : { $oneOf: list.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) };
}

function mergeObjects(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)].map(bare));
  const out = {};
  for (const n of [...names].sort()) {
    const ka = n in a ? n : `${n}?` in a ? `${n}?` : null;
    const kb = n in b ? n : `${n}?` in b ? `${n}?` : null;
    const optional = !ka || !kb || ka.endsWith('?') || kb.endsWith('?');
    const s = ka && kb ? mergeShapes(a[ka], b[kb]) : ka ? a[ka] : b[kb];
    out[optional ? `${n}?` : n] = s;
  }
  return out;
}

/**
 * Sahte yanıtın şeklini (`mock`) gerçek şekle (`real`) karşı sınar. Dönen dizi boşsa uyumlu.
 * Kurallar: sahte API gerçekte olmayan alan uyduramaz; gerçekte her zaman olan alanı atlayamaz; her türü gerçekte
 * görülmüş olmalı (gerçekte hep nesne olan alana null veremez). Gerçek örnekte yalnız null ya da boş dizi görülen yer
 * bilinmiyor sayılır ve her şeyi kabul eder. `opts.ignore`: sınanmayacak yollar (gerekçesi çağıran testte yazılır).
 */
export function compareShape(mock, real, opts = {}, at = '$', out = []) {
  if ((opts.ignore ?? []).includes(at)) return out;
  if (real === 'any' || mock === 'any') return out;
  const realM = members(real);
  if (realM.every((s) => s === 'null' || (Array.isArray(s) && !s.length))) return out;
  for (const m of members(mock)) {
    const k = kindOf(m);
    if (m === 'null' && !realM.includes('null')) { out.push(`${at}: sahte API null veriyor, gerçekte hep ${describe(real)}`); continue; }
    if (m === 'null') continue;
    if (k === 'array') {
      const r = realM.find((s) => Array.isArray(s));
      if (!r) { out.push(`${at}: sahte API dizi veriyor, gerçekte ${describe(real)}`); continue; }
      if (m.length && r.length) compareShape(m[0], r[0], opts, `${at}[]`, out);
      continue;
    }
    if (k === 'record' || k === 'object') {
      const r = realM.find((s) => kindOf(s) === 'record' || kindOf(s) === 'object');
      if (!r) { out.push(`${at}: sahte API nesne veriyor, gerçekte ${describe(real)}`); continue; }
      if (kindOf(r) === 'record' || k === 'record') {
        // nesne kayda karşı: değerlerinin birleşimi (başlangıç değeri yok; "null" katmak sahte null farkı üretirdi)
        const rvals = kindOf(r) === 'record' ? [r['*']] : Object.values(r);
        const mvals = k === 'record' ? [m['*']] : Object.values(m);
        if (mvals.length) compareShape(mvals.reduce(mergeShapes), rvals.length ? rvals.reduce(mergeShapes) : 'null', opts, `${at}.*`, out);
        continue;
      }
      const realNames = new Map(Object.keys(r).map((key) => [bare(key), key]));
      const mockNames = new Map(Object.keys(m).map((key) => [bare(key), key]));
      for (const [n, mk] of mockNames) {
        const path = `${at}.${n}`;
        if ((opts.ignore ?? []).includes(path)) continue;
        const rk = realNames.get(n);
        if (!rk) { out.push(`${path}: sahte API'de var, gerçekte yok`); continue; }
        compareShape(m[mk], r[rk], opts, path, out);
      }
      for (const [n, rk] of realNames) {
        const path = `${at}.${n}`;
        if (rk.endsWith('?') || mockNames.has(n) || (opts.ignore ?? []).includes(path)) continue;
        out.push(`${path}: gerçekte var, sahte API'de yok`);
      }
      continue;
    }
    if (!realM.includes(m)) out.push(`${at}: sahte API ${m} veriyor, gerçekte ${describe(real)}`);
  }
  return out;
}

function describe(s) {
  return members(s).map((x) => (typeof x === 'string' ? x : Array.isArray(x) ? 'dizi' : kindOf(x) === 'record' ? 'kayıt' : 'nesne')).join(' | ');
}
