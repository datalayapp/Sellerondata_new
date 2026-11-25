/**
 * Araç kaydı. Tek kaynak: yeni araç eklemek bu dosyadaki `PRODUCT_REGISTRY` dizisine bir `defineProduct({...})` girdisi eklemektir.
 * `catalog.ts`'teki bütün dışa aktarımlar (`ProductKey`, `Permission`, `PRODUCTS`, `PERMISSION_LABEL`…) buradan türer.
 *
 * Kurallar (`validateRegistry` denetler; contracts testi ve Hesap servisi açılışı koşar):
 * - Anahtar `/^[a-z][a-z0-9]{2,19}$/`: adres (`/key`, `/api/key`), izin öneki, şema, rol ve dosya adı olarak yazılır.
 * - Her izin `key.` önekli; rol izinleri izin listesinin alt kümesi; `ownerRole`/`inviteRole` rollerde var.
 * - `permissionRequires`, `ownerOnlyPermissions`, `permissionGroups` yalnız listedeki izinleri, `lockedRoles` yalnız var olan rolleri anar;
 *   her hazır rolün izin seti bağımlılıkları zaten karşılar (karşılamıyorsa hata; hazır rol kendiliğinden düzeltilmez).
 * - `launch !== 'off'` olan araçta rol, sahip rolü ve `deploy.api` zorunlu; izni olan açık araçta `permissionGroups` da (rol düzenleyici).
 *
 * Yazımda `enum` ve `namespace` yok (Node tip ayıklaması ve `erasableSyntaxOnly`). Bu dosya yalnız `palette.generated.ts`'i içe aktarır;
 * üretici betikler (`Platform/scripts/products-gen.mjs`) onu derleme adımı olmadan okur.
 */

import { PRODUCT_PALETTE } from './palette.generated.ts';

export type Locale = 'tr' | 'en';
export const LOCALES: readonly Locale[] = ['tr', 'en'];

export type LocalizedText = Record<Locale, string>;

/** Aracın yayın durumu. `off`: kapalı (acil durdurma dahil). `pilot`: yalnız aboneliği açılmış firmalar. `public`: herkese açık. */
export type ProductLaunch = 'off' | 'pilot' | 'public';
export const PRODUCT_LAUNCHES: readonly ProductLaunch[] = ['off', 'pilot', 'public'];

export type ProductRoleEntry<P extends string = string> = {
  /** `/^[A-Z][A-Z_]{1,19}$/` */
  key: string;
  label: LocalizedText;
  description: LocalizedText;
  permissions: readonly P[];
};

/** Rol düzenleyicide izinlerin kümesi ("Fatura", "Tarife"…). Kümeler ve içlerindeki izinler gösterim sırasıyladır. */
export type ProductPermissionGroup<P extends string = string> = {
  /** `/^[a-z][a-z_]{1,19}$/`; `OrgRolesResponse` izinleri bu anahtarla kümeye bağlar. */
  key: string;
  label: LocalizedText;
  permissions: readonly P[];
};

export type ProductEntry<K extends string = string, P extends string = string> = {
  key: K;
  /** Marka adı, her dilde aynı. */
  name: string;
  tagline: LocalizedText;
  /** İşaret ve etkin araç rengi, `#rrggbb`. Paletteki araçlar `PRODUCT_PALETTE.<key>.main`'den okur (kaynak `tokens.json`). */
  color: string;
  /** `Platform/brand/<dosya>.svg`. Yoksa adın ilk harfiyle ürün renginde nötr kare işaret çizilir. */
  mark?: string;
  /** Varsayılan durum. Hesap servisi `PRODUCT_LAUNCH` ortam değişkeniyle ezer (`account-api/src/lib/launch.ts`). */
  launch: ProductLaunch;
  /** İzin anahtarı → etiket. İzin birleşimi (`Permission`) yalnız buradan çıkar. */
  permissions: Readonly<Record<P, LocalizedText>>;
  /** Web uygulamasına giriş izni. Aracın web'i yoksa yok. */
  webAccess?: NoInfer<P>;
  roles: readonly ProductRoleEntry<NoInfer<P>>[];
  /**
   * İzin → doğrudan gerektirdiği izinler (özel roller). Hesap servisi rol kaydederken zorunlu tutar:
   * eksik bağımlılık `400 INVALID_ROLE_PERMISSIONS`, kendiliğinden eklenmez. Zincir geçişlidir (`closePermissions`).
   */
  permissionRequires?: Readonly<Partial<Record<NoInfer<P>, readonly NoInfer<P>[]>>>;
  /** Rol düzenleyicideki izin kümeleri. Her izin tam olarak bir kümededir. */
  permissionGroups?: readonly ProductPermissionGroup<NoInfer<P>>[];
  /** İzinleri firma içinde değiştirilemeyen hazır roller (adı değişebilir). Sahip rolü her zaman kilitlidir, burada yazılı olmasa da. */
  lockedRoles?: readonly string[];
  /** Yalnız firma sahibinin (OWNER) role koyabildiği, rolü atayabildiği ve davetle verebildiği izinler. */
  ownerOnlyPermissions?: readonly NoInfer<P>[];
  /** İlk açılışta firma sahibine verilen rol. */
  ownerRole: string | null;
  /** Merkez'deki davet formunun varsayılan rolü. */
  inviteRole: string | null;
  /** Merkez'de Analiz, Veriler ve CSV'yi hangi izin açar. `headline`: Genel Bakış'ın baş rakamlarının KPI kimlikleri, önem sırasıyla. */
  hub?: { analytics: NoInfer<P>; data: NoInfer<P>; export: NoInfer<P>; headline?: readonly string[] };
  /** Dağıtım. Gateway blokları ve geliştirme kapısı buradan üretilir. `deploy.web` yoksa aracın yolları Merkez'e düşer. */
  deploy?: {
    api?: { service: string; port: number; maxBody?: `${number}m`; bodyTimeout?: `${number}s`; readTimeout?: `${number}s`; dev?: number };
    web?: { service: string; port: number; dev?: number };
  };
  /** Tanıtım sitesindeki sayfa. Yoksa araç sitede görünmez. */
  site?: { tr: `/${string}`; en: `/${string}` };
  /** Mobilde aracın açılış ekranı (Mesaj 13 araç kaydı). Yoksa mobilde "Web'de aç". */
  mobile?: { entry: `/${string}` };
  /** Yapay zekâ geçidi (`ai-api`). Yoksa araç geçidi kullanamaz (jetonu olsa da her amaç `sod_purpose_unknown`). */
  ai?: ProductAiEntry<NoInfer<K>>;
};

/**
 * Aracın yapay zekâ girdisi (geçit okur; `contracts/src/ai.ts` başlık ve kodları).
 * - `purposes`: geçit amacı → etiket. Anahtar `<ürün>.<amaç>`, amaç küçük harf, rakam, `_` (`AI_PURPOSE_PATTERN`); aracın bugünkü amaç
 *   adından `aiPurposeKey` ile (`-` → `_`). Kayıtta olmayan amaç geçitte reddedilir; etiket Merkez harcama kırılımında görünür.
 * - `models`: istenebilecek modeller (izin listesi, gövdedeki `model`). Sunucu tarafı yedek modeller listede olmak zorunda değil,
 *   fiyat tablosundan (yoksa en pahalı fiyattan) sayılır. Her model `AI_LIST_PRICES_USD`'de olmalı (contracts testi).
 * - `defaultCapUsd`: firma × araç aylık koruma tavanı (USD); abonelik limiti `aiSpendCapMonthlyUsd` firmada ezer.
 */
export type ProductAiEntry<K extends string = string> = {
  purposes: Readonly<Record<`${K}.${string}`, LocalizedText>>;
  models: readonly string[];
  defaultCapUsd: number;
};

/** Kayıt girdisi yazmak için. `K` anahtardan, izin birleşimi `P` yalnız `permissions` nesnesinden çıkar; rolde yazım hatası derlemede yakalanır. */
export function defineProduct<const K extends string, const P extends `${K}.${string}` = never>(entry: ProductEntry<K, P>): ProductEntry<K, P> {
  return entry;
}

// ---------- DeciShip ----------

const DECISHIP_PERMISSION_LABEL = {
  'deciship.web.access': { tr: 'DeciShip web uygulamasına giriş', en: 'Sign in to the DeciShip web app' },
  'deciship.settings.manage': { tr: 'Ayarları yönetme', en: 'Manage settings' },
  'deciship.tariffs.view': { tr: 'Tarifeleri görme', en: 'View tariffs' },
  'deciship.tariffs.edit': { tr: 'Tarifeleri düzenleme', en: 'Edit tariffs' },
  // Yükleme izni faturanın başlığını düzeltmeyi ve faturayı silmeyi de kapsar (Y123 kararı); etiket bunu söyler.
  'deciship.invoices.upload': { tr: 'Fatura yükleme, düzeltme ve silme', en: 'Upload, correct and delete invoices' },
  'deciship.lines.decide': { tr: 'Fark kararı verme', en: 'Decide on discrepancies' },
  'deciship.disputes.manage': { tr: 'İtiraz gönderme ve sonucunu girme', en: 'Send disputes and record outcomes' },
  'deciship.invoices.view': { tr: 'Faturaları görme', en: 'View invoices' },
  'deciship.reports.view': { tr: 'Raporları görme', en: 'View reports' },
  'deciship.data.export': { tr: 'Veriyi dışa aktarma', en: 'Export data' },
  'deciship.measurements.capture': { tr: 'Ölçüm yapma', en: 'Capture measurements' },
  'deciship.measurements.view_all': { tr: 'Tüm ölçümleri görme', en: 'View all measurements' },
  'deciship.measurements.manage': { tr: 'Ölçümleri yönetme', en: 'Manage measurements' },
  'deciship.prices.view': { tr: 'Fiyatları görme', en: 'View prices' },
} as const;
type DeciShipPermission = keyof typeof DECISHIP_PERMISSION_LABEL;
/** Yönetici rolü: bütün izinler, yazım sırasıyla. */
const DECISHIP_ALL = Object.keys(DECISHIP_PERMISSION_LABEL) as DeciShipPermission[];

/** Geçit amaçları: DeciShip `AiKind` küçük harfle (`INVOICE_PDF` → `deciship.invoice_pdf`); etiketler Merkez `aiUsage.kind.*` ile aynı. */
const DECISHIP_AI_PURPOSES = {
  'deciship.scale_read': { tr: 'Tartı okuma', en: 'Scale reading' },
  'deciship.invoice_pdf': { tr: 'PDF fatura okuma', en: 'PDF invoice reading' },
  'deciship.invoice_mapping': { tr: 'Sütun eşleme', en: 'Column mapping' },
  'deciship.tariff_pdf_discover': { tr: 'Tarife PDF tarama', en: 'Tariff PDF scan' },
  'deciship.tariff_pdf_extract': { tr: 'Tarife PDF okuma', en: 'Tariff PDF extraction' },
  'deciship.tariff_review': { tr: 'Tarife incelemesi', en: 'Tariff review' },
} as const;

// ---------- TagPress ----------

const TAGPRESS_PERMISSION_LABEL = {
  'tagpress.web.access': { tr: 'TagPress web uygulamasına giriş', en: 'Sign in to the TagPress web app' },
  'tagpress.work.edit': { tr: 'Etiket, şablon ve baskı işlerini değiştirme', en: 'Edit labels, templates and print jobs' },
  'tagpress.ai.use': { tr: 'Yapay zekâ kullanma', en: 'Use AI' },
  'tagpress.settings.manage': { tr: 'Ayarlar, özellikler ve kurulum', en: 'Settings, features and setup' },
  'tagpress.reports.view': { tr: 'Raporları ve verileri görme', en: 'View reports and data' },
  'tagpress.data.export': { tr: 'Veriyi dışa aktarma', en: 'Export data' },
} as const;
type TagPressPermission = keyof typeof TAGPRESS_PERMISSION_LABEL;
const TAGPRESS_ALL = Object.keys(TAGPRESS_PERMISSION_LABEL) as TagPressPermission[];

/**
 * Geçit amaçları: TagPress'in `ai_calls.purpose` değerleri, `-` → `_`. Temel amaçlar (`design`, `rank`, `transcribe`, `image`)
 * üretimde; aynıları şablon görevinde (`sablon-*`), deneme üretiminde (`deneme-*`) ve oluşturucu denemesinde (`builder-try-*`) önekli.
 */
const TAGPRESS_AI_PURPOSES = {
  'tagpress.design': { tr: 'Tasarım önerisi', en: 'Design proposal' },
  'tagpress.rank': { tr: 'Aday seçimi', en: 'Candidate ranking' },
  'tagpress.transcribe': { tr: 'Görseldeki yazıyı okuma', en: 'Reading text in images' },
  'tagpress.image': { tr: 'Görsel üretimi', en: 'Image generation' },
  'tagpress.builder_turn': { tr: 'Tasarım dili oluşturucu', en: 'Design language builder' },
  'tagpress.builder_transcribe': { tr: 'Oluşturucu: örnek okuma', en: 'Builder: reading samples' },
  'tagpress.builder_try_design': { tr: 'Oluşturucu denemesi: tasarım önerisi', en: 'Builder trial: design proposal' },
  'tagpress.builder_try_rank': { tr: 'Oluşturucu denemesi: aday seçimi', en: 'Builder trial: candidate ranking' },
  'tagpress.builder_try_transcribe': { tr: 'Oluşturucu denemesi: yazı okuma', en: 'Builder trial: reading text' },
  'tagpress.builder_try_image': { tr: 'Oluşturucu denemesi: görsel üretimi', en: 'Builder trial: image generation' },
  'tagpress.sablon_design': { tr: 'Şablon görevi: tasarım önerisi', en: 'Template task: design proposal' },
  'tagpress.sablon_rank': { tr: 'Şablon görevi: aday seçimi', en: 'Template task: candidate ranking' },
  'tagpress.sablon_transcribe': { tr: 'Şablon görevi: yazı okuma', en: 'Template task: reading text' },
  'tagpress.sablon_image': { tr: 'Şablon görevi: görsel üretimi', en: 'Template task: image generation' },
  'tagpress.deneme_design': { tr: 'Deneme üretimi: tasarım önerisi', en: 'Trial run: design proposal' },
  'tagpress.deneme_rank': { tr: 'Deneme üretimi: aday seçimi', en: 'Trial run: candidate ranking' },
  'tagpress.deneme_transcribe': { tr: 'Deneme üretimi: yazı okuma', en: 'Trial run: reading text' },
  'tagpress.deneme_image': { tr: 'Deneme üretimi: görsel üretimi', en: 'Trial run: image generation' },
} as const;

export const PRODUCT_REGISTRY = [
  defineProduct({
    key: 'deciship',
    name: 'DeciShip',
    tagline: { tr: 'Kargo faturasındaki fazlayı bulun', en: 'Find overcharges on your carrier invoices' },
    color: PRODUCT_PALETTE.deciship.main,
    mark: 'deciship-mark.svg',
    launch: 'public',
    permissions: DECISHIP_PERMISSION_LABEL,
    webAccess: 'deciship.web.access',
    ownerRole: 'ADMIN',
    inviteRole: 'MEASURE',
    hub: { analytics: 'deciship.reports.view', data: 'deciship.invoices.view', export: 'deciship.data.export', headline: ['overcharge', 'open', 'deadlines'] },
    // v1: `invoices.view` ve `data.export` fiyat izni ister. Fatura kaynak dosyası (`routes/files.ts`) ve xlsx/pdf raporu
    // (`routes/invoices.ts`) tutarı ayıklamadan verir; fiyatsız özel rol bu yoldan tutar görmesin (plan, "gizli para sızıntısı").
    permissionRequires: {
      'deciship.settings.manage': ['deciship.web.access', 'deciship.prices.view'],
      'deciship.tariffs.view': ['deciship.web.access', 'deciship.prices.view'],
      'deciship.tariffs.edit': ['deciship.tariffs.view'],
      'deciship.invoices.upload': ['deciship.invoices.view', 'deciship.prices.view', 'deciship.web.access'],
      'deciship.lines.decide': ['deciship.invoices.view', 'deciship.prices.view', 'deciship.web.access'],
      'deciship.disputes.manage': ['deciship.invoices.view'],
      'deciship.invoices.view': ['deciship.prices.view'],
      'deciship.data.export': ['deciship.invoices.view', 'deciship.prices.view'],
      'deciship.measurements.manage': ['deciship.measurements.view_all'],
    },
    permissionGroups: [
      { key: 'web', label: { tr: 'Web uygulaması', en: 'Web app' }, permissions: ['deciship.web.access'] },
      {
        key: 'invoices',
        label: { tr: 'Fatura', en: 'Invoices' },
        permissions: ['deciship.invoices.view', 'deciship.invoices.upload', 'deciship.lines.decide', 'deciship.disputes.manage'],
      },
      { key: 'reports', label: { tr: 'Rapor', en: 'Reports' }, permissions: ['deciship.reports.view', 'deciship.data.export'] },
      { key: 'tariffs', label: { tr: 'Tarife', en: 'Tariffs' }, permissions: ['deciship.tariffs.view', 'deciship.tariffs.edit'] },
      {
        key: 'measurements',
        label: { tr: 'Ölçüm', en: 'Measurements' },
        permissions: ['deciship.measurements.capture', 'deciship.measurements.view_all', 'deciship.measurements.manage'],
      },
      { key: 'prices', label: { tr: 'Fiyat', en: 'Prices' }, permissions: ['deciship.prices.view'] },
      { key: 'settings', label: { tr: 'Ayarlar', en: 'Settings' }, permissions: ['deciship.settings.manage'] },
    ],
    lockedRoles: ['ADMIN'],
    // 03-B11: ayar izni (bağlantılar, yapay zekâ anahtarı, kurallar) yalnız firma sahibinin verebileceği izindir.
    ownerOnlyPermissions: ['deciship.settings.manage'],
    roles: [
      {
        key: 'ADMIN',
        label: { tr: 'Yönetici', en: 'Admin' },
        description: { tr: 'Kurulum ve ayarlar dahil her şey.', en: 'Everything, including setup and settings.' },
        permissions: DECISHIP_ALL,
      },
      {
        key: 'AUDITOR',
        label: { tr: 'Denetleyici', en: 'Auditor' },
        description: {
          tr: 'Tarife, fatura ve fark kararları. Ayarlara giremez.',
          en: 'Tariffs, invoices and discrepancy decisions. No settings.',
        },
        permissions: [
          'deciship.web.access',
          'deciship.tariffs.view',
          'deciship.tariffs.edit',
          'deciship.invoices.upload',
          'deciship.lines.decide',
          'deciship.invoices.view',
          'deciship.reports.view',
          'deciship.data.export',
          'deciship.measurements.capture',
          'deciship.measurements.view_all',
          'deciship.measurements.manage',
          'deciship.prices.view',
        ],
      },
      {
        key: 'ACCOUNTING',
        label: { tr: 'Muhasebe', en: 'Accounting' },
        description: {
          tr: 'Fatura yükler. Fatura, tarife ve raporları görür, dışa aktarır. İtirazı gönderir ve sonucunu girer.',
          en: 'Uploads invoices. Views and exports invoices, tariffs and reports. Sends disputes and records their outcome.',
        },
        // Y123 (Mesaj 14 kararı 10): kargo faturası çoğu firmada muhasebeye gelir; yükleme izni başlık düzeltme ve silmeyi de getirir.
        // Fark kararı (`lines.decide`), tarife düzenleme ve ayar yok.
        permissions: [
          'deciship.web.access',
          'deciship.tariffs.view',
          'deciship.invoices.upload',
          'deciship.disputes.manage',
          'deciship.invoices.view',
          'deciship.reports.view',
          'deciship.data.export',
          'deciship.measurements.view_all',
          'deciship.prices.view',
        ],
      },
      {
        key: 'MEASURE',
        label: { tr: 'Ölçüm', en: 'Measurement' },
        description: {
          tr: 'Mobil uygulamada ölçüm yapar. Fiyat görmez.',
          en: 'Measures in the mobile app. Does not see prices.',
        },
        permissions: ['deciship.measurements.capture'],
      },
    ],
    // Gövde sınırı: DeciShip dosya sınırı 30 MiB (fatura, tarife), ölçümde en çok 20 fotoğraf x 8 MiB; eski web nginx'inin 50m değeri.
    // Okuma süresi: yapay zekâ çağrıları 60 sn x 3 deneme + pay.
    deploy: {
      api: { service: 'deciship-api', port: 4000, maxBody: '50m', bodyTimeout: '120s', readTimeout: '240s', dev: 4000 },
      web: { service: 'deciship-web', port: 80, dev: 5173 },
    },
    site: { tr: '/urunler/deciship/', en: '/en/products/deciship/' },
    mobile: { entry: '/deciship/today' },
    // Tavan: bugünkü 1.500 TL (kur 100) [V]. Model `CLAUDE_MODEL`; yedekler (`FALLBACK_MODELS`) fiyat tablosundan sayılır.
    ai: { purposes: DECISHIP_AI_PURPOSES, models: ['claude-sonnet-5-5'], defaultCapUsd: 15 },
  }),
  defineProduct({
    key: 'orderloom',
    name: 'OrderLoom',
    tagline: { tr: 'Siparişi ve ekibi tek yerden yönetin', en: 'Manage orders and your team in one place' },
    color: PRODUCT_PALETTE.orderloom.main,
    mark: 'orderloom-mark.svg',
    launch: 'off',
    permissions: {},
    roles: [],
    ownerRole: null,
    inviteRole: null,
    site: { tr: '/urunler/orderloom/', en: '/en/products/orderloom/' },
  }),
  defineProduct({
    key: 'tagpress',
    name: 'TagPress',
    tagline: { tr: 'Etiketinizi yapay zekâyla hazırlayın', en: 'Create your labels with AI' },
    color: PRODUCT_PALETTE.tagpress.main,
    mark: 'tagpress-mark.svg',
    launch: 'pilot',
    permissions: TAGPRESS_PERMISSION_LABEL,
    webAccess: 'tagpress.web.access',
    ownerRole: 'ADMIN',
    inviteRole: 'USER',
    lockedRoles: ['ADMIN'],
    ownerOnlyPermissions: ['tagpress.settings.manage'],
    hub: { analytics: 'tagpress.reports.view', data: 'tagpress.reports.view', export: 'tagpress.data.export', headline: ['approved', 'pending', 'printed'] },
    permissionRequires: {
      'tagpress.work.edit': ['tagpress.web.access'],
      'tagpress.ai.use': ['tagpress.web.access'],
      'tagpress.settings.manage': ['tagpress.web.access', 'tagpress.work.edit'],
      'tagpress.data.export': ['tagpress.reports.view'],
    },
    permissionGroups: [
      { key: 'web', label: { tr: 'Web uygulaması', en: 'Web app' }, permissions: ['tagpress.web.access'] },
      { key: 'work', label: { tr: 'İş', en: 'Work' }, permissions: ['tagpress.work.edit'] },
      { key: 'ai', label: { tr: 'Yapay zekâ', en: 'AI' }, permissions: ['tagpress.ai.use'] },
      { key: 'reports', label: { tr: 'Rapor', en: 'Reports' }, permissions: ['tagpress.reports.view', 'tagpress.data.export'] },
      { key: 'settings', label: { tr: 'Ayarlar', en: 'Settings' }, permissions: ['tagpress.settings.manage'] },
    ],
    roles: [
      {
        key: 'ADMIN',
        label: { tr: 'Yönetici', en: 'Admin' },
        description: { tr: 'Ayarlar ve anahtarlar dahil her şey.', en: 'Everything, including settings and keys.' },
        permissions: TAGPRESS_ALL,
      },
      {
        key: 'USER',
        label: { tr: 'Kullanıcı', en: 'User' },
        description: { tr: 'Ayarlar dışında her şey.', en: 'Everything except settings.' },
        permissions: TAGPRESS_ALL.filter((p) => p !== 'tagpress.settings.manage'),
      },
    ],
    // Gövde sınırı: görsel ve şablon yüklemeleri; okuma süresi: yapay zekâ ve baskı üretimi uzun sürebilir.
    deploy: {
      api: { service: 'tagpress-api', port: 4200, maxBody: '50m', bodyTimeout: '120s', readTimeout: '300s', dev: 5422 },
      web: { service: 'tagpress-web', port: 80, dev: 5423 },
    },
    site: { tr: '/urunler/tagpress/', en: '/en/products/tagpress/' },
    // Modeller TagPress `domain/ai.ts` `MODELS` (günlük, oluşturucu, görsel); oluşturucunun yedekleri fiyat tablosundan. Tavan [V].
    ai: { purposes: TAGPRESS_AI_PURPOSES, models: ['claude-haiku-5-5', 'claude-opus-5-5', 'gemini-3.1-flash-image'], defaultCapUsd: 20 },
  }),
] as const;

// ---------- Saf yardımcılar (ham girdi üzerinde; kayıtta olmayan test fikstürleri de kullanır) ----------

const NO_PERMISSIONS: readonly string[] = Object.freeze([]);

/** Rolün izinleri. Bilinmeyen, boş ya da null rolde boş dizi. auth-kit ve product-kit dikişi bunu kullanır. */
export function rolePermissions<P extends string>(entry: { roles: readonly ProductRoleEntry<P>[] }, role: string | null | undefined): readonly P[] {
  if (!role) return NO_PERMISSIONS as readonly P[];
  return entry.roles.find((r) => r.key === role)?.permissions ?? (NO_PERMISSIONS as readonly P[]);
}

/** İzin bağımlılığı hesaplarının gördüğü alanlar (kayıt girdisi, `ProductDef` ya da test fikstürü). */
export type PermissionGraph = {
  permissions: Readonly<Record<string, unknown>>;
  permissionRequires?: Readonly<Partial<Record<string, readonly string[]>>>;
};

/** `validateRolePermissions` sonucu; `400 INVALID_ROLE_PERMISSIONS` ayrıntısı da `{ missing, unknown }` biçimindedir. */
export type RolePermissionsCheck =
  | { ok: true }
  | {
      ok: false;
      /** Setteki izin ve onun sette olmayan bütün (geçişli) gereksinimleri, katalog sırasıyla. */
      missing: { perm: string; requires: string[] }[];
      /** Bu aracın listesinde olmayan anahtarlar, geldiği sırayla, tekil. */
      unknown: string[];
    };

/**
 * Bağımlılıkla kapanmış set: bilinen izinler + geçişli bütün gereksinimleri, katalog sırasıyla, tekil.
 * Listede olmayan anahtar düşer (raporlamak için `checkRolePermissions`).
 */
export function closeEntryPermissions(entry: PermissionGraph, perms: Iterable<string>): string[] {
  const has = (p: string) => Object.hasOwn(entry.permissions, p);
  const out = new Set<string>();
  const stack = [...perms].filter(has);
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    for (const r of entry.permissionRequires?.[p] ?? []) if (has(r) && !out.has(r)) stack.push(r);
  }
  return Object.keys(entry.permissions).filter((p) => out.has(p));
}

/** Bir iznin geçişli gereksinimleri (kendisi hariç), katalog sırasıyla. Bilinmeyen izinde boş. */
export function requiredEntryPermissions(entry: PermissionGraph, perm: string): string[] {
  if (!Object.hasOwn(entry.permissions, perm)) return [];
  return closeEntryPermissions(entry, [perm]).filter((p) => p !== perm);
}

/** Bir izin setinin bağımlılıkları karşılayıp karşılamadığı; kendiliğinden izin eklemez. Boş set geçerlidir. */
export function checkRolePermissions(entry: PermissionGraph, perms: readonly string[]): RolePermissionsCheck {
  const unknown = [...new Set(perms.filter((p) => !Object.hasOwn(entry.permissions, p)))];
  const set = new Set(perms);
  const missing: { perm: string; requires: string[] }[] = [];
  for (const p of Object.keys(entry.permissions)) {
    if (!set.has(p)) continue;
    const requires = requiredEntryPermissions(entry, p).filter((r) => !set.has(r));
    if (requires.length) missing.push({ perm: p, requires });
  }
  return missing.length || unknown.length ? { ok: false, missing, unknown } : { ok: true };
}

/**
 * Anahtar olamayan adlar: Merkez'in kendi yolları (hub-web `lib/nav.ts` HUB_OWN_PATHS ve giriş sayfaları; contracts testi uyumu denetler),
 * gateway'in ve Hesap servisinin yolları ve nginx değişken adları (`$hub_web`, `$account_api`).
 * Böyle bir anahtar Merkez sayfalarını kendine çeker, sessizce etkisiz kalır ya da nginx'i açtırmaz.
 */
export const RESERVED_PRODUCT_KEYS: readonly string[] = [
  'home', 'analytics', 'data', 'activity', 'account', 'invite', 'platform', 'login', 'register', 'join',
  'api', 'assets', 'healthz', 'internal', 'hub', 'orgs', 'me', 'catalog', 'favicon',
];

const KEY_RE = /^[a-z][a-z0-9]{2,19}$/;
const ROLE_RE = /^[A-Z][A-Z_]{1,19}$/;
const GROUP_RE = /^[a-z][a-z_]{1,19}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]*$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const AI_PURPOSE_RE = /^[a-z][a-z0-9]{2,19}\.[a-z][a-z0-9_]{1,39}$/;
const AI_MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;

function validPort(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536;
}

/** Bir dizi kayıt girdisini denetler; hata yoksa boş dizi. Metinler geliştirici içindir (test ve açılış günlüğü). */
export function validateRegistry(entries: readonly ProductEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const k = e.key;
    const at = (msg: string) => errors.push(`${k}: ${msg}`);
    if (!KEY_RE.test(k)) at('anahtar /^[a-z][a-z0-9]{2,19}$/ biçiminde değil');
    if (RESERVED_PRODUCT_KEYS.includes(k)) at('anahtar ayrılmış (Merkez, gateway ya da Hesap yolu/adı)');
    if (seen.has(k)) at('anahtar tekil değil');
    seen.add(k);
    if (!e.name.trim()) at('ad boş');
    if (!e.tagline.tr.trim() || !e.tagline.en.trim()) at('slogan her dilde dolu olmalı');
    if (!COLOR_RE.test(e.color)) at(`renk #rrggbb değil: ${e.color}`);
    if (!(PRODUCT_LAUNCHES as readonly string[]).includes(e.launch)) at(`bilinmeyen durum: ${String(e.launch)}`);
    if (e.mark !== undefined && !/^[a-z0-9][a-z0-9-]*\.svg$/.test(e.mark)) at(`işaret dosya adı geçersiz: ${e.mark}`);

    const perms = Object.keys(e.permissions);
    const permSet = new Set(perms);
    for (const p of perms) {
      if (!p.startsWith(`${k}.`) || p.length <= k.length + 1) at(`izin "${k}." önekli değil: ${p}`);
      const label = (e.permissions as Record<string, { tr: string; en: string }>)[p];
      if (!label?.tr?.trim() || !label?.en?.trim()) at(`izin etiketi eksik: ${p}`);
    }

    const roleKeys = new Set<string>();
    for (const r of e.roles) {
      if (!ROLE_RE.test(r.key)) at(`rol anahtarı /^[A-Z][A-Z_]{1,19}$/ biçiminde değil: ${r.key}`);
      if (roleKeys.has(r.key)) at(`rol tekil değil: ${r.key}`);
      roleKeys.add(r.key);
      for (const p of r.permissions) if (!permSet.has(p)) at(`${r.key} rolünde listede olmayan izin: ${p}`);
    }
    if (e.ownerRole !== null && !roleKeys.has(e.ownerRole)) at(`sahip rolü rollerde yok: ${e.ownerRole}`);
    if (e.inviteRole !== null && !roleKeys.has(e.inviteRole)) at(`davet rolü rollerde yok: ${e.inviteRole}`);

    // İzin bağımlılıkları, kilitli roller, sahibe özel izinler ve izin kümeleri (özel roller).
    const requires = (e.permissionRequires ?? {}) as Readonly<Partial<Record<string, readonly string[]>>>;
    for (const [p, list] of Object.entries(requires)) {
      if (!permSet.has(p)) at(`bağımlılığı yazılan izin listede yok: ${p}`);
      for (const r of list ?? []) {
        if (!permSet.has(r)) at(`${p} izninin gereksinimi listede yok: ${r}`);
        if (r === p) at(`izin kendini gerektiriyor: ${p}`);
      }
    }
    for (const r of e.roles) {
      const check = checkRolePermissions(e, r.permissions);
      if (check.ok) continue;
      for (const m of check.missing) at(`${r.key} rolü bağımlılığı karşılamıyor: ${m.perm} → ${m.requires.join(', ')}`);
    }
    for (const role of e.lockedRoles ?? []) if (!roleKeys.has(role)) at(`kilitli rol rollerde yok: ${role}`);
    if (e.lockedRoles && e.ownerRole !== null && !e.lockedRoles.includes(e.ownerRole)) at(`sahip rolü kilitli rollerde yok: ${e.ownerRole}`);
    for (const p of e.ownerOnlyPermissions ?? []) if (!permSet.has(p)) at(`sahibe özel izin listede yok: ${p}`);
    if (e.permissionGroups) {
      const groupKeys = new Set<string>();
      const grouped = new Set<string>();
      for (const g of e.permissionGroups) {
        if (!GROUP_RE.test(g.key)) at(`izin kümesi anahtarı /^[a-z][a-z_]{1,19}$/ biçiminde değil: ${g.key}`);
        if (groupKeys.has(g.key)) at(`izin kümesi tekil değil: ${g.key}`);
        groupKeys.add(g.key);
        if (!g.label?.tr?.trim() || !g.label?.en?.trim()) at(`izin kümesi etiketi eksik: ${g.key}`);
        if (g.permissions.length === 0) at(`izin kümesi boş: ${g.key}`);
        for (const p of g.permissions) {
          if (!permSet.has(p)) at(`${g.key} kümesinde listede olmayan izin: ${p}`);
          if (grouped.has(p)) at(`izin birden çok kümede: ${p}`);
          grouped.add(p);
        }
      }
      for (const p of perms) if (!grouped.has(p)) at(`izin hiçbir kümede değil: ${p}`);
    }

    if (e.webAccess !== undefined && !permSet.has(e.webAccess)) at(`web giriş izni listede yok: ${e.webAccess}`);
    if (e.hub) {
      for (const p of [e.hub.analytics, e.hub.data, e.hub.export]) if (!permSet.has(p)) at(`Merkez izni listede yok: ${p}`);
    }

    const api = e.deploy?.api;
    const web = e.deploy?.web;
    for (const [name, d] of [['api', api], ['web', web]] as const) {
      if (!d) continue;
      if (!SERVICE_RE.test(d.service)) at(`deploy.${name}.service geçersiz: ${d.service}`);
      if (!validPort(d.port)) at(`deploy.${name}.port geçersiz: ${d.port}`);
      if (d.dev !== undefined && !validPort(d.dev)) at(`deploy.${name}.dev geçersiz: ${d.dev}`);
    }
    if (api?.maxBody !== undefined && !/^[1-9][0-9]*m$/.test(api.maxBody)) at(`deploy.api.maxBody geçersiz: ${api.maxBody}`);
    if (api?.bodyTimeout !== undefined && !/^[1-9][0-9]*s$/.test(api.bodyTimeout)) at(`deploy.api.bodyTimeout geçersiz: ${api.bodyTimeout}`);
    if (api?.readTimeout !== undefined && !/^[1-9][0-9]*s$/.test(api.readTimeout)) at(`deploy.api.readTimeout geçersiz: ${api.readTimeout}`);
    if (web && e.webAccess === undefined) at('deploy.web var ama webAccess yok');

    if (e.site) {
      for (const l of LOCALES) if (!e.site[l].startsWith('/') || !e.site[l].endsWith('/')) at(`site.${l} "/" ile başlayıp bitmeli: ${e.site[l]}`);
    }
    if (e.mobile && !e.mobile.entry.startsWith('/')) at(`mobile.entry "/" ile başlamalı: ${e.mobile.entry}`);

    // Yapay zekâ geçidi: amaç `<anahtar>.<amaç>` (ai.ts `AI_PURPOSE_PATTERN` ile aynı kural), model izin listesi, tavan.
    if (e.ai) {
      const purposes = Object.entries(e.ai.purposes as Readonly<Record<string, LocalizedText>>);
      if (purposes.length === 0) at('ai.purposes boş');
      for (const [p, label] of purposes) {
        if (!p.startsWith(`${k}.`) || !AI_PURPOSE_RE.test(p)) at(`ai amacı "${k}.<amaç>" (küçük harf, rakam, _) biçiminde değil: ${p}`);
        if (!label?.tr?.trim() || !label?.en?.trim()) at(`ai amacı etiketi eksik: ${p}`);
      }
      if (e.ai.models.length === 0) at('ai.models boş');
      if (new Set(e.ai.models).size !== e.ai.models.length) at('ai.models tekil değil');
      for (const m of e.ai.models) if (!AI_MODEL_RE.test(m)) at(`ai modeli adı geçersiz: ${m}`);
      if (!Number.isFinite(e.ai.defaultCapUsd) || e.ai.defaultCapUsd <= 0) at(`ai.defaultCapUsd sıfırdan büyük sayı değil: ${e.ai.defaultCapUsd}`);
    }

    if (e.launch !== 'off') {
      if (e.roles.length === 0) at(`${e.launch} araçta rol yok`);
      if (e.ownerRole === null) at(`${e.launch} araçta sahip rolü yok`);
      if (!api) at(`${e.launch} araçta deploy.api yok`);
      if (perms.length > 0 && !e.permissionGroups) at(`${e.launch} araçta permissionGroups yok (rol düzenleyici)`);
    }
  }
  return errors;
}
