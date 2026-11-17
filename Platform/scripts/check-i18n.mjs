#!/usr/bin/env node
/**
 * Ortak i18n denetimi (bağımlılıksız). Her yüzeyde (panel, mobil, Merkez, kabuk) aynı betik çalışır.
 *
 * Çağrı:
 *   node check-i18n.mjs --root . --locales src/locales --src src[,app] [--skip mocks,__tests__,i18n]
 *                       [--default-ns common] [--strict]
 *
 * Denetimler:
 *   1. TR ve EN dosya/anahtar eşliği   2. boş değer   3. yasak sözcük   4. EN'de Türkçe karakter (uyarı)
 *   5. kodda t('…'), i18nKey=, i18n.t(…, {ns}) ile kullanılıp sözlükte olmayan anahtar
 *   6. kodda kalan Türkçe metin
 * 1-3 her zaman hatadır. 5 ve 6 uyarıdır; `--strict` ile hata olur.
 *
 * Kodda kalan Türkçe sayılmayanlar: yorumlar (// ve blok, CRLF dahil), düzenli ifade değişmezleri,
 * `console.*(` satırları, `--skip` ile verilen klasörler (varsayılan mocks,mock,__tests__,i18n), `*.test.*` ve `*.spec.*`
 * dosyaları, `locales` klasörü. Tek satırlık istisna: satır sonuna `// i18n-ok: <neden>` (nedensiz işaret hatadır).
 */
import fs from 'node:fs';
import path from 'node:path';

const TR_CHARS = /[çğıİöşüÇĞÖŞÜ]/;
const PLURAL = /_(zero|one|two|few|many|other)$/;

// Ürün kararı: "işçi" yok ("çalışan"), deneme/trial dönemi yok. Yanlış pozitif için BANNED_OK'a `dosya anahtar` deseni ekle.
const BANNED = [/işçi/i, /isçi/i, /\bworkers?\b/i, /\btrial\b/i, /14 gün/i, /14[- ]day/i];
const BANNED_OK = [];

function parseArgs(argv) {
  const o = { root: '.', locales: 'src/locales', src: ['src'], skip: ['mocks', 'mock', '__tests__', 'i18n'], defaultNs: undefined, strict: false };
  const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') o.strict = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--locales') o.locales = argv[++i];
    else if (a === '--src') o.src = list(argv[++i]);
    else if (a === '--skip') o.skip = list(argv[++i]);
    else if (a === '--default-ns') o.defaultNs = argv[++i];
    else { console.error(`Bilinmeyen parametre: ${a}`); process.exit(2); }
  }
  return o;
}

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const readJson = (f) => { const s = fs.readFileSync(f, 'utf8'); return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); };

/**
 * Bir satırdaki koddan yorumları ve düzenli ifade değişmezlerini çıkarır; dizgeler kalır.
 * `st` dosya boyunca taşınan durum: { block: /* içinde mi, tpl: şablon dizgesi içinde mi }.
 * Satırlar \r?\n ile bölündüğü için CRLF'li dosyada da `//` doğru eşleşir.
 */
function stripLine(line, st) {
  let out = '';
  let i = 0;
  let quote = st.tpl ? '`' : null;
  let prev = ''; // son anlamlı (boşluk olmayan) kod karakteri
  while (i < line.length) {
    const c = line[i];
    const n = line[i + 1];
    if (st.block) {
      if (c === '*' && n === '/') { st.block = false; i += 2; } else i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) { quote = null; st.tpl = false; prev = c; }
      i++;
      continue;
    }
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') { st.block = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      if (c === '`') st.tpl = true;
      out += c; i++;
      continue;
    }
    // düzenli ifade değişmezi: önceki anlamlı karakter bir işleç/ayraçsa
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /(?:^|[^\w$.])(?:return|typeof|case|in|of)\s*$/.test(out))) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      for (; j < line.length; j++) {
        const d = line[j];
        if (d === '\\') { j++; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) { ok = true; break; }
      }
      if (ok) {
        j++;
        while (j < line.length && /[a-z]/.test(line[j])) j++;
        out += ' ';
        i = j;
        prev = ')';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  // Tek tırnaklı dizge satır sonunda kapanmamışsa (JSX metnindeki kesme işareti gibi) durum taşınmaz.
  return out;
}

function walk(dir, skipDirs, visit) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'locales' || e.name === 'node_modules' || skipDirs.has(e.name)) continue;
      walk(p, skipDirs, visit);
    } else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !/\.d\.ts$/.test(e.name)) visit(p);
  }
}

export function run(argv, log = { error: console.error, warn: console.warn, log: console.log }) {
  const opt = parseArgs(argv);
  const root = path.resolve(opt.root);
  const locales = path.resolve(root, opt.locales);
  const skipDirs = new Set(opt.skip);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  let errors = 0;
  let warnings = 0;
  const err = (m) => { errors++; log.error(m); };
  // 5 ve 6: --strict'te hata, değilse uyarı
  const soft = (m) => { if (opt.strict) err(m); else { warnings++; log.warn(m); } };

  // 1-4: sözlükler
  const nsKeys = {};
  const trDir = path.join(locales, 'tr');
  const enDir = path.join(locales, 'en');
  if (!fs.existsSync(trDir)) { log.error(`Sözlük klasörü yok: ${rel(trDir)}`); return { code: 1, errors: 1, left: 0 }; }
  for (const f of fs.readdirSync(trDir).filter((x) => x.endsWith('.json'))) {
    const tr = new Map(flat(readJson(path.join(trDir, f))));
    nsKeys[f.replace(/\.json$/, '')] = new Set([...tr.keys()].map((k) => k.replace(PLURAL, '')));
    const enPath = path.join(enDir, f);
    if (!fs.existsSync(enPath)) { err(`EKSİK DOSYA en/${f}`); continue; }
    const en = new Map(flat(readJson(enPath)));
    for (const k of tr.keys()) if (!en.has(k)) err(`EN'de yok: ${f} ${k}`);
    for (const k of en.keys()) if (!tr.has(k)) err(`TR'de yok: ${f} ${k}`);
    for (const [k, v] of [...tr, ...en]) if (v === '') err(`Boş: ${f} ${k}`);
    for (const [k, v] of en) if (TR_CHARS.test(String(v))) { warnings++; log.warn(`EN'de Türkçe karakter: ${f} ${k}`); }
    for (const [k, v] of [...tr, ...en]) for (const re of BANNED) if (re.test(String(v)) && !BANNED_OK.some((ok) => ok.test(`${f} ${k}`))) err(`Yasak kelime (${re}): ${f} ${k}`);
  }
  if (fs.existsSync(enDir)) for (const f of fs.readdirSync(enDir).filter((x) => x.endsWith('.json'))) if (!fs.existsSync(path.join(trDir, f))) err(`EKSİK DOSYA tr/${f}`);

  // 5 ve 6: kaynak dosyalar
  let left = 0;
  const usedMissing = [];
  for (const s of opt.src) {
    walk(path.resolve(root, s), skipDirs, (p) => {
      const text = fs.readFileSync(p, 'utf8');
      const st = { block: false, tpl: false };
      text.split(/\r?\n/).forEach((line, i) => {
        // Satır içi izin: `// i18n-ok: <neden>`; nedensiz işaret hatadır.
        const mark = /\/\/\s*i18n-ok\b(?::\s*(\S.*))?\s*$/.exec(line);
        if (mark && !mark[1]) err(`Nedensiz i18n-ok işareti: ${rel(p)}:${i + 1}`);
        const code = stripLine(line, st);
        if (mark) return;
        if (/\bconsole\.\w+\s*\(/.test(code)) return;
        if (TR_CHARS.test(code)) { left++; soft(`Kalan: ${rel(p)}:${i + 1}  ${line.trim().slice(0, 90)}`); }
      });

      // Bir dosyada birden çok bileşen farklı ad alanı kullanabilir ve çeviri işlevi yeniden adlandırılabilir
      // (`const { t: tAuth } = useTranslation('auth')`): her çağrı kendi adıyla, kendisinden önceki en yakın bildirime bağlanır.
      const decls = [...text.matchAll(/\{\s*t(?:\s*:\s*(\w+))?[^}]*\}\s*=\s*useTranslation\(\s*\[?\s*['"](\w+)['"]/g)].map((u) => ({ at: u.index, name: u[1] ?? 't', ns: u[2] }));
      const nsAt = (name, i) => decls.filter((d) => d.name === name && d.at < i).pop()?.ns ?? decls.find((d) => d.name === name)?.ns ?? opt.defaultNs;
      const names = [...new Set(['t', ...decls.map((d) => d.name)])].join('|');
      const re = new RegExp(String.raw`(?:(?<![\w.])(${names})\(|(i18nKey)=)\s*['"]([\w.:-]+)['"]`, 'g');
      let m;
      while ((m = re.exec(text))) {
        const key = m[3];
        // `t('anahtar', { ns: 'shell' })`: açık ad alanı seçeneği bildirimden önceliklidir.
        const explicit = /^\s*,\s*\{[^}]*\bns:\s*['"](\w+)['"]/.exec(text.slice(re.lastIndex, re.lastIndex + 160))?.[1];
        const [prefix, rest] = key.includes(':') ? key.split(':') : [explicit ?? nsAt(m[1] ?? 't', m.index), key];
        // Bağlam (`anahtar_context`) ve çoğul sonekleri (`_one`/`_other`) varsa anahtar var sayılır.
        if (prefix && nsKeys[prefix] && !nsKeys[prefix].has(rest) && ![...nsKeys[prefix]].some((k) => k.startsWith(`${rest}_`))) usedMissing.push(`${rel(p)}: ${prefix}:${rest}`);
      }
      const re2 = /i18n\.t\(\s*['"]([\w.]+)['"],\s*\{\s*ns:\s*'(\w+)'/g;
      while ((m = re2.exec(text))) if (nsKeys[m[2]] && !nsKeys[m[2]].has(m[1])) usedMissing.push(`${rel(p)}: ${m[2]}:${m[1]}`);
    });
  }
  for (const u of usedMissing) soft(`Kodda kullanılan anahtar JSON'da yok: ${u}`);

  log.log(`anahtar hatası: ${errors}, kodda kalan Türkçe satır: ${left}`);
  return { code: errors ? 1 : 0, errors, left };
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)).code);
}
