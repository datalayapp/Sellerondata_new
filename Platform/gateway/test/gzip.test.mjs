// Gateway sıkıştırma sözleşmesi (KALANLAR 3.6). Docker gerekmez: yapılandırma metin olarak okunur.
// Canlı sınama: gateway/test/run.sh ("sıkıştırma"). Kullanım (Platform içinde): node --test gateway/test/gzip.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(PLATFORM, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');

const GZIP = stripComments(read('gateway/conf/gzip.conf'));
const DOCKERFILE = read('gateway/Dockerfile');
const DEFAULT = read('gateway/conf/default.conf');
const PRODUCT_DIR = 'gateway/conf/products';
const PRODUCTS = readdirSync(path.join(PLATFORM, PRODUCT_DIR))
  .filter((f) => f.endsWith('.conf'))
  .map((f) => read(`${PRODUCT_DIR}/${f}`));

/** `location` blokları (iç içe konum yok): başlık ve gövde. */
function locations(text) {
  const src = stripComments(text);
  const out = [];
  const re = /\blocation\s+([^{;]+?)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push({ head: m[1].trim(), body: src.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const directive = (name) => new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm').exec(GZIP)?.[1].trim();
const TYPES = new Set((directive('gzip_types') ?? '').split(/\s+/));

test("imaj gzip.conf'u http düzeyine koyar", () => {
  assert.match(DOCKERFILE, /^COPY conf\/gzip\.conf \/etc\/nginx\/conf\.d\/[\w-]+\.conf$/m);
  // server bloğu ya da konum değil: conf.d altında http bağlamında okunur.
  assert.doesNotMatch(GZIP, /\b(server|location)\b/);
});

test('sıkıştırma açık; vekil arkasında da; Vary yazılır; küçük yanıt sıkıştırılmaz', () => {
  assert.equal(directive('gzip'), 'on');
  assert.equal(directive('gzip_proxied'), 'any', 'Caddy arkasında istek Via taşırsa sıkıştırma kapanırdı');
  assert.equal(directive('gzip_vary'), 'on', 'Vary: Accept-Encoding yok: ara önbellek sıkıştırılmışı sıkıştırmasız istemciye verebilir');
  const min = Number(directive('gzip_min_length'));
  assert.ok(min >= 256 && min <= 4096, `gzip_min_length ${min}`);
  const level = Number(directive('gzip_comp_level'));
  assert.ok(level >= 1 && level <= 6, `gzip_comp_level ${level}: yüksek düzey küçük kapta işlemci yer, kazanç az`);
});

test('metin türleri sıkıştırılır; zaten sıkıştırılmış ve akış yanıtları listede yok', () => {
  for (const t of ['application/json', 'application/javascript', 'text/javascript', 'text/css', 'image/svg+xml', 'text/plain', 'text/csv']) {
    assert.ok(TYPES.has(t), `${t} sıkıştırılmıyor`);
  }
  for (const t of [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/zip',
    'application/gzip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
    'font/woff2',
    'text/event-stream',
    '*',
  ]) {
    assert.ok(!TYPES.has(t), `${t} sıkıştırılmamalı`);
  }
  // text/html nginx'te hep sayılır; listede yazılırsa nginx "duplicate MIME type" uyarısı verir.
  assert.ok(!TYPES.has('text/html'));
});

test("BREACH: Hesap API'sinin her konumu sıkıştırmayı kapatır; hiçbir konum sıkıştırmayı kendisi açmaz", () => {
  const all = [DEFAULT, ...PRODUCTS].flatMap(locations);
  const account = all.filter((l) => /proxy_pass\s+\$account_api;/.test(l.body));
  assert.ok(account.length >= 3, 'Hesap konumları bulunamadı');
  for (const l of account) assert.match(l.body, /^\s*gzip\s+off;/m, `location ${l.head}: Hesap yanıtı sıkıştırılıyor`);
  for (const l of all) assert.doesNotMatch(l.body, /^\s*gzip\s+on;/m, `location ${l.head}: gzip kural dosyası dışında açılıyor`);
  // Hesap yoluna giden başka konum (ör. araç dosyasında /api/account/...) olmamalı: kural yalnız default.conf'ta.
  for (const p of PRODUCTS) assert.doesNotMatch(p, /\/api\/account\//);
});
