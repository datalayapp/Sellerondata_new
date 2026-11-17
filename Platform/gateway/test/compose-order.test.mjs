// node --test gateway/test/compose-order.test.mjs   (Platform klasöründen; Docker gerekmez, yalnız dosyaları okur)
// Açılış sırası sözleşmesi (Y149): docker-compose.yml `depends_on` zinciri ve gateway'in ürün servisleri olmadan da
// açılabilmesi. Gerçek açılışı `gateway/test/run.sh` (Docker) dener; bu test sırayı bozan değişikliği Docker'sız yakalar.
// İşletme (KALANLAR 3.4): her kabın günlüğü dönüşümlü, uzun iş bekleyen servislerin kapanış süresi, sağlık denetimlerinin biçimi.
// Üretim kenarı (KALANLAR 3.2): dışa yalnız Caddy açılır, gateway yalnız Caddy'nin sabit adresine güvenir, HSTS tek değerde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(PLATFORM, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Compose dosyasının `services` bölümünden yalnız bu testin baktığı alanlar: servis adları, `depends_on` (harita ya da
 * liste biçimi; koşulsuz liste `service_started` sayılır) ve `healthcheck` var mı. Bağımlılıksız, girintiye dayalı.
 */
function parseServices(text) {
  const services = {};
  let inServices = false;
  let svc = null;
  let section = null; // 'depends_on' | null
  let dep = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      inServices = t === 'services:';
      svc = null;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const m = /^([a-z][\w-]*):$/.exec(t);
      assert.ok(m, `beklenmeyen satır: ${raw}`);
      svc = services[m[1]] = { dependsOn: {}, healthcheck: false, keys: [], values: {}, health: {} };
      section = null;
      continue;
    }
    if (!svc) continue;
    if (indent === 4) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(t);
      const key = kv?.[1];
      svc.keys.push(key);
      if (kv?.[2]) svc.values[key] = kv[2].replace(/^"(.*)"$/, '$1');
      if (key === 'healthcheck') svc.healthcheck = true;
      section = key === 'depends_on' || key === 'healthcheck' ? key : null;
      dep = null;
      continue;
    }
    if (section === 'healthcheck') {
      const kv = /^([\w-]+):\s*(.*)$/.exec(t);
      if (indent === 6 && kv) svc.health[kv[1]] = kv[2];
      continue;
    }
    if (section !== 'depends_on') continue;
    if (indent === 6) {
      const list = /^- ([\w-]+)$/.exec(t);
      if (list) {
        svc.dependsOn[list[1]] = 'service_started';
        continue;
      }
      dep = /^([\w-]+):$/.exec(t)?.[1];
      assert.ok(dep, `depends_on satırı okunamadı: ${raw}`);
      svc.dependsOn[dep] = 'service_started';
      continue;
    }
    if (indent === 8 && dep) {
      const c = /^condition:\s*(\S+)$/.exec(t);
      if (c) svc.dependsOn[dep] = c[1];
    }
  }
  return services;
}

const base = parseServices(read('docker-compose.yml'));
const prod = parseServices(read('docker-compose.prod.yml'));

test('okuyucu: servisler ve bağımlılıklar bulundu', () => {
  for (const s of ['postgres', 'postgres-upgrade', 'account-migrate', 'account-api', 'deciship-migrate', 'vision', 'deciship-api', 'hub-web', 'deciship-web', 'site', 'gateway']) {
    assert.ok(base[s], `${s} yok`);
  }
  assert.ok(Object.keys(base.gateway.dependsOn).length > 0);
});

test('açılış zinciri: veritabanı → yükseltme → göçler → servisler', () => {
  assert.deepEqual(base['postgres-upgrade'].dependsOn, { postgres: 'service_healthy' });
  assert.deepEqual(base['account-migrate'].dependsOn, { 'postgres-upgrade': 'service_completed_successfully' });
  assert.deepEqual(base['deciship-migrate'].dependsOn, { 'postgres-upgrade': 'service_completed_successfully' });
  assert.deepEqual(base['account-api'].dependsOn, { 'account-migrate': 'service_completed_successfully' });
  // Görüntü servisi sağlıksızken API yine açılır (ölçüm ekranı kendi hatasını verir): yalnız başlamış olması beklenir.
  assert.deepEqual(base['deciship-api'].dependsOn, {
    'deciship-migrate': 'service_completed_successfully',
    'account-api': 'service_healthy',
    vision: 'service_started',
  });
});

test('gateway yalnız ortak çekirdeği bekler: Hesap servisi ve Merkez sağlıklı; ürün servisleri beklenmez', () => {
  assert.deepEqual(base.gateway.dependsOn, { 'account-api': 'service_healthy', 'hub-web': 'service_healthy' });
});

test('gateway ürün servisi yokken de açılır: her proxy_pass değişkenle, çalışma anında çözülür', () => {
  const conf = read('gateway/conf/default.conf');
  assert.match(conf, /^\s*resolver\s+127\.0\.0\.11\b/m, 'Docker DNS çözücüsü yok: adlar açılışta çözülür, kap yoksa nginx açılmaz');
  const dir = 'gateway/conf/products';
  const files = ['gateway/conf/default.conf', ...readdirSync(path.join(PLATFORM, dir)).filter((f) => f.endsWith('.conf')).map((f) => `${dir}/${f}`)];
  assert.ok(files.length >= 2, 'ürün yapılandırması bulunamadı');
  for (const f of files) {
    for (const m of read(f).matchAll(/^\s*proxy_pass\s+([^;]+);/gm)) {
      assert.match(m[1], /^\$\w+/, `${f}: proxy_pass ${m[1]} sabit adres; değişken kullanın (set $x http://...;)`);
    }
  }
});

test('"sağlıklı" beklenen her servisin sağlık denetimi var; bilinmeyen servis ve döngü yok', () => {
  for (const [name, s] of Object.entries(base)) {
    for (const [dep, cond] of Object.entries(s.dependsOn)) {
      assert.ok(base[dep], `${name} → ${dep}: servis yok`);
      assert.ok(['service_started', 'service_healthy', 'service_completed_successfully'].includes(cond), `${name} → ${dep}: ${cond}`);
      if (cond === 'service_healthy') assert.ok(base[dep].healthcheck, `${name} ${dep}'in sağlıklı olmasını bekliyor ama ${dep}'te healthcheck yok`);
    }
  }
  const state = {};
  const visit = (n, trail) => {
    if (state[n] === 'done') return;
    assert.notEqual(state[n], 'open', `döngü: ${[...trail, n].join(' → ')}`);
    state[n] = 'open';
    for (const d of Object.keys(base[n].dependsOn)) visit(d, [...trail, n]);
    state[n] = 'done';
  };
  for (const n of Object.keys(base)) visit(n, []);
});

// Üretim katmanının kendi servisi: yalnız TLS sonlandırıcı. Temel dosyada yoktur (yerelde https yok); kendi denetimi aşağıda.
const PROD_ONLY = ['caddy'];

test('üretim katmanı sırayı değiştirmez: depends_on ve healthcheck yazmaz, Caddy dışında yeni servis eklemez', () => {
  assert.ok(Object.keys(prod).length > 0, 'üretim katmanı okunamadı');
  for (const name of PROD_ONLY) assert.ok(prod[name] && !base[name], `${name}: yalnız üretim katmanında olmalı`);
  for (const [name, s] of Object.entries(prod)) {
    if (PROD_ONLY.includes(name)) continue;
    assert.ok(base[name], `üretim katmanında temelde olmayan servis: ${name}`);
    assert.deepEqual(s.dependsOn, {}, `${name}: üretim katmanı depends_on yazıyor`);
    assert.ok(!s.keys.includes('healthcheck'), `${name}: üretim katmanı healthcheck değiştiriyor`);
  }
});

/** `60s`, `1m30s`, `500ms` → saniye. */
function seconds(d) {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(d ?? ''));
  assert.ok(m && (m[1] || m[2]), `süre okunamadı: ${d}`);
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const COMPOSE_TEXT = read('docker-compose.yml');
const PROD_TEXT = read('docker-compose.prod.yml');
const LONG_RUNNING = Object.entries(base).filter(([, s]) => s.values.restart === 'unless-stopped');

test('günlük dönüşümü: x-logging çapası json-file ve boyut sınırlı; her servis onu alır, üretim katmanı değiştirmez', () => {
  const anchor = /^x-logging: &sod-logging\n((?:[ ]{2,}.*\n)+)/m.exec(COMPOSE_TEXT)?.[1];
  assert.ok(anchor, 'docker-compose.yml: x-logging: &sod-logging yok');
  assert.match(anchor, /^\s+driver: json-file$/m);
  assert.match(anchor, /^\s+max-size: \$\{SOD_LOG_MAX_SIZE:-\d+m\}$/m, 'max-size yok: Docker günlüğü sınırsız büyür');
  assert.match(anchor, /^\s+max-file: "\$\{SOD_LOG_MAX_FILE:-\d+\}"$/m, 'max-file yok');
  for (const [name, s] of Object.entries(base)) assert.equal(s.values.logging, '*sod-logging', `${name}: logging: *sod-logging yok`);
  for (const [name, s] of Object.entries(prod)) {
    if (PROD_ONLY.includes(name)) continue;
    assert.ok(!s.keys.includes('logging'), `${name}: üretim katmanı günlük ayarını değiştiriyor`);
  }
  // Çapa dosyalar arası geçmez: üretim katmanının kendi çapası temel dosyadakiyle harfi harfine aynı olmalı.
  const prodAnchor = /^x-logging: &sod-logging\n((?:[ ]{2,}.*\n)+)/m.exec(PROD_TEXT)?.[1];
  assert.equal(prodAnchor, anchor, 'docker-compose.prod.yml: x-logging çapası temel dosyadakinden farklı');
  for (const name of PROD_ONLY) assert.equal(prod[name].values.logging, '*sod-logging', `${name}: logging: *sod-logging yok`);
});

test('kapanış süresi: Postgres temiz kapanır, API iş bırakma süresinden uzun bekler; üretim katmanı kısaltmaz', () => {
  assert.equal(base.postgres.values.stop_signal, 'SIGINT', 'Postgres hızlı kapanış sinyali almıyor');
  assert.ok(seconds(base.postgres.values.stop_grace_period) >= 30, 'Postgres kapanışına 30 sn bile tanınmıyor');
  // Postgres en son kapanır: ona bağlanan servislerin her biri ondan önce bitmiş olmalı (compose bağımlıyı önce durdurur).
  const jobGraceMs = Number(/JOB_SHUTDOWN_GRACE_MS: \$\{JOB_SHUTDOWN_GRACE_MS:-(\d+)\}/.exec(COMPOSE_TEXT)?.[1]);
  assert.ok(jobGraceMs > 0, 'JOB_SHUTDOWN_GRACE_MS varsayılanı okunamadı');
  assert.ok(seconds(base['deciship-api'].values.stop_grace_period) >= jobGraceMs / 1000 + 15, 'deciship-api kapanışı iş bırakma süresinden en az 15 sn uzun değil');
  assert.ok(seconds(base['account-api'].values.stop_grace_period) >= 15, 'account-api süren postayı bekleyemez');
  for (const [name, s] of Object.entries(prod)) {
    if (PROD_ONLY.includes(name)) continue;
    if (s.values.stop_grace_period) assert.equal(s.values.stop_grace_period, base[name].values.stop_grace_period, `${name}: üretim katmanı kapanış süresini değiştiriyor`);
  }
});

test('sağlık denetimi: sürekli çalışan her kapta var (compose ya da imaj), açılışta sık, sonra seyrek ve 3 hatada sağlıksız', () => {
  const dockerfileHealth = {
    gateway: read('gateway/Dockerfile'),
    vision: read('../Deciship/services/vision/Dockerfile'),
  };
  for (const [name, s] of LONG_RUNNING) {
    if (!s.healthcheck) {
      assert.match(dockerfileHealth[name] ?? '', /^HEALTHCHECK\s/m, `${name}: sağlık denetimi yok (compose healthcheck ya da Dockerfile HEALTHCHECK)`);
      continue;
    }
    const h = s.health;
    assert.ok(h.start_period && h.start_interval, `${name}: start_period ve start_interval yok (açılış yavaşlar ya da sağlık hep sık yoklanır)`);
    assert.ok(seconds(h.start_interval) <= 5, `${name}: açılışta yoklama seyrek, bağımlılar geç açılır`);
    assert.ok(seconds(h.interval) >= 10, `${name}: sürekli yoklama çok sık`);
    assert.ok(Number(h.retries) >= 2, `${name}: tek hata kabı sağlıksız sayar`);
    assert.ok(seconds(h.timeout) < seconds(h.interval), `${name}: zaman aşımı aralıktan uzun`);
  }
  assert.match(dockerfileHealth.gateway, /^HEALTHCHECK .*--start-interval=\d+s/m, 'gateway imajında açılış aralığı yok');
});

/** Compose metninde bir servisin bloğu (girintili satırlar), yorumsuz. */
function serviceBlock(text, name) {
  const block = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|\\n[a-z]|$)`).exec(text)?.[1];
  assert.ok(block, `${name} servisi yok`);
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

test('üretimde dışa yalnız Caddy açılır: temelde port açan her servis sıfırlanır, Caddy yalnız TCP 80 ve 443', () => {
  const published = Object.keys(base).filter((n) => base[n].keys.includes('ports'));
  assert.ok(published.includes('gateway') && published.includes('site') && published.includes('postgres'), 'temel dosyanın portları okunamadı');
  for (const name of published) assert.equal(prod[name]?.values.ports, '!reset []', `${name}: üretim katmanı portunu kapatmıyor (ports: !reset [])`);
  const caddy = serviceBlock(PROD_TEXT, 'caddy');
  // Yalnız tırnaklı liste ögeleri portlardır (hacimler tırnaksız). Port değişkeni yalnız yerel deneme için; varsayılan 80 ve 443.
  const ports = [...caddy.matchAll(/^\s{6}- "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(
    ports,
    ['0.0.0.0:${CADDY_HTTP_PORT:-80}:80', '0.0.0.0:${CADDY_HTTPS_PORT:-443}:443'],
    'Caddy portları: yalnız IPv4 TCP, üretim varsayılanı 80 ve 443 (IPv6 köprüsü istemci adresini siler)',
  );
  assert.match(caddy, /^\s{4}image: caddy:\d+\.\d+\.\d+-alpine$/m, 'Caddy imajı sürümü sabit değil');
  assert.match(caddy, /^\s{6}- \.\/caddy:\/etc\/caddy:ro$/m, 'Caddyfile klasörü salt okunur bağlanmıyor');
  assert.match(caddy, /^\s{6}- sod_caddy_data:\/data$/m, 'sertifika hacmi yok: her yeniden oluşturmada sertifika yeniden alınır');
  for (const v of ['APP_HOST', 'SITE_HOST', 'ACME_EMAIL']) assert.match(caddy, new RegExp(`^\\s{6}${v}: \\$\\{${v}:\\?`, 'm'), `Caddy: ${v} zorunlu değil`);
});

test('Caddy sağlıklı gateway ve siteyi bekler; sağlık denetimi ötekilerle aynı biçimde', () => {
  assert.deepEqual(prod.caddy.dependsOn, { gateway: 'service_healthy', site: 'service_healthy' });
  assert.ok(base.site.healthcheck, 'site: sağlık denetimi yok');
  assert.match(read('gateway/Dockerfile'), /^HEALTHCHECK\s/m, 'gateway: sağlık denetimi yok');
  const h = prod.caddy.health;
  assert.ok(prod.caddy.healthcheck && h.start_period && h.start_interval, 'Caddy: healthcheck, start_period, start_interval yok');
  assert.ok(seconds(h.start_interval) <= 5, 'Caddy: açılışta yoklama seyrek');
  assert.ok(seconds(h.interval) >= 10, 'Caddy: sürekli yoklama çok sık');
  assert.ok(Number(h.retries) >= 2, 'Caddy: tek hata kabı sağlıksız sayar');
  assert.ok(seconds(h.timeout) < seconds(h.interval), 'Caddy: zaman aşımı aralıktan uzun');
  assert.equal(prod.caddy.values.restart, 'unless-stopped');
});

test("gerçek IP: gateway yalnız Caddy'nin sabit adresine güvenir; .env bu değeri ve vekil sayısını ezemez", () => {
  const caddy = serviceBlock(PROD_TEXT, 'caddy');
  const ip = /^\s{8}ipv4_address: (\$\{SOD_CADDY_IP:-([\d.]+)\})$/m.exec(caddy);
  assert.ok(ip, "Caddy'nin iç ağ adresi sabit değil (networks.edge.ipv4_address)");
  const gateway = serviceBlock(PROD_TEXT, 'gateway');
  const escaped = ip[1].replace(/[$.{}]/g, '\\$&');
  assert.match(gateway, new RegExp(`^\\s{6}GATEWAY_REAL_IP_FROM: ${escaped}$`, 'm'), "GATEWAY_REAL_IP_FROM Caddy'nin adresine bağlı değil");
  assert.match(gateway, /^\s{6}default: \{\}$/m, 'gateway iç servislere ulaşamaz (default ağı yok)');
  assert.match(gateway, /^\s{6}edge: \{\}$/m, "gateway Caddy'nin ağında değil");
  assert.match(serviceBlock(PROD_TEXT, 'site'), /^\s{6}edge: \{\}$/m, "site Caddy'nin ağında değil");
  // Aralık sabit ve Caddy'nin varsayılan adresini içerir: compose ağı yeniden kurulsa da adres değişmez.
  const subnet = /^\s{8}- subnet: \$\{SOD_EDGE_SUBNET:-(\d+\.\d+\.\d+)\.0\/24\}$/m.exec(PROD_TEXT);
  assert.ok(subnet, 'edge ağının aralığı sabit değil');
  assert.ok(ip[2].startsWith(`${subnet[1]}.`), `Caddy adresi ${ip[2]} edge aralığında (${subnet[1]}.0/24) değil`);
  assert.notEqual(ip[2], `${subnet[1]}.1`, 'Caddy adresi ağın geçidi olamaz');
  // Uygulamalar X-Forwarded-For'u gateway'in yazdığı tek adresten okur: vekil sayısı 1, üretimde sabit.
  for (const svc of ['account-api', 'deciship-api']) {
    assert.match(serviceBlock(PROD_TEXT, svc), /^\s{6}TRUST_PROXY_HOPS: "1"$/m, `${svc}: üretimde TRUST_PROXY_HOPS sabit 1 değil`);
  }
});

test('Caddyfile: başlıklar tek yerde, HSTS gateway ile aynı, istemcinin X-Forwarded-* başlığına güvenilmez, jeton günlüğe düşmez', () => {
  const caddyfile = read('caddy/Caddyfile')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const hsts = /^\s*header Strict-Transport-Security "([^"]+)"$/m.exec(caddyfile)?.[1];
  const gatewayHsts = /map \$sod_scheme \$sod_hsts \{[^}]*?https\s+"([^"]+)";/.exec(read('gateway/conf/default.conf'))?.[1];
  assert.ok(hsts && gatewayHsts, 'HSTS değeri okunamadı');
  assert.equal(hsts, gatewayHsts, 'site ve uygulama HSTS değerleri farklı');
  assert.match(hsts, /^max-age=\d+; includeSubDomains$/);
  assert.doesNotMatch(hsts, /preload/i, 'preload geri alınamaz; önce süre uzatılır (KALANLAR "Yayından önce")');
  // Uygulama bloğu yalnız aktarır: güvenlik başlıkları gateway'de (çift ya da çelişen başlık olmasın).
  const app = /^\{\$APP_HOST\} \{\n([\s\S]*?)\n\}$/m.exec(caddyfile)?.[1];
  assert.ok(app, 'uygulama bloğu yok');
  assert.match(app, /^\s*reverse_proxy gateway:80$/m);
  assert.doesNotMatch(app, /\bheader\b|\bimport\b/, 'uygulama bloğu başlık yazıyor: başlıkların yeri gateway/conf/security-headers.conf');
  const headers = [...caddyfile.matchAll(/^\s*header\s+(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headers, [`Strict-Transport-Security "${hsts}"`], 'Caddyfile HSTS dışında başlık yazıyor');
  assert.equal([...caddyfile.matchAll(/^\s*import sod_hsts$/gm)].length, 2, 'site ve www bloğu HSTS almıyor');
  // Sertifika yetkilisi yazılmaz: açıkça yazılınca Caddy'nin yedek yetkilisi (ZeroSSL) devreden çıkar.
  assert.doesNotMatch(caddyfile, /\b(cert_issuer|acme_ca|local_certs|issuer)\b|^\s*tls\b/m, 'Caddyfile sertifika yetkilisini seçiyor');
  assert.doesNotMatch(caddyfile, /trusted_proxies|client_ip_headers/, "istemcinin X-Forwarded-For'u Caddy'de güvenilir sayılmamalı");
  assert.doesNotMatch(caddyfile, /header_up\s+[+]?X-Forwarded/i, 'X-Forwarded-* başlıkları elle yazılmamalı (Caddy kendisi yazar)');
  // Erişim günlüğü yok (jetonlu adresler); hata günlüğü isteğin adresini ve başlıklarını siler.
  const logs = [...caddyfile.matchAll(/^\s*log\b.*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(logs, ['log default {'], 'site bloğunda erişim günlüğü: jetonlu adresler maskesiz yazılır');
  assert.match(caddyfile, /^\s*request>uri delete$/m, 'hata günlüğü isteğin adresini yazıyor');
  assert.match(caddyfile, /^\s*request>headers delete$/m, 'hata günlüğü isteğin başlıklarını yazıyor');
});
