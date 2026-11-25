// Gateway hız sınırı sözleşmesi (KALANLAR 6.15). Docker gerekmez: yapılandırma dosyaları metin olarak okunur, kimlik uçları
// eşlemesi burada aynı düzenli ifadeyle yeniden kurulur. Canlı sınama: gateway/test/run.sh ("hız sınırı", "kimlik uçları").
// Kullanım (Platform içinde): node --test gateway/test/rate-limits.test.mjs
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

const LIMITS = read('gateway/templates/20-limits.conf.template');
const INC = read('gateway/templates/api-limits.inc.template');
const CONN = read('gateway/templates/conn-limit.inc.template');
const DEFAULT = read('gateway/conf/default.conf');
const DOCKERFILE = read('gateway/Dockerfile');
const COMPOSE = read('docker-compose.yml');
const E2E_ENV = read('e2e/.env.e2e');
const PRODUCT_DIR = 'gateway/conf/products';
const PRODUCT_FILES = readdirSync(path.join(PLATFORM, PRODUCT_DIR))
  .filter((f) => f.endsWith('.conf'))
  .map((f) => `${PRODUCT_DIR}/${f}`);

const templateVars = (text) => [...new Set([...text.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]))];

/** Dockerfile `ENV A=1 B=2 ...` satırları. */
function dockerEnv() {
  const env = {};
  for (const m of DOCKERFILE.matchAll(/^ENV\s+(.+)$/gm)) {
    for (const pair of m[1].trim().split(/\s+/)) {
      const [k, ...v] = pair.split('=');
      env[k] = v.join('=');
    }
  }
  return env;
}

/** docker-compose.yml gateway servisinin `environment` girdileri: ad → `${AD:-varsayılan}` içindeki varsayılan. */
function composeGatewayEnv() {
  const block = /\n  gateway:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|\n[a-z]|$)/.exec(COMPOSE)?.[1];
  assert.ok(block, 'docker-compose.yml: gateway servisi yok');
  const env = {};
  for (const m of block.matchAll(/^\s{6}(\w+):\s*\$\{(\w+):-([^}]*)\}\s*$/gm)) {
    assert.equal(m[1], m[2], `compose gateway: ${m[1]} başka değişkenden okunuyor (${m[2]})`);
    env[m[1]] = m[3];
  }
  return env;
}

const envFile = (text) => Object.fromEntries([...text.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));

/** `30r/s` / `60r/m` → saniyede istek. */
function perSecond(rate) {
  const m = /^(\d+)r\/(s|m)$/.exec(rate);
  assert.ok(m, `oran okunamadı: ${rate}`);
  return Number(m[1]) / (m[2] === 'm' ? 60 : 1);
}

/** `map <kaynak> <hedef> { ... }` bloğunun satırları. */
function mapEntries(text, target) {
  const m = new RegExp(`map\\s+\\S+\\s+\\$${target}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(stripComments(text));
  assert.ok(m, `map $${target} bulunamadı`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const e = /^(\S+)\s+(.+);$/.exec(l);
      assert.ok(e, `map satırı okunamadı: ${l}`);
      return { key: e[1], value: e[2] };
    });
}

/** Kimlik uçları eşlemesi (nginx `~*` = harf duyarsız PCRE; buradaki ifadeler JS'te de aynı anlamdadır). */
function authRoute(uri) {
  for (const { key, value } of mapEntries(LIMITS, 'sod_auth_route')) {
    if (key === 'default') continue;
    assert.ok(key.startsWith('~*'), `kimlik eşlemesi harf duyarsız olmalı: ${key}`);
    if (new RegExp(key.slice(2), 'i').test(uri)) return value === '1';
  }
  return false;
}

/** Yapılandırmadaki `location` blokları (iç içe konum yok): başlık ve gövde. */
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

const ALL_LOCATIONS = [DEFAULT, ...PRODUCT_FILES.map(read)].flatMap(locations);

test('her şablon değişkeninin Dockerfile ve compose varsayılanı var ve ikisi aynı', () => {
  const vars = [...templateVars(LIMITS), ...templateVars(INC), ...templateVars(CONN), ...templateVars(read('gateway/templates/10-real-ip.conf.template'))];
  assert.ok(vars.includes('GATEWAY_AUTH_RATE') && vars.includes('GATEWAY_AUTH_BURST'), 'kimlik kovası değişkenleri şablonda yok');
  const docker = dockerEnv();
  const compose = composeGatewayEnv();
  for (const v of new Set(vars)) {
    assert.ok(docker[v], `Dockerfile ENV'de ${v} yok: şablon açılışta "\${${v}}" olarak kalır, nginx açılmaz`);
    assert.equal(compose[v], docker[v], `${v}: compose varsayılanı (${compose[v]}) Dockerfile'dakinden (${docker[v]}) farklı`);
  }
});

test('sınırlar makul aralıkta: kimlik kovası sıkı, genel API ve yükleme onun üstünde', () => {
  const d = dockerEnv();
  assert.ok(perSecond(d.GATEWAY_AUTH_RATE) < perSecond(d.GATEWAY_API_RATE), 'kimlik kovası genel API kovasından gevşek');
  assert.ok(perSecond(d.GATEWAY_AUTH_RATE) <= 1, 'kimlik kovası saniyede 1 denemeden gevşek: kaba kuvvete set değil');
  // Depo Wi-Fi'ı: vardiya başında aynı IP'den çok kişi girer. Birikme en az birkaç düzine giriş taşımalı.
  assert.ok(Number(d.GATEWAY_AUTH_BURST) >= 20, 'kimlik birikmesi depodaki toplu girişe yetmez');
  assert.ok(Number(d.GATEWAY_API_BURST) > Number(d.GATEWAY_AUTH_BURST));
});

test('uçtan uca yığın üretim sınırlarına takılmaz: her oran ve birikme üretimdekinden geniş', () => {
  const d = dockerEnv();
  const e = envFile(E2E_ENV);
  for (const k of ['API', 'UPLOAD', 'AUTH']) {
    assert.ok(e[`GATEWAY_${k}_RATE`], `e2e/.env.e2e GATEWAY_${k}_RATE vermiyor: testler tek IP'den üretim sınırına takılır`);
    assert.ok(perSecond(e[`GATEWAY_${k}_RATE`]) > perSecond(d[`GATEWAY_${k}_RATE`]), `e2e GATEWAY_${k}_RATE üretimdekinden geniş değil`);
    assert.ok(Number(e[`GATEWAY_${k}_BURST`]) > Number(d[`GATEWAY_${k}_BURST`]), `e2e GATEWAY_${k}_BURST üretimdekinden geniş değil`);
  }
});

test('kimlik uçları: şifre, kod ve jeton deneyen uçlar sıkı kovada; yazım oyunu kaçırmaz', () => {
  for (const uri of [
    '/api/account/auth/login',
    '/api/account/auth/register',
    '/api/account/auth/forgot-password',
    '/api/account/auth/reset-password',
    '/api/account/auth/verify-email',
    '/api/account/auth/resend-verification',
    '/api/account/auth/join/preview',
    '/api/account/auth/join/accept',
    '/api/account/invites/abc',
    '/api/account/invites/abc/accept',
    '/api/account/auth/LOGIN',
    '/api/account/auth/login/',
    '/api/account/auth/Join/Accept',
  ]) {
    assert.equal(authRoute(uri), true, `${uri} kimlik kovasında değil`);
  }
});

test('kimlik kovası dışı: sık çağrılan oturum uçları, genel API, ölçüm, başka aracın aynı adlı yolu', () => {
  for (const uri of [
    '/api/account/auth/refresh',
    '/api/account/auth/site-session',
    '/api/account/auth/logout',
    '/api/account/auth/switch-org',
    '/api/account/me',
    '/api/account/me/password',
    '/api/account/health',
    '/api/account/auth/loginx',
    '/api/account/auth/login/extra',
    '/api/deciship/measurements',
    '/api/deciship/auth/login',
    '/login',
    '/invite/abc',
  ]) {
    assert.equal(authRoute(uri), false, `${uri} kimlik kovasına girmemeli`);
  }
});

test('kovaların anahtarı gerçek istemci IP: istemcinin başlığı değil; kimlik ve yükleme anahtarı boşsa sayılmaz', () => {
  const src = stripComments(LIMITS);
  const zones = [...src.matchAll(/limit_req_zone\s+(\S+)\s+zone=(\w+):/g)].map((m) => ({ key: m[1], zone: m[2] }));
  assert.deepEqual(zones.map((z) => z.zone).sort(), ['sod_api', 'sod_auth', 'sod_upload']);
  assert.equal(zones.find((z) => z.zone === 'sod_api').key, '$binary_remote_addr');
  assert.equal(zones.find((z) => z.zone === 'sod_auth').key, '$sod_auth_key');
  assert.doesNotMatch(src, /\$http_x_forwarded_for|\$http_x_real_ip/i, 'kova anahtarı istemcinin yazdığı başlıktan');
  const key = mapEntries(LIMITS, 'sod_auth_key');
  assert.deepEqual(key, [
    { key: 'default', value: '""' },
    { key: '1', value: '$binary_remote_addr' },
  ]);
  // Gerçek IP yalnız güvenilen vekilden (KALANLAR 3.2: Caddy'nin adresi GATEWAY_REAL_IP_FROM'a yazılır).
  const realIp = stripComments(read('gateway/templates/10-real-ip.conf.template'));
  assert.match(realIp, /set_real_ip_from\s+\$\{GATEWAY_REAL_IP_FROM\};/);
  assert.match(realIp, /real_ip_header\s+X-Forwarded-For;/);
});

test('bağlantı sınırı sunucu düzeyinde de: web sayfası ve statik dosya yavaş istemciye karşı IP başına sınırlı', () => {
  // Yavaş gövde ya da yavaş okuma: sınır yalnız /api/'de olsaydı tek istemci web yollarında gateway'in bağlantılarını tüketirdi.
  assert.match(stripComments(CONN), /^\s*limit_conn\s+sod_conn\s+\$\{GATEWAY_CONN_PER_IP\};\s*$/m);
  const server = stripComments(DEFAULT).split(/\n\s*location\b/)[0];
  assert.match(server, /^\s*include \/etc\/nginx\/conf\.d\/conn-limit\.inc;$/m, 'default.conf server bloğu conn-limit.inc almıyor');
  // worker_connections varsayılanı (1024) yükseltilir; satır imajda yoksa derleme durur.
  assert.match(DOCKERFILE, /worker_connections 4096;[\s\S]*grep -qE/);
});

test('api-limits.inc üç kovayı ve bağlantı sınırını uygular', () => {
  const src = stripComments(INC);
  for (const zone of ['sod_api', 'sod_upload', 'sod_auth']) {
    assert.match(src, new RegExp(`limit_req\\s+zone=${zone}\\s+burst=\\$\\{\\w+\\}\\s+nodelay;`), `${zone} uygulanmıyor`);
  }
  assert.match(src, /limit_conn\s+sod_conn\s+\$\{GATEWAY_CONN_PER_IP\};/);
});

test('her API konumu sınırı alır; sağlık uçları ve statik/web konumları almaz', () => {
  const INCLUDE = 'include /etc/nginx/conf.d/api-limits.inc;';
  // Hesap, yapay zekâ geçidi (ai_api) ve araç API'leri.
  const apiProxies = ALL_LOCATIONS.filter((l) => /proxy_pass\s+\$(account_api|ai_api|sod_p_\w+_api);/.test(l.body));
  assert.ok(apiProxies.some((l) => l.head === '/api/ai/') && apiProxies.some((l) => l.head === '= /api/ai/health'), 'yapay zekâ geçidi konumları bulunamadı');
  assert.ok(apiProxies.length >= 4, 'API konumları bulunamadı');
  for (const l of apiProxies) {
    const health = /^=\s*\/api\/[\w-]+\/health$/.test(l.head);
    assert.equal(l.body.includes(INCLUDE), !health, `location ${l.head}: ${health ? 'sağlık ucu sınırlanmamalı' : 'hız sınırı yok'}`);
  }
  for (const l of ALL_LOCATIONS.filter((x) => !apiProxies.includes(x))) {
    assert.ok(!l.body.includes(INCLUDE), `location ${l.head}: API dışı konum hız sınırı almamalı (statik dosya, web sayfası)`);
  }
});

test('429 yanıtı: JSON hata gövdesi, kod eşlemeden, Retry-After; yukarı akışın 429u olduğu gibi geçer', () => {
  const src = stripComments(DEFAULT);
  assert.match(src, /^\s*error_page\s+429\s*=\s*@ratelimited;/m);
  const rl = locations(DEFAULT).find((l) => l.head === '@ratelimited');
  assert.ok(rl, '@ratelimited yok');
  assert.match(rl.body, /default_type\s+application\/json;/);
  assert.match(rl.body, /add_header\s+Retry-After\s+"\d+"\s+always;/);
  assert.match(rl.body, /add_header\s+Cache-Control\s+"no-store"\s+always;/);
  assert.match(rl.body, /return\s+429\s+'\{"error":\{"code":"\$sod_rl_code"\}\}';/);
  // Konum kendi error_page'ini yazarsa sunucu düzeyindekileri devralmaz: 429 düz nginx sayfasına düşerdi.
  for (const l of ALL_LOCATIONS) assert.doesNotMatch(l.body, /\berror_page\b/, `location ${l.head}: error_page sunucu düzeyini ezer`);
  // Yukarı akışın kendi 429'u (Hesap TOO_MANY_ATTEMPTS + kendi Retry-After'ı) gateway'in gövdesiyle değişmemeli.
  assert.doesNotMatch([DEFAULT, ...PRODUCT_FILES.map(read)].join('\n'), /proxy_intercept_errors\s+on/);
  const codes = mapEntries(LIMITS, 'sod_rl_code');
  assert.deepEqual(codes, [
    { key: 'default', value: 'TOO_MANY_REQUESTS' },
    { key: '1', value: 'TOO_MANY_ATTEMPTS' },
  ]);
  // TOO_MANY_ATTEMPTS ortak sözleşmede: Merkez ve mobil giriş ekranları bu kodla "N dakika sonra" yazar.
  assert.match(read('packages/contracts/src/errors.ts'), /'TOO_MANY_ATTEMPTS'/);
});

test("yükleme kovası depo NAT'ına yeter: IP başına oran, DeciShip API'nin firma yükleme + okuma sınırları toplamından düşük değil", () => {
  // Depodaki bütün telefonlar tek dış IP'den gelir; ölçüm gönderimi ve canlı tartı/işaret okuması (ikisi de multipart) aynı kovayı
  // doldurur. Asıl sınır API'de kişi ve firma başınadır (Deciship/apps/api/src/lib/rateLimit.ts): gateway onun önüne geçmemeli.
  const d = dockerEnv();
  const orgDefault = (name) => {
    const m = new RegExp(`\\b${name}: \\$\\{${name}:-(\\d+)\\}`).exec(COMPOSE);
    assert.ok(m, `docker-compose.yml: ${name} varsayılanı yok`);
    return Number(m[1]);
  };
  const apiOrgPerMin = orgDefault('RATE_UPLOAD_PER_MIN_ORG') + orgDefault('RATE_VISION_PER_MIN_ORG');
  assert.ok(
    perSecond(d.GATEWAY_UPLOAD_RATE) * 60 >= apiOrgPerMin,
    `GATEWAY_UPLOAD_RATE (${d.GATEWAY_UPLOAD_RATE}) API firma sınırları toplamının (${apiOrgPerMin}/dk) altında`,
  );
  // Çevrimdışı kuyruk açılınca birikmiş gönderim patlamalı gelir: birikme en az firmanın bir dakikalık yükleme hakkı kadar.
  assert.ok(Number(d.GATEWAY_UPLOAD_BURST) >= orgDefault('RATE_UPLOAD_PER_MIN_ORG'), 'yükleme birikmesi kuyruk boşalmasına yetmez');
  // Eşzamanlı bağlantı: 10 telefon (yükleme + okuma + liste) ve birkaç panel sekmesi aynı IP'den.
  assert.ok(Number(d.GATEWAY_CONN_PER_IP) >= 100, 'IP başına eşzamanlı bağlantı depo ağına dar');
});

test('olay akışı (SSE, TagPress /api/tagpress/events): yukarı akışın X-Accel-Buffering başlığı yok sayılmaz; okuma süresi kalp atışını aşar', () => {
  // TagPress olay akışı yanıtı `X-Accel-Buffering: no` gönderir ve 25 sn'de bir kalp atışı yazar (plan §2.6). Gateway başlığı
  // yok sayarsa (proxy_ignore_headers) ya da konum tamponu zorla açıp kapatırsa olaylar birikerek gelir.
  const all = [DEFAULT, read('gateway/conf/proxy.conf'), ...PRODUCT_FILES.map(read)].map(stripComments).join('\n');
  assert.doesNotMatch(all, /proxy_ignore_headers[^;]*X-Accel-Buffering/i, 'X-Accel-Buffering yok sayılıyor');
  assert.doesNotMatch(all, /proxy_ignore_headers[^;]*X-Accel-\*/i);
  assert.doesNotMatch(all, /proxy_pass_header\s+X-Accel-Buffering/i, 'iç başlık istemciye geçiyor');
  const api = ALL_LOCATIONS.find((l) => l.head === '/api/tagpress/');
  assert.ok(api, 'location /api/tagpress/ yok (üretilmiş conf)');
  const readTimeout = Number(/proxy_read_timeout\s+(\d+)s;/.exec(api.body)?.[1]);
  assert.ok(readTimeout >= 2 * 25, `proxy_read_timeout ${readTimeout} sn: 25 sn'lik kalp atışının iki katından kısa (akış kopar)`);
  assert.match(api.body, /client_max_body_size\s+50m;/, 'TagPress gövde sınırı 50 MB değil');
});
