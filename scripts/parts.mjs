// Parça kaydı: hangi paket hangi komutla koşar (Mesaj 10 planı 3.2).
// dir: depo köküne göre klasör ("." = kök). modules: node_modules aranacak klasör
// (varsayılan dir; false = gerekmez). needs: dir'e göre var olması gereken dosya/klasörler.
// tool: PATH'te olması gereken araç (yoksa koşmadı). optional: koşmadı yerelde hata sayılmaz.
// shard: vitest `--shard=i/n` alabilir (test.mjs --shard, CI veritabanı işi). gate: false = kalırsa bilgi, sonucu bozmaz.
const MIN = 60 * 1000;

export const GROUPS = ['check', 'typecheck', 'lint', 'quick', 'db', 'extra', 'perf', 'e2e'];

export const PARTS = [
  { id: 'repo-check', dir: '.', cmd: 'node scripts/repo-check.mjs', group: 'check', modules: false, needs: ['scripts/repo-check.mjs'] },

  { id: 'tc:core', dir: 'Deciship/packages/core', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:api', dir: 'Deciship/apps/api', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:web', dir: 'Deciship/apps/web', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:mobile', dir: 'Deciship/apps/mobile', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:account', dir: 'Platform/apps/account-api', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:ai', dir: 'Platform/apps/ai-api', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:auth-kit', dir: 'Platform/packages/auth-kit', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:product-kit', dir: 'Platform/packages/product-kit', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:hub', dir: 'Platform/apps/hub-web', cmd: 'npm run typecheck', group: 'typecheck' },
  { id: 'tc:format', dir: 'Platform/packages/format', cmd: 'npm run typecheck', group: 'typecheck', needs: ['package.json'] },
  { id: 'tc:contracts', dir: 'Platform/packages/contracts', cmd: 'npm run typecheck', group: 'typecheck', needs: ['package.json'] },
  { id: 'tc:shell', dir: 'Platform/packages/shell', cmd: 'node ../../apps/hub-web/node_modules/typescript/bin/tsc --noEmit -p .', group: 'typecheck', modules: 'Platform/apps/hub-web', needs: ['package.json'] },
  { id: 'tc:platform-e2e', dir: 'Platform/e2e', cmd: 'node ../apps/hub-web/node_modules/typescript/bin/tsc --noEmit -p .', group: 'typecheck', modules: 'Platform/apps/hub-web', needs: ['tsconfig.json'] },
  // TagPress bir pnpm çalışma alanıdır (npm değil): kurulum scripts/install.mjs (pm: 'pnpm'; CI'da corepack ile
  // package.json'daki pnpm sürümü). Tip denetimi paket başına; testler kök vitest ayarıyla tek parçada (tagpress).
  { id: 'tc:tp-mcp', dir: 'Tagpress/apps/mcp', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-server', dir: 'Tagpress/apps/server', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-web', dir: 'Tagpress/apps/web', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-ai', dir: 'Tagpress/packages/ai', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-domain', dir: 'Tagpress/packages/domain', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-engine', dir: 'Tagpress/packages/engine', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-learn', dir: 'Tagpress/packages/learn', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-print', dir: 'Tagpress/packages/print', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-templates', dir: 'Tagpress/packages/templates', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },
  { id: 'tc:tp-typeset', dir: 'Tagpress/packages/typeset', cmd: 'pnpm run typecheck', group: 'typecheck', modules: 'Tagpress', tool: 'pnpm --version' },

  { id: 'lint', dir: '.', cmd: 'node tools/lint/run.mjs', group: 'lint', modules: 'tools/lint', needs: ['tools/lint/run.mjs'] },

  { id: 'core', dir: 'Deciship/packages/core', cmd: 'npm test', group: 'quick' },
  { id: 'format', dir: 'Platform/packages/format', cmd: 'npm test', group: 'quick', needs: ['package.json', 'test'] },
  { id: 'tokens', dir: 'Platform/packages/tokens', cmd: 'npm test', group: 'quick', modules: false, needs: ['package.json', 'build.mjs'] },
  { id: 'products', dir: '.', cmd: 'node Platform/scripts/products-gen.mjs --check && node --test Platform/scripts/products-gen.test.mjs', group: 'quick', modules: false, needs: ['Platform/scripts/products-gen.mjs'] },
  { id: 'contracts', dir: 'Platform/packages/contracts', cmd: 'npm test', group: 'quick', needs: ['package.json'] },
  { id: 'auth-kit', dir: 'Platform/packages/auth-kit', cmd: 'npm run test:unit', group: 'quick' },
  { id: 'product-kit', dir: 'Platform/packages/product-kit', cmd: 'npm run test:unit', group: 'quick' },
  { id: 'shell', dir: 'Platform/packages/shell', cmd: 'npm test', group: 'quick', modules: 'Platform/apps/hub-web' },
  { id: 'web', dir: 'Deciship/apps/web', cmd: 'npm test', group: 'quick' },
  { id: 'web-i18n', dir: 'Deciship/apps/web', cmd: 'node scripts/check-i18n.mjs --strict', group: 'quick', modules: false, needs: ['scripts/check-i18n.mjs'] },
  { id: 'mobile', dir: 'Deciship/apps/mobile', cmd: 'npm test', group: 'quick' },
  { id: 'mobile-i18n', dir: 'Deciship/apps/mobile', cmd: 'node scripts/check-i18n.mjs --strict', group: 'quick', modules: false, needs: ['scripts/check-i18n.mjs'] },
  // TagPress: font ya da gerçek veri kopyası (data/, eski klasörün fontları) yoksa ilgili testler kendiliğinden atlanır
  // (temiz Linux'ta 723 testin 80'i). Yapay zekâ çağrıları testte sahte istemciyle.
  { id: 'tagpress', dir: 'Tagpress', cmd: 'pnpm test', group: 'quick', tool: 'pnpm --version' },
  // TagPress web sözlüğü: Tezgâh klasörleri (src/tezgah, src/ekranlar, src/ortak, src/i18n) --strict; eski ekranlar geçişte.
  { id: 'tp-web-i18n', dir: 'Tagpress/apps/web', cmd: 'node scripts/check-i18n.mjs --strict', group: 'quick', modules: false, needs: ['scripts/check-i18n.mjs'] },
  { id: 'site', dir: 'Platform/apps/site', cmd: 'npm run build && npm run check', group: 'quick', modules: false },
  { id: 'hub-i18n', dir: 'Platform/apps/hub-web', cmd: 'node ../../scripts/check-i18n.mjs --root . --locales src/locales --src src --strict', group: 'quick', modules: false, needs: ['src/locales'] },
  { id: 'shell-i18n', dir: 'Platform/packages/shell', cmd: 'node ../../scripts/check-i18n.mjs --root . --locales src/locales --src src --strict', group: 'quick', modules: false, needs: ['src/locales'] },
  { id: 'hub-unit', dir: 'Platform/apps/hub-web', cmd: 'npm test', group: 'quick' },
  { id: 'i18n-shared', dir: 'Platform', cmd: 'node --test scripts/check-i18n.test.mjs', group: 'quick', modules: false, needs: ['scripts/check-i18n.test.mjs'] },
  { id: 'i18n-unused', dir: 'Platform', cmd: 'node --test scripts/unused-i18n.test.mjs', group: 'quick', modules: false, needs: ['scripts/unused-i18n.test.mjs'] },
  { id: 'dev-gateway', dir: 'Platform', cmd: 'node --test scripts/dev-gateway.test.mjs', group: 'quick', modules: false, needs: ['scripts/dev-gateway.test.mjs'] },
  { id: 'compose-order', dir: 'Platform', cmd: 'node --test gateway/test/compose-order.test.mjs', group: 'quick', modules: false, needs: ['gateway/test/compose-order.test.mjs'] },
  { id: 'yedek', dir: 'Platform', cmd: 'node --test scripts/yedek.test.mjs', group: 'quick', modules: false, needs: ['scripts/yedek.test.mjs'] },
  { id: 'gercek-kullanim', dir: 'Platform', cmd: 'node --test scripts/gercek-kullanim.test.mjs', group: 'quick', modules: false, needs: ['scripts/gercek-kullanim.test.mjs'] },
  // Sunucunun "ayakta mı" denetimi (bash; Windows'ta Git Bash): taklit curl, docker ve df ile.
  { id: 'ayakta-mi', dir: 'Platform', cmd: 'node --test scripts/ayakta-mi.test.mjs', group: 'quick', modules: false, needs: ['scripts/ayakta-mi.test.mjs'] },
  // Sunucu güncellemesi ve ilk kurulumu (bash): geçici git deposu, taklit docker ve curl (scripts/test-fixtures/sunucu).
  { id: 'guncelle', dir: 'Platform', cmd: 'node --test scripts/guncelle.test.mjs', group: 'quick', modules: false, needs: ['scripts/guncelle.test.mjs'] },
  { id: 'kurulum', dir: 'Platform', cmd: 'node --test scripts/kurulum.test.mjs', group: 'quick', modules: false, needs: ['scripts/kurulum.test.mjs'] },
  { id: 'pg-guard', dir: '.', cmd: 'node --test scripts/lib/pg-guard.test.mjs', group: 'quick', modules: false, needs: ['scripts/lib/pg-guard.test.mjs'] },
  { id: 'access-log', dir: 'Platform', cmd: 'node --test gateway/test/access-log.test.mjs', group: 'quick', modules: false, needs: ['gateway/test/access-log.test.mjs'] },
  { id: 'rate-limits', dir: 'Platform', cmd: 'node --test gateway/test/rate-limits.test.mjs', group: 'quick', modules: false, needs: ['gateway/test/rate-limits.test.mjs'] },
  { id: 'gateway-gzip', dir: 'Platform', cmd: 'node --test gateway/test/gzip.test.mjs', group: 'quick', modules: false, needs: ['gateway/test/gzip.test.mjs'] },
  // Derlenmiş komut girişleri gerçekten çalışır (tsup bölmesi gövdeyi ortak parçaya taşırsa komut boş geçer); veritabanı istemez.
  { id: 'account-cli', dir: 'Platform/apps/account-api', cmd: 'npm run test:cli', group: 'quick', needs: ['test/cli-entries.test.mjs'] },
  { id: 'api-cli', dir: 'Deciship/apps/api', cmd: 'npm run test:cli', group: 'quick', needs: ['test/cli-entries.test.mjs'] },
  // 15-B5: veritabanı istemeyen API testleri (liste test/unitFiles.ts; Postgres'e bağlanmaya kalkan dosya kırılır).
  { id: 'api-unit', dir: 'Deciship/apps/api', cmd: 'npm run test:unit', group: 'quick', needs: ['vitest.unit.config.ts'] },
  { id: 'repo-check-test', dir: '.', cmd: 'node --test scripts/repo-check.test.mjs', group: 'quick', modules: false, needs: ['scripts/repo-check.test.mjs'] },
  // Yanıt şekli yardımcısı (sözleşme denetimi, 15-B2): gerçek API şeklini yazar, sahte API'yi ona karşı sınar.
  // CI iş seçimi (15-B1): yol listeleri ci.yml ile aynı, iş adları tanınıyor.
  { id: 'ci-select', dir: '.', cmd: 'node --test scripts/ci-select.test.mjs', group: 'quick', modules: false, needs: ['scripts/ci-select.test.mjs'] },
  // npm run test:changed planı (KALANLAR 0.2) ve npm run ci:son günlük özeti (0.6).
  { id: 'ci-son', dir: '.', cmd: 'node --test scripts/ci-son.test.mjs', group: 'quick', modules: false, needs: ['scripts/ci-son.test.mjs'] },
  { id: 'test-changed', dir: '.', cmd: 'node --test scripts/test-changed.test.mjs', group: 'quick', modules: false, needs: ['scripts/test-changed.test.mjs'] },
  { id: 'shape-lib', dir: '.', cmd: 'node --test scripts/lib/shape.test.mjs', group: 'quick', modules: false, needs: ['scripts/lib/shape.test.mjs'] },
  { id: 'lint-rules', dir: '.', cmd: 'node --test tools/lint/rules.test.mjs', group: 'quick', modules: 'tools/lint', needs: ['tools/lint/rules.test.mjs'] },

  // Veritabanı adı koşu başına rastgele, bitişte silinir (test/testEnv.ts, 15-B10); veritabanısız dosyalar api-unit'te.
  { id: 'api', dir: 'Deciship/apps/api', cmd: 'npm run test:db', group: 'db', pg: true, shard: true, timeout: 40 * MIN },
  // Hesap servisi takımı büyüdü (CI'da 8,5 dk + özel roller); 10 dk varsayılan iki kez doldu (2026-11-13).
  { id: 'account', dir: 'Platform/apps/account-api', cmd: 'npm test', group: 'db', pg: true, shard: true, timeout: 20 * MIN },
  { id: 'auth-kit-db', dir: 'Platform/packages/auth-kit', cmd: 'npx vitest run test/eventRace.db.test.ts', group: 'db', pg: true },
  { id: 'product-kit-db', dir: 'Platform/packages/product-kit', cmd: 'npx vitest run test/ornekarac/ornekarac.db.test.ts', group: 'db', pg: true },
  // Yapay zekâ geçidi: bütün testler gerçek Postgres'te (roller kayıttan üretilen init.sql'den, göç sod_ai_admin ile); veritabanı
  // koşu başına rastgele, bitişte silinir (test/testEnv.ts). Sağlayıcılar sahte; gerçek yapay zekâ çağrısı yok.
  { id: 'ai', dir: 'Platform/apps/ai-api', cmd: 'npm test', group: 'db', pg: true },
  // TagPress sunucu testleri Postgres'te (vitest.pg.config.ts: platform kipi veritabanı, şema, köprü, iki firma). Veritabanı
  // koşu başına şablondan, test başına yeni ve bitişte silinir (apps/server/src/test/pg.ts). pnpm ister (CI: corepack).
  { id: 'tagpress-db', dir: 'Tagpress', cmd: 'pnpm test:pg', group: 'db', pg: true, tool: 'pnpm --version', timeout: 20 * MIN },

  // KALANLAR 0.4: duvar saati eşikli testler (*.perf.test.ts); kapı değil (gate: false), sonuç bilgi olarak yazılır.
  // Doğruluk denetimleri kapıdaki eş dosyalarda. CI: hızlı işte API ve core, veritabanı işinin hesap-1 parçasında hesap servisi.
  { id: 'api-perf', dir: 'Deciship/apps/api', cmd: 'npm run test:perf', group: 'perf', gate: false, needs: ['vitest.perf.config.ts'] },
  // KALANLAR 6.14: büyük firma verisiyle uç süreleri (veriyi kendisi üretir, birkaç dakika); CI'da koşmaz.
  { id: 'api-perf-db', dir: 'Deciship/apps/api', cmd: 'npm run test:perf:db', group: 'perf', pg: true, gate: false, timeout: 20 * MIN, needs: ['vitest.perf-db.config.ts'] },
  { id: 'core-perf', dir: 'Deciship/packages/core', cmd: 'npm run test:perf', group: 'perf', gate: false, needs: ['vitest.perf.config.ts'] },
  { id: 'account-perf', dir: 'Platform/apps/account-api', cmd: 'npm run test:perf', group: 'perf', pg: true, gate: false, needs: ['vitest.perf.config.ts'] },

  { id: 'vision', dir: 'Deciship/services/vision', cmd: 'python -m pytest -q', group: 'extra', modules: false, tool: 'python -m pytest --version', optional: true },
  { id: 'gateway', dir: 'Platform', cmd: 'bash gateway/test/run.sh', group: 'extra', modules: false, tool: 'docker --version', optional: true },

  // e2e süre sınırı takılma bekçisidir: CI'da hızlı makinede ~24 dk, yavaş makinede (aynı testler ~1,4 kat) ~33 dk sürer.
  { id: 'web-e2e', dir: 'Deciship/apps/web', cmd: 'npx playwright test --output="<LOG>/pw-web"', group: 'e2e', timeout: 40 * MIN, env: { DECISHIP_WEB_PORT: '5173' } },
  { id: 'hub-e2e', dir: 'Platform/apps/hub-web', cmd: 'npx playwright test --output="<LOG>/pw-hub"', group: 'e2e', timeout: 40 * MIN, env: { HUB_WEB_PORT: '5181' } },
];

export const DEFAULT_TIMEOUT = 10 * MIN;
