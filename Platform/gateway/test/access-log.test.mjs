// Jeton günlüğe ve Referer'a düşmez (denetim 04-B2). Docker gerekmez: yapılandırma dosyaları okunur, nginx eşlemeleri burada
// aynı düzenli ifadelerle yeniden kurulur. Canlı sınama: gateway/test/run.sh ("günlükte jeton yok", "referrer no-referrer").
// Kullanım (Platform içinde): node --test gateway/test/access-log.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = path.resolve(PLATFORM, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

const SHARED = 'Platform/gateway/conf/access-log.conf';
const SHARED_IN_IMAGE = '/etc/nginx/conf.d/00-access-log.conf';

/** Jetonlu adresi istek satırında taşıyabilen her nginx sunucusu: yapılandırması, Dockerfile'ı, ortak dosyanın kaynak yolu ve dockerignore'u. */
const SERVERS = [
  { name: 'gateway', conf: 'Platform/gateway/conf/default.conf', dockerfile: 'Platform/gateway/Dockerfile', copyFrom: 'conf/access-log.conf' },
  {
    name: 'hub-web',
    conf: 'Platform/apps/hub-web/nginx.conf',
    dockerfile: 'Platform/apps/hub-web/Dockerfile',
    copyFrom: SHARED,
    dockerignore: 'Platform/apps/hub-web/Dockerfile.dockerignore',
  },
  {
    name: 'deciship-web',
    conf: 'Deciship/apps/web/nginx.conf',
    dockerfile: 'Deciship/apps/web/Dockerfile',
    copyFrom: SHARED,
    dockerignore: 'Deciship/apps/web/Dockerfile.dockerignore',
  },
];

const stripComments = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');

/** nginx `map` bloğunu okur: [{ re, value }] ve varsayılan. `~*` harf duyarsız, `~` duyarlı. */
function parseMap(conf, variable) {
  const block = stripComments(conf).match(new RegExp(`map\\s+("[^"]*"|\\S+)\\s+\\$${variable}\\s*\\{([^}]*)\\}`));
  assert.ok(block, `map $${variable} bulunamadı`);
  const rules = [];
  let fallback;
  for (const raw of block[2].split(';')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    assert.ok(m, `çözülemeyen map satırı: ${line}`);
    const value = m[2].replace(/^"|"$/g, '');
    if (m[1] === 'default') fallback = value;
    else if (m[1].startsWith('~*')) rules.push({ re: new RegExp(m[1].slice(2), 'i'), value });
    else if (m[1].startsWith('~')) rules.push({ re: new RegExp(m[1].slice(1)), value });
    else rules.push({ exact: m[1].replace(/^"|"$/g, ''), value });
  }
  return { rules, fallback };
}

/** nginx gibi: ilk eşleşen düzenli ifade kazanır, adlı yakalamalar değere `$ad` olarak yazılır. */
function evalMap({ rules, fallback }, input, vars = {}) {
  const fill = (value, groups = {}) => value.replace(/\$(\w+)/g, (_, k) => groups[k] ?? vars[k] ?? `$${k}`);
  for (const r of rules) {
    if (r.exact !== undefined) {
      if (r.exact === input) return fill(r.value);
      continue;
    }
    const m = r.re.exec(input);
    if (m) return fill(r.value, m.groups);
  }
  return fill(fallback, {});
}

const shared = read(SHARED);
const logMap = parseMap(shared, 'sod_log_uri');
const logUri = (uri) => evalMap(logMap, uri, { request_uri: uri });

test('ortak günlük biçimi: istek satırı yalnız maskeli yolla, Referer ve ham istek yok', () => {
  const fmt = stripComments(shared).match(/log_format\s+sod\s+([\s\S]*?);/);
  assert.ok(fmt, 'log_format sod yok');
  assert.match(fmt[1], /\$sod_log_uri/);
  for (const raw of ['$request ', '$request"', '$request_uri', '$http_referer', '$uri', '$args', '$query_string']) {
    assert.ok(!fmt[1].includes(raw), `log_format sod ${raw.trim()} yazıyor: jeton günlüğe düşer`);
  }
});

test('jetonlu yollar maskelenir (harf ve çift eğik çizgi dahil), diğerleri olduğu gibi', () => {
  const cases = [
    ['/reset-password/SAHTE-JETON-123', '/reset-password/[gizli]'],
    ['/reset-password/SAHTE-JETON-123?lang=en', '/reset-password/[gizli]'],
    ['/invite/abc.def', '/invite/[gizli]'],
    ['/verify-email/xyz', '/verify-email/[gizli]'],
    ['/RESET-PASSWORD/SAHTE', '/RESET-PASSWORD/[gizli]'],
    ['//invite/SAHTE', '/invite/[gizli]'],
    ['/api/account/invites/SAHTE/accept', '/api/account/invites/[gizli]'],
    // Kayıt daveti (kapalı deneme, 2026-11-12): jeton sorguda.
    ['/register?invite=SAHTE-DAVET&lang=en', '/register?[gizli]'],
    ['/REGISTER/?lang=tr&invite=SAHTE', '/REGISTER?[gizli]'],
    ['//register?invite=SAHTE', '/register?[gizli]'],
    ['/home', '/home'],
    ['/assets/index-abc.js', '/assets/index-abc.js'],
    ['/deciship/invoices?x=1', '/deciship/invoices?x=1'],
  ];
  for (const [uri, want] of cases) assert.equal(logUri(uri), want, uri);
  assert.equal(logUri('/register'), '/register');
  assert.equal(logUri('/registerx?invite=1'), '/registerx?invite=1', 'yalnız kayıt sayfası');
  for (const [uri] of cases.slice(0, 10)) assert.ok(!logUri(uri).includes('SAHTE') && !logUri(uri).includes('abc.def'), uri);
});

for (const s of SERVERS) {
  test(`${s.name}: erişim günlüğü ortak biçimle (sod), başka biçim yok; imaj ortak dosyayı conf.d'ye önce koyar`, () => {
    const conf = stripComments(read(s.conf));
    const logs = [...conf.matchAll(/^\s*access_log\s+([^;]+);/gm)].map((m) => m[1].trim().split(/\s+/));
    assert.ok(logs.length > 0, `${s.conf}: access_log yok (nginx varsayılanı "main" istek satırını ve Referer'ı ham yazar)`);
    for (const parts of logs) assert.ok(parts[0] === 'off' || parts[1] === 'sod', `${s.conf}: access_log ${parts.join(' ')} sod biçiminde değil`);
    assert.ok(!/^\s*log_format\s/m.test(conf), `${s.conf}: kendi log_format'ı var; biçim yalnız ${SHARED} içinde`);

    const dockerfile = stripComments(read(s.dockerfile));
    const copy = new RegExp(`^COPY\\s+${s.copyFrom.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+${SHARED_IN_IMAGE.replace(/[./]/g, '\\$&')}\\s*$`, 'm');
    assert.match(dockerfile, copy, `${s.dockerfile}: ${s.copyFrom} -> ${SHARED_IN_IMAGE} kopyalanmıyor`);
    if (s.dockerignore) assert.match(read(s.dockerignore), new RegExp(`^!${SHARED.replace(/[./]/g, '\\$&')}\\s*$`, 'm'), `${s.dockerignore}: ortak dosya derleme bağlamında yok`);
  });
}

test('gateway: Referrer-Policy jetonlu sayfada no-referrer, yukarı akış yalnız daha sıkısını geçirir', () => {
  const headers = stripComments(read('Platform/gateway/conf/security-headers.conf'));
  assert.match(headers, /^\s*add_header\s+Referrer-Policy\s+\$sod_referrer_policy\s+always;/m);
  assert.equal([...headers.matchAll(/add_header\s+Referrer-Policy/g)].length, 1, 'tek Referrer-Policy başlığı');
  const map = parseMap(read('Platform/gateway/conf/default.conf'), 'sod_referrer_policy');
  const policy = (uri, upstream = '') => evalMap(map, `${uri}|${upstream}`);
  for (const uri of ['/reset-password/SAHTE-JETON-123', '/invite/x', '/verify-email/x?y=1', '/Reset-Password/x', '//invite/x', '/register?invite=SAHTE', '/register', '/Register/?invite=x']) {
    assert.equal(policy(uri), 'no-referrer', uri);
    assert.equal(policy(uri, 'unsafe-url'), 'no-referrer', `${uri}: yukarı akış gevşetemez`);
  }
  assert.equal(policy('/home'), 'strict-origin-when-cross-origin');
  assert.equal(policy('/registerx?a=1'), 'strict-origin-when-cross-origin', 'yalnız kayıt sayfası');
  assert.equal(policy('/home', 'unsafe-url'), 'strict-origin-when-cross-origin', 'gevşek yukarı akış politikası geçmez');
  assert.equal(policy('/home', 'no-referrer-when-downgrade'), 'strict-origin-when-cross-origin');
  assert.equal(policy('/api/deciship/files/x', 'no-referrer'), 'no-referrer', 'DeciShip dosya ucunun no-referrer başlığı korunur');
  assert.equal(policy('/api/x', 'same-origin'), 'same-origin');
  // Yukarı akışın başlığı gizlenir, yerine bu değişken yazılır: iki başlık gitmez.
  assert.match(stripComments(read('Platform/gateway/conf/proxy.conf')), /^\s*proxy_hide_header\s+Referrer-Policy;/m);
});

test('hub-web: jetonlu sayfa kendisi de no-referrer gönderir ve hata günlüğüne istek satırı yazmaz', () => {
  const conf = stripComments(read('Platform/apps/hub-web/nginx.conf'));
  const loc = conf.match(/location\s+~\*\s+\^\/\(invite\|reset-password\|verify-email\)\/\s*\{([^}]*)\}/);
  assert.ok(loc, 'jetonlu yollar için location yok');
  assert.match(loc[1], /add_header\s+Referrer-Policy\s+"no-referrer"\s+always;/);
  assert.match(loc[1], /error_log\s+\S+\s+crit;/);
  assert.match(loc[1], /try_files\s+\/index\.html/);
});

test('hub-web: kayıt sayfası (davet jetonu sorguda) no-referrer gönderir ve hata günlüğüne istek satırı yazmaz', () => {
  const conf = stripComments(read('Platform/apps/hub-web/nginx.conf'));
  const loc = conf.match(/location\s+~\*\s+\^\/\+register\/\?\$\s*\{([^}]*)\}/);
  assert.ok(loc, 'kayıt sayfası için location yok');
  assert.match(loc[1], /add_header\s+Referrer-Policy\s+"no-referrer"\s+always;/);
  assert.match(loc[1], /error_log\s+\S+\s+crit;/);
  assert.match(loc[1], /try_files\s+\/index\.html/);
});
