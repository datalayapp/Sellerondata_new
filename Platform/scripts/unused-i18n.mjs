#!/usr/bin/env node
/**
 * Kullanılmayan sözlük anahtarlarını bulur (Y128). Bağımlılıksız. `check-i18n.mjs` eksik anahtarı arar; bu betik tersini.
 *
 *   node Platform/scripts/unused-i18n.mjs                  özet + kesin kullanılmayanlar
 *   node Platform/scripts/unused-i18n.mjs --all            şüphelileri de nedenleriyle listeler
 *   node Platform/scripts/unused-i18n.mjs --json           makine için
 *   node Platform/scripts/unused-i18n.mjs --surface panel  tek yüzey (panel, hub, mobile, shell)
 *   node Platform/scripts/unused-i18n.mjs --delete         kesin kullanılmayanları TR ve EN'den siler (aşağıdaki koşullarla)
 *
 * Bir anahtar üç gruptan birine girer:
 *   used     tam yolu (ya da `ns:yol`, çoğul/bağlam sonekinden önceki kökü) kaynakta bir sözcük olarak geçiyor.
 *   dynamic  tam yolu geçmiyor ama kurulabilir: `t(\`durum.${x}\`)` gibi şablonun kalıbına uyuyor, `'durum.' + x` gibi
 *            bir önek/sonek parçası (`durum.`, `.baslik`, `sayi_`) yoluna uyuyor ya da en az iki düzeyli bir atası
 *            (`a.b`, returnObjects / alt ağaç geçirme) kaynakta geçiyor. Bunlar silinmez; elle bakılır.
 *   unused   hiçbiri yok.
 * Kaynak: Platform ve Deciship altındaki bütün uygulama ve paketler (yalnız sözlüğün kendi yüzeyi değil; API'nin
 * gönderdiği anahtar da sayılsın), testler, sahte veri ve yorumlar dahil: geçtiği her yer "kullanılıyor" sayılır.
 * Yanılma yönü bilerek "kullanılıyor"dur: bu betik bir anahtarı ancak hiçbir izi yoksa "unused" der.
 *
 * `--delete` yalnız "unused" olanları siler, şu anahtarlara dokunmaz: yolunda `ai`, `quota` ya da `usage` geçen (büyük/küçük
 * harf fark etmez; başka işlerin yeni anahtarları), son commit'te (git HEAD) olmayan (yeni eklenmiş), TR ve EN'nin ikisinde
 * birden olmayan. Dosya `JSON.stringify(x, null, 2)` biçiminde değilse dokunulmaz (yalnız silinen satırlar değişsin). Dosya
 * yazmadan hemen önce yeniden okunur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SURFACES = {
  panel: 'Deciship/apps/web/src/locales',
  hub: 'Platform/apps/hub-web/src/locales',
  mobile: 'Deciship/apps/mobile/src/locales',
  shell: 'Platform/packages/shell/src/locales',
};
const CORPUS = ['Platform/apps', 'Platform/packages', 'Platform/scripts', 'Platform/e2e', 'Platform/infra', 'Deciship/apps', 'Deciship/packages', 'Deciship/services'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.expo', 'android', 'ios', 'locales', 'test-results', 'playwright-report', '.tmp', '.vite', 'storage', '__pycache__', '.venv', 'venv']);
const SRC_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts|html|json|prisma|sql|py)$/;
const SKIP_FILE = /^(package(-lock)?\.json|tsconfig.*\.json)$/;
/** Betiğin kendisi ve testi kaynak sayılmaz (örnek anahtarlar "kullanılıyor" görünmesin). */
const SELF = /^unused-i18n(\.test)?\.mjs$/;
const PROTECT = /ai|quota|usage/i;
const PLURAL = /_(zero|one|two|few|many|other)$/;

const readJson = (f) => {
  const s = fs.readFileSync(f, 'utf8');
  return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
};
/** Yaprak anahtarlar; dizi yapraktır (returnObjects ile bütün okunur). */
const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]));

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), visit);
    } else if (SRC_EXT.test(e.name) && !SKIP_FILE.test(e.name) && !SELF.test(e.name)) visit(path.join(dir, e.name));
  }
}

/**
 * Kaynaktaki izler: `words` (anahtar olabilecek her sözcük: `a.b_c`, `ns:a.b`), önek/sonek parçaları ve şablon kalıpları.
 * Şablon `\`a.${x}.b\`` → /^a\.[\w.-]*\.b$/; sabit kısmında en az iki harf yoksa (`${a}.${b}`) kalıp sayılmaz.
 */
export function scanCorpus(roots = CORPUS) {
  const words = new Set();
  const quoted = new Set();
  const prefixes = new Set();
  const suffixes = new Set();
  const patterns = [];
  const files = [];
  for (const r of roots) walk(path.resolve(ROOT, r), (f) => files.push(f));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/'([\w.-]+)'|"([\w.-]+)"/g)) quoted.add(m[1] ?? m[2]);
    for (const w of text.match(/[\w.:-]+/g) ?? []) {
      words.add(w);
      const c = w.indexOf(':');
      if (c > 0) words.add(w.slice(c + 1));
      if (/^[A-Za-z][\w.-]*[._]$/.test(w)) prefixes.add(w);
      if (/^[._][A-Za-z][\w.-]*$/.test(w)) suffixes.add(w);
    }
    for (const m of text.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*\$\{(?:[^`\\]|\\.)*?)`/g)) {
      const parts = m[1].split(/\$\{[^}]*\}/);
      if (!/^[\w.:-]*$/.test(parts.join(''))) continue;
      // `ns:` öneki ad alanıdır, yolun parçası değil: `\`ns:${x}\`` kalıp sayılmaz (her anahtara uyardı).
      if (/^\w+:/.test(parts[0])) parts[0] = parts[0].slice(parts[0].indexOf(':') + 1);
      if ((parts.join('').match(/[A-Za-z]/g) ?? []).length < 2 || parts.join('').includes(':')) continue;
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = parts.map(esc).join('[\\w.-]*');
      patterns.push(new RegExp(`^${body}$`));
    }
  }
  const loose = new Set();
  for (const w of words) for (const p of w.split(/[.:]/)) if (p) loose.add(p.toLowerCase().replace(/[-_]/g, ''));
  return { words, quoted, loose, prefixes: [...prefixes], suffixes: [...suffixes], patterns, files: files.length };
}

/** Anahtarın grubu ve nedeni. */
export function classify(ns, key, c) {
  const bases = [key];
  const last = key.slice(key.lastIndexOf('.') + 1);
  for (let i = last.indexOf('_'); i > 0; i = last.indexOf('_', i + 1)) bases.push(key.slice(0, key.length - last.length + i));
  if (PLURAL.test(key)) bases.push(key.replace(PLURAL, ''));
  for (const b of bases) if (c.words.has(b) || c.words.has(`${ns}:${b}`)) return { group: 'used', why: b === key ? 'tam yol' : `kök ${b}` };
  const pats = c.patterns.filter((re) => re.test(key));
  if (pats.length) {
    // Şablonun değişken kısmına düşen sözcükler (`errors.${code}` için `NOT_FOUND`) kaynakta hiç geçmiyorsa (büyük/küçük
    // harf, `-`/`_` farkı gözetmeden) anahtar büyük olasılıkla artık kurulmuyor: "orphan" işareti, yine silinmez.
    const fill = (re) => {
      const lit = re.source.slice(1, -1).split('[\\w.-]*').map((s) => s.replace(/\\(.)/g, '$1'));
      let rest = key.replace(PLURAL, '');
      if (lit[0]) rest = rest.slice(lit[0].length);
      const tail = lit[lit.length - 1];
      if (lit.length > 1 && tail) rest = rest.slice(0, rest.length - tail.length);
      return rest.split(/[.]/).filter(Boolean);
    };
    const orphan = pats.every((re) => fill(re).some((w) => !c.loose.has(w.toLowerCase().replace(/[-_]/g, ''))));
    return { group: 'dynamic', why: `şablon ${pats[0].source}`, orphan };
  }
  const pre = c.prefixes.find((p) => key.startsWith(p) && key.length > p.length);
  if (pre) return { group: 'dynamic', why: `önek '${pre}'` };
  const suf = c.suffixes.find((s) => key.endsWith(s) && key.length > s.length);
  if (suf) return { group: 'dynamic', why: `sonek '${suf}'` };
  const segs = key.split('.');
  for (let i = segs.length - 1; i >= 1; i--) {
    const anc = segs.slice(0, i).join('.');
    if (!c.words.has(anc)) continue;
    if (i >= 2) return { group: 'dynamic', why: `ata '${anc}'` };
    // Parçalı kurulum: `lazyLabels('dimMethod', ['LIDAR'])` → `${prefix}.${k}`. Ata da geri kalan her parça da
    // kaynakta geçiyorsa anahtar kurulabilir sayılır.
    // İkisi de tırnaklı dizge olarak geçmeli (yalnız tanımlayıcı olarak geçen `home`, `top` sayılmaz).
    if (c.quoted.has(anc) && segs.slice(i).every((w) => c.quoted.has(w))) return { group: 'dynamic', why: `parçalı '${anc}' + '${segs.slice(i).join('.')}'` };
  }
  return { group: 'unused', why: '' };
}

function gitKeys(relFile) {
  try {
    const s = execFileSync('git', ['show', `HEAD:${relFile}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(flat(JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)));
  } catch {
    return new Set();
  }
}

/** Her yüzey ve ad alanı için anahtarların grubu. */
export function analyze(surfaces = Object.keys(SURFACES), corpus = scanCorpus()) {
  const out = [];
  for (const s of surfaces) {
    const dir = path.join(ROOT, SURFACES[s]);
    for (const f of fs.readdirSync(path.join(dir, 'tr')).filter((x) => x.endsWith('.json'))) {
      const ns = f.replace(/\.json$/, '');
      const tr = new Set(flat(readJson(path.join(dir, 'tr', f))));
      const enPath = path.join(dir, 'en', f);
      const en = fs.existsSync(enPath) ? new Set(flat(readJson(enPath))) : new Set();
      const head = gitKeys(`${SURFACES[s]}/tr/${f}`);
      for (const key of tr) {
        const r = classify(ns, key, corpus);
        let keep = '';
        if (r.group === 'unused') {
          if (PROTECT.test(key)) keep = 'korunan sözcük (ai/quota/usage)';
          else if (!head.has(key)) keep = "son commit'te yok (yeni)";
          else if (!en.has(key)) keep = "EN'de yok";
        }
        out.push({ surface: s, ns, key, ...r, keep });
      }
    }
  }
  return out;
}

/** `obj`'dan noktalı yolu siler; boşalan üst nesneleri de. */
function removePath(obj, key) {
  const segs = key.split('.');
  const stack = [obj];
  for (const s of segs.slice(0, -1)) {
    const next = stack[stack.length - 1]?.[s];
    if (!next || typeof next !== 'object') return false;
    stack.push(next);
  }
  const leaf = segs[segs.length - 1];
  if (!(leaf in stack[stack.length - 1])) return false;
  delete stack[stack.length - 1][leaf];
  for (let i = stack.length - 1; i > 0; i--) if (Object.keys(stack[i]).length === 0) delete stack[i - 1][segs[i - 1]];
  return true;
}

/** Bir sözlük dosyasından anahtarları siler; yalnız silinen satırlar (ve bir önceki satırın virgülü) değişir. */
export function deleteKeys(file, keys) {
  const raw = fs.readFileSync(file, 'utf8'); // yazmadan hemen önce yeniden okunur
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = raw.replace(/\r\n/g, '\n');
  const obj = JSON.parse(text);
  if (JSON.stringify(obj, null, 2) + '\n' !== text && JSON.stringify(obj, null, 2) !== text) return { file, skipped: 'biçim JSON.stringify(…, 2) değil' };
  const removed = keys.filter((k) => removePath(obj, k));
  if (!removed.length) return { file, removed: [] };
  const trail = text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, (JSON.stringify(obj, null, 2) + trail).replace(/\n/g, eol), 'utf8');
  return { file, removed };
}

function main(argv) {
  const has = (f) => argv.includes(f);
  const surfIdx = argv.indexOf('--surface');
  const surfaces = surfIdx >= 0 ? argv[surfIdx + 1].split(',') : Object.keys(SURFACES);
  for (const s of surfaces) if (!SURFACES[s]) throw new Error(`bilinmeyen yüzey: ${s} (${Object.keys(SURFACES).join(', ')})`);
  const corpus = scanCorpus();
  const rows = analyze(surfaces, corpus);
  if (has('--json')) {
    console.log(JSON.stringify(rows.filter((r) => r.group !== 'used'), null, 2));
    return 0;
  }
  const by = (g) => rows.filter((r) => r.group === g);
  let del = by('unused').filter((r) => !r.keep);
  // Elle incelenmiş liste: her satır `yüzey ad-alanı:anahtar` (ör. `shell shell:top.menu`; `#` ile başlayan satır yorum).
  // "used" çıkan anahtar silinmez; korunan sözcük, yeni anahtar ve tek dilde olan kuralı burada da geçerlidir.
  const listIdx = argv.indexOf('--delete-list');
  if (listIdx >= 0) {
    const want = fs.readFileSync(argv[listIdx + 1], 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    del = [];
    for (const w of want) {
      const [surface, nsKey] = w.split(/\s+/);
      const [ns, key] = [nsKey.slice(0, nsKey.indexOf(':')), nsKey.slice(nsKey.indexOf(':') + 1)];
      const r = rows.find((x) => x.surface === surface && x.ns === ns && x.key === key);
      if (!r) console.log(`YOK     ${w}`);
      else if (r.group === 'used') console.log(`KULLANILIYOR, silinmedi ${w} (${r.why})`);
      else if (PROTECT.test(key)) console.log(`KORUNAN, silinmedi ${w}`);
      else if (r.keep) console.log(`KALIR   ${w} (${r.keep})`);
      else if (!gitKeys(`${SURFACES[surface]}/tr/${ns}.json`).has(key) || !gitKeys(`${SURFACES[surface]}/en/${ns}.json`).has(key)) console.log(`YENİ, silinmedi ${w}`);
      else del.push(r);
    }
  }
  if (has('--delete') || listIdx >= 0) {
    const groups = new Map();
    for (const r of del) {
      const id = `${r.surface}|${r.ns}`;
      if (!groups.has(id)) groups.set(id, { ...r, keys: [] });
      groups.get(id).keys.push(r.key);
    }
    let n = 0;
    for (const g of groups.values()) {
      for (const lng of ['tr', 'en']) {
        const res = deleteKeys(path.join(ROOT, SURFACES[g.surface], lng, `${g.ns}.json`), g.keys);
        if (res.skipped) console.log(`ATLANDI ${path.relative(ROOT, res.file)}: ${res.skipped}`);
        else n += res.removed.length;
      }
    }
    console.log(`silindi: ${n} satır (TR + EN)`);
    return 0;
  }
  console.log(`kaynak: ${corpus.files} dosya; anahtar: ${rows.length}, kullanılan ${by('used').length}, dinamik/şüpheli ${by('dynamic').length}, kullanılmayan ${by('unused').length} (silinebilir ${del.length})`);
  for (const r of by('unused')) console.log(`${r.keep ? 'KALIR ' : 'SİL   '} ${r.surface} ${r.ns}:${r.key}${r.keep ? `  (${r.keep})` : ''}`);
  const orphans = by('dynamic').filter((r) => r.orphan);
  console.log(`dinamik ama değişken kısmı kaynakta hiç geçmeyen (elle bakın): ${orphans.length}`);
  for (const r of orphans) console.log(`YETİM  ${r.surface} ${r.ns}:${r.key}  (${r.why})`);
  if (has('--all')) for (const r of by('dynamic').filter((x) => !x.orphan)) console.log(`ŞÜPHE  ${r.surface} ${r.ns}:${r.key}  (${r.why})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
