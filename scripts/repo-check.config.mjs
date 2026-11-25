// repo-check ayarları (Mesaj 10, plan §3.7). Her istisna gerekçesiyle yazılır; gerekçesiz istisna eklenmez.
// Yollar depo köküne göre, `/` ile. Desen: `**` her derinlik, `*` tek klasör içi; `/` içermeyen desen dosya adına uyar.

export default {
  // Hiçbir kuralın taramadığı yerler.
  exclude: [
    { glob: 'SONRAKI-OTURUM/**', reason: 'Durum notları ve plan; kod değil.' },
    { glob: 'Deciship/samples/invoices/**', reason: 'Taşıyıcıdan gelen ham fatura örnekleri; baytlar olduğu gibi korunur.' },
    { glob: '**/node_modules/**', reason: 'Kurulu paketler (izlenmez; yine de güvence).' },
  ],
  // K10 belge-yolu ve K11 uzun-satir (yalnız UYARI): Markdown belgeleri. Genel `exclude` bu iki kural için geçerli değil;
  // SONRAKI-OTURUM taranır, yalnız aşağıdaki hariç listesi uygulanır. Kural bazında istisna `allow` ile yazılır.
  docs: {
    include: ['**/*.md'],
    exclude: [
      { glob: 'SONRAKI-OTURUM/ARSIV/**', reason: 'Arşiv: eski notlar ve raporlar, yeni iş oraya yazılmaz; yolları geçmişte kalmış olabilir.' },
      { glob: 'Deciship/samples/**', reason: 'Örnek veri; belge değil.' },
      { glob: '**/node_modules/**', reason: 'Kurulu paketlerin belgeleri (izlenmez; yine de güvence).' },
    ],
    maxLineLength: 600,
  },
  // `-text` özniteliği taşıyan dosyalar (ör. core/test/fixtures/robustness/*) kendiliğinden atlanır.

  // İkili sayılan uzantılar (taranmaz). Bilinmeyen uzantıda ilk 8 KB'ta NUL baytı varsa dosya ikili sayılır.
  binaryExtensions: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'xlsx', 'xls', 'docx', 'pptx', 'zip', 'gz', 'tgz',
    'ttf', 'otf', 'woff', 'woff2', 'eot', 'wav', 'mp3', 'mp4', 'mov', 'webm', 'jar', 'keystore', 'jks', 'apk', 'aab',
    'so', 'dll', 'exe', 'bin', 'class', 'pyc', 'db', 'sqlite', 'onnx', 'tflite',
  ],
  // Her zaman metin sayılan uzantılar (NUL baytı olsa da K1 ile taranır).
  textExtensions: [
    'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'sql', 'css', 'yml', 'yaml', 'sh', 'ps1', 'conf', 'template',
    'md', 'txt', 'html', 'csv', 'svg', 'xml', 'toml', 'prisma', 'py', 'kt', 'swift', 'bat', 'cmd', 'snap', 'example',
    'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'nvmrc', 'podspec', 'webmanifest', 'mock', 'inc',
    'gradle', 'properties', 'dockerfile', 'githooks',
  ],

  // K2: görünmez karakter aranan kod dosyaları. Plan listesi + aynı sınıftan kaynaklar (prisma, py, kt, swift, bat,
  // toml, gradle, Dockerfile, .githooks/*). Düzyazı (md, html) yok: orada görünmez karakter derleme davranışını bozmaz.
  invisibleExtensions: [
    'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'sql', 'css', 'yml', 'yaml', 'sh', 'ps1', 'conf', 'template',
    'prisma', 'py', 'kt', 'swift', 'bat', 'cmd', 'toml', 'gradle', 'inc', 'dockerfile', 'githooks',
  ],

  // K3: BOM. `.ps1` BOM ile başlar (Windows PowerShell 5.1 BOM'suz UTF-8'i ANSI okur, Türkçe harf bozulur).
  bomRequired: ['ps1'],
  // Bu uzantılar BOM ile başlamaz (plan listesi + aynı yükleyiciden geçen js/cjs/mts/cts; sh'ta BOM shebang'i bozar).
  bomForbidden: ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'sh'],

  // K4: index'te LF olması gerekenler (Linux kapta ve CI'da çalışır).
  lfRequired: ['**/*.sh', '.githooks/*'],

  // Kural bazında dosya istisnası: { glob, rules: ['K1', …], reason }.
  allow: [],

  // K5 goc-rls
  migrations: {
    // Her göç klasörünün varsayılan şeması (bağlantı adresindeki ?schema=). Nitelemesiz tablo adı bu şemadadır.
    // Ayarda olmayan bir göç klasörü HATA verir: yeni ürünün göçü denetimsiz kalmasın.
    // Prisma dışı düzen (düz `NNNN-ad.sql`, kendi çalıştırıcısı): `historyTable` göç geçmişi tablosu, `historyRunner` o tabloyu
    // açıp uygulama rolünden geri alan dosya (products:check ikisini denetler; Prisma'da geri alma göçün içindedir).
    dirs: [
      { dir: 'Deciship/apps/api/prisma/migrations', defaultSchema: 'deciship' },
      { dir: 'Platform/apps/account-api/prisma/migrations', defaultSchema: 'platform' },
      // Yapay zekâ geçidi (ürün dışı platform hizmeti; kiracı products-db.mjs DB_SERVICE_TENANTS). Firma verisi değil, RLS'siz.
      { dir: 'Platform/apps/ai-api/prisma/migrations', defaultSchema: 'ai' },
      { dir: 'Tagpress/apps/server/src/db/pg/migrations', defaultSchema: 'tagpress', historyTable: '_tagpress_migrations', historyRunner: 'Tagpress/apps/server/src/db/pg/migrate.ts' },
    ],
    // FORCE RLS'li sayılan şemalar: göçün başında bu şemadaki her tablo FORCE açık kabul edilir. Herhangi bir göçte
    // FORCE ROW LEVEL SECURITY görülen şema da kendiliğinden bu listeye girer (temkinli varsayım).
    rlsSchemas: ['deciship', 'tagpress'],
    // Bilinen RLS'siz şemalar (yalnız şema adını tanımak için; RLS açılırsa yukarıdaki kural öne geçer).
    otherSchemas: ['platform', 'ai', 'public'],
    // Bilinen eski göçler: bulgu HATA yerine UYARI basılır. Göç değiştirilemez (Prisma sağlama toplamı).
    legacy: [
      {
        migration: '20261110180000_tariff_fuel_variable',
        reason: 'Y29: NO FORCE olmadan UPDATE; FORCE RLS altında hiçbir satır değişmedi, kurbanı yok.',
      },
    ],
  },

  // K8 paket-bagimlilik: Docker imajında yerel paketlerin node_modules klasörünü tüketicininkine bağlayanlar.
  sharedNodeModules: [
    {
      consumer: 'Deciship/apps/api',
      reason: 'Dockerfile "build" aşaması core, auth-kit ve contracts node_modules klasörünü api\'ninkine bağlar; ' +
        'üretim imajı `npm ci --omit=dev` ile kurulur.',
    },
  ],

  // K9 surum-birligi
  versions: {
    libs: [
      'typescript', 'vitest', '@types/node', 'react', 'react-dom', '@types/react', 'zod', 'fastify', 'jose', 'pg',
      'prisma', '@prisma/client', 'i18next', 'react-i18next', '@tanstack/react-query', 'vite', '@playwright/test', 'msw',
    ],
    exceptions: [
      { pkg: 'Deciship/apps/mobile', lib: 'typescript', reason: 'Expo SDK TypeScript 6 ister (~6.0.3).' },
      { pkg: 'Deciship/apps/mobile', lib: 'react', reason: 'Expo SDK React sürümünü sabitler (19.3.0).' },
      { pkg: 'Deciship/apps/mobile', lib: '@types/react', reason: 'Expo SDK ile aynı (~19.3.0).' },
      { pkg: 'Platform/e2e', lib: '@types/node', reason: 'Playwright koşturucusu; Node 24 tipleri (^24).' },
      { pkg: 'Platform/e2e', lib: '@playwright/test', reason: 'Sabit Playwright sürümü (1.64.1), tarayıcı ikilileriyle eş.' },
      { pkg: 'tools/lint', lib: 'typescript', reason: 'typescript-eslint TS 7 ile uyumsuz; lint kendi TS 6 kopyasını kullanır (plan §3.8).' },
    ],
    // FROM node: etiketi .nvmrc ile tam eşit olmalı (15-B12; bütün Dockerfile'lar node:24.22.1-alpine).
    dockerNodeExact: true,
  },
};
