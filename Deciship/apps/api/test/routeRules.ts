import crypto from 'node:crypto';
import { closePermissions, customRoleKey, permissionsOf, PRODUCTS, type Permission } from '@sellerondata/contracts';

/**
 * Her uç için beklenen erişim. Tek kaynak: izin matrisi, firma izolasyonu, para sızıntısı ve READ_ONLY testleri bu
 * tabloyla Fastify'ın yol listesini karşılaştırır. Tabloda olmayan uç test başarısız olur.
 *
 * - `public`: jeton istemez, kendi doğrulaması vardır ya da veri taşımaz.
 * - `session`: üründe rolü olan herkes (içerik iznine göre süzülür).
 * - izin listesi: izinlerden biri yeter.
 * - `{ all }`: izinlerin hepsi gerekir.
 */
export type RouteRule = 'public' | 'session' | readonly Permission[] | { all: readonly Permission[] };

const p = (...permissions: Permission[]) => permissions;

const SETTINGS = p('deciship.settings.manage');
const TARIFFS = p('deciship.tariffs.edit');
const TARIFFS_VIEW = p('deciship.tariffs.view');
const UPLOAD = p('deciship.invoices.upload');
const VIEW = p('deciship.invoices.view');
const REPORTS = p('deciship.reports.view');
const DECIDE = p('deciship.lines.decide');
const EXPORT = p('deciship.data.export');
/**
 * Fiyatlı ikili dosya (rapor XLSX/PDF): `stripMoney` işlemez, dışa aktarma izninin yanında fiyat izni de gerekir. Hesap
 * `data.export → prices.view` bağımlılığını zorunlu tutar (özel roller v1); bu ikinci kat bozuk jetona karşıdır.
 */
const EXPORT_PRICED = { all: p('deciship.data.export', 'deciship.prices.view') } as const;
const DISPUTES = p('deciship.disputes.manage');
const CAPTURE = p('deciship.measurements.capture');
const READ_MEASUREMENTS = p('deciship.measurements.capture', 'deciship.measurements.view_all');
const WRITE_MEASUREMENTS = p('deciship.measurements.capture', 'deciship.measurements.manage');
const READ_CARRIERS = p('deciship.tariffs.edit', 'deciship.invoices.upload', 'deciship.invoices.view');
/** Arka plan işleri: üç izinden biri; işin kendi türünün izni işleyicide (yoksa 404). */
const JOBS = p('deciship.invoices.upload', 'deciship.tariffs.edit', 'deciship.settings.manage');

export const ROUTE_RULES: Record<string, RouteRule> = {
  'GET /health': 'public',
  'POST /internal/events': 'public',

  'GET /me': 'session',
  'GET /members': p('deciship.measurements.view_all'),

  'GET /settings': 'session',
  'PATCH /settings': SETTINGS,
  'GET /settings/onboarding': SETTINGS,
  'PATCH /settings/onboarding': SETTINGS,
  'POST /settings/data/reset': SETTINGS,
  'POST /settings/recompare-invoices/preview': SETTINGS,
  'POST /settings/recompare-invoices': SETTINGS,
  'POST /settings/demo': SETTINGS,
  'DELETE /settings/demo': SETTINGS,

  'GET /box-presets': CAPTURE,
  'POST /box-presets': SETTINGS,
  'PATCH /box-presets/:id': SETTINGS,
  'DELETE /box-presets/:id': SETTINGS,

  'GET /measurements/check': CAPTURE,
  'GET /measurements/stats/today': READ_MEASUREMENTS,
  'POST /measurements': CAPTURE,
  'GET /measurements': READ_MEASUREMENTS,
  'GET /measurements/:id': READ_MEASUREMENTS,
  'PATCH /measurements/:id': WRITE_MEASUREMENTS,
  'DELETE /measurements/:id': WRITE_MEASUREMENTS,
  'POST /measurements/:id/restore': WRITE_MEASUREMENTS,
  // kalıcı silme (kullanıcı kararı 2026-11-13): yalnız yönetme izni, kendi ölçümü için ölçüm izni yetmez
  'POST /measurements/:id/purge': p('deciship.measurements.manage'),

  // İçerik izne göre (routes/files.ts): fatura kaynağı `invoices.view` + `prices.view`, fotoğraf `view_all` ya da kendi ölçümü.
  'GET /files/:id': 'session',
  'GET /reference-card.pdf': CAPTURE,

  'POST /vision/scale': CAPTURE,
  'POST /vision/reference/detect': CAPTURE,
  'POST /vision/reference/solve': CAPTURE,

  'GET /carriers': READ_CARRIERS,
  'POST /carriers': SETTINGS,
  'PATCH /carriers/:id': SETTINGS,
  'DELETE /carriers/:id': SETTINGS,

  // Doldurulmuş şablon fiyat taşır (ikili dosya): fiyat izni de (routes/tariffs.ts).
  'GET /tariffs/template.xlsx': { all: [...TARIFFS, 'deciship.prices.view'] },
  'GET /tariffs': TARIFFS_VIEW,
  'POST /tariffs': TARIFFS,
  'GET /tariffs/:id': TARIFFS_VIEW,
  'PUT /tariffs/:id': TARIFFS,
  'DELETE /tariffs/:id': TARIFFS,
  'POST /tariffs/:id/default': TARIFFS,
  'POST /tariffs/:id/duplicate': TARIFFS,
  'POST /tariffs/:id/import': TARIFFS,
  'POST /tariff-imports': TARIFFS,
  'GET /tariff-documents/:documentId': TARIFFS_VIEW,
  'POST /tariff-documents/:documentId/scan': TARIFFS,
  'POST /tariff-documents/:documentId/extract': TARIFFS,
  'POST /tariff-imports/:draftId/recheck': TARIFFS,
  'POST /tariff-imports/:draftId/review': TARIFFS,
  'POST /tariff-imports/:draftId/apply': TARIFFS,
  'GET /tariffs/:id/versions': TARIFFS_VIEW,
  'POST /tariffs/:id/versions/:versionId/restore': TARIFFS,
  'POST /tariffs/:id/recompare-invoices/preview': TARIFFS,
  'POST /tariffs/:id/recompare-invoices': TARIFFS,
  'POST /tariffs/:id/country-adjustments': TARIFFS,
  'POST /tariffs/:id/quote': TARIFFS_VIEW,

  'POST /invoices/preview': UPLOAD,
  'POST /invoices/preview/verify': UPLOAD,
  'POST /invoices/preview/ai-mapping': UPLOAD,
  // Mesaj 7: vazgeçilen önizlemenin dosyası (faturaya bağlıysa ya da işi sürüyorsa hiçbir şey silinmez).
  'DELETE /invoices/preview/:fileId': UPLOAD,
  // Y80-E2 / Y95: sürdürme bandının listesi ve açık önizlemenin tazelenmesi (yalnız üyenin kendi önizlemesi).
  'GET /invoices/preview/resumable': UPLOAD,
  'POST /invoices/preview/:fileId/keep': UPLOAD,
  'POST /invoices': UPLOAD,
  'POST /invoices/samples': SETTINGS,
  'GET /invoices': VIEW,
  'GET /invoices/:id': VIEW,
  'PATCH /invoices/:id': UPLOAD,
  'GET /invoices/:id/lines': VIEW,
  'PATCH /invoice-lines/:id': DECIDE,
  'POST /invoices/:id/lines/decide': DECIDE,
  'GET /invoices/:id/tariff-health': REPORTS,
  'POST /invoices/:id/recompare': DECIDE,
  // Mesaj 4: önce/sonra önizlemesi ve onayı. Karar verilmiş satırın rakamını değiştirebildiği için onay karar izniyle.
  // Y123: önizleme hiçbir şey yazmaz; yükleme izni yalnız başlık düzeltmenin önizlemesine girer (`basis: 'pinned'` + `patch`,
  // `lineIds` yok; kayıt `PATCH /invoices/:id`). Öbür kipler yükleme izniyle 403 (permissionMatrix "uç içi izinler").
  'POST /invoices/:id/recalculate/preview': p('deciship.lines.decide', 'deciship.invoices.upload'),
  'POST /invoices/:id/recalculate': DECIDE,
  'DELETE /invoices/:id': UPLOAD,
  'GET /invoices/:id/report.xlsx': EXPORT_PRICED,
  'GET /invoices/:id/report.pdf': EXPORT_PRICED,
  // Metin talep tutarlarını taşır: fiyat izni de (services/evidence.ts); ZIP ayrıca bütün ölçümlerin fotoğrafını.
  'GET /invoices/:id/dispute': EXPORT_PRICED,
  'GET /invoices/:id/dispute/evidence.zip': { all: [...EXPORT_PRICED.all, 'deciship.measurements.view_all'] },

  // İtiraz takibi: görme fatura izniyle, gönderme ve sonuç girme ayrı yazma izniyle.
  'GET /disputes': VIEW,
  'POST /invoices/:id/disputes': DISPUTES,
  'POST /disputes/:id/resend': DISPUTES,
  'POST /disputes/:id/withdraw': DISPUTES,
  'POST /disputes/:id/results': DISPUTES,
  'POST /dispute-results/:id/revert': DISPUTES,

  'GET /dashboard': REPORTS,

  // Mesaj 7: arka plan işleri. Durdurma salt okunur abonelikte kapalı (READ_ONLY_EXEMPT'te yok).
  'GET /jobs': JOBS,
  'GET /jobs/:jobId': JOBS,
  'POST /jobs/:jobId/cancel': JOBS,

  // Merkez sözleşmesi. Veri setinin kendi izni (ölçüm view_all, denetim reports.view) servistedir.
  'GET /platform/overview': REPORTS,
  'GET /platform/analytics': REPORTS,
  'GET /platform/activity': REPORTS,
  'GET /platform/datasets': VIEW,
  'GET /platform/datasets/:id': VIEW,
  // Dışa aktarma izni tek başına yetmez: veriyi görme izni de gerekir (routes/platform.ts).
  'GET /platform/datasets/:id/export': { all: [...EXPORT, ...VIEW] },
  // Yapay zekâ kullanımı (Mesaj 6): ayar izniyle; GET olduğu için salt okunur abonelikte de açık (READ_ONLY_EXEMPT gerekmez).
  'GET /platform/ai-usage': SETTINGS,
  // Ayrıntılı döküm: özetle aynı izin; Excel'i ayrıca dışa aktarma izni ister.
  'GET /platform/ai-usage/calls': SETTINGS,
  'GET /platform/ai-usage/calls/export': { all: [...SETTINGS, ...EXPORT] },
  // 06-B6: dosya alanı kullanımı
  'GET /platform/storage-usage': SETTINGS,
};

/** Salt okunur abonelikte de çalışan yazma yöntemli uçlar: durum değiştirmez. */
export const READ_ONLY_EXEMPT = new Set(['POST /tariffs/:id/quote']);

export const ROLES = ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE'] as const;
export type Role = (typeof ROLES)[number];

/** Kural bu izin setiyle açılıyor mu. Rol adına değil izinlere bakar (özel roller). */
export function permitted(rule: RouteRule, held: readonly string[]): boolean {
  if (rule === 'public' || rule === 'session') return true;
  if ('all' in rule) return rule.all.every((permission) => held.includes(permission));
  return rule.some((permission) => held.includes(permission));
}

export function roleAllowed(rule: RouteRule, role: string): boolean {
  return permitted(rule, permissionsOf('deciship', role));
}

// ---------- İzin setleri (özel roller) ----------

/** DeciShip izin kataloğu, katalog sırasıyla. */
export const ALL_PERMISSIONS = Object.keys(PRODUCTS.deciship.permissions) as Permission[];

/** Fiyat izni gerektirmeyen (bağımlılık kapanışında `prices.view` olmayan) izinlerin tamamı: fiyatsız en geniş geçerli set. */
export const NO_PRICE_MAX: readonly Permission[] = ALL_PERMISSIONS.filter((perm) => !closePermissions('deciship', [perm]).includes('deciship.prices.view'));

/**
 * Bağımlılığı bozuk set: fiyat dışında her izin. Hesap bunu üretmez (`invoices.view`, `data.export` → `prices.view`); para
 * sızıntısı testi sunucunun ikinci katını (rapor XLSX/PDF, fatura kaynağı, `stripMoney`) bununla sınar.
 */
export const BROKEN_NO_PRICE: readonly Permission[] = ALL_PERMISSIONS.filter((perm) => perm !== 'deciship.prices.view');

/**
 * Matrisin denediği set. `perms` yoksa hazır rol, eski biçim jeton (izinler rolden). Varsa jeton özel rol biçimindedir:
 * `role` (`custom:<uuid>` ya da düzenlenmiş hazır rolün anahtarı) yalnız ad, yetki `perms`ten.
 */
export type PermissionSet = { name: string; role: string; perms?: readonly Permission[] };

export const heldBy = (set: PermissionSet): readonly Permission[] => set.perms ?? permissionsOf('deciship', set.role);

const custom = () => customRoleKey(crypto.randomUUID());
const setKey = (perms: readonly string[]) => [...perms].sort().join(',');

/**
 * Hazır roller (eski jeton) + her iznin bağımlılıkla kapanmış tek başına seti + boş set + fiyatsız en geniş set +
 * düzenlenmiş hazır rol (Yönetici adıyla fiyatsız en geniş set). Aynı izin setini veren tekrarlar atılır.
 */
export const PERMISSION_SETS: readonly PermissionSet[] = (() => {
  const all: PermissionSet[] = [
    ...ROLES.map((role) => ({ name: role, role })),
    ...ALL_PERMISSIONS.map((perm) => ({ name: `yalnız ${perm}`, role: custom(), perms: closePermissions('deciship', [perm]) })),
    { name: 'boş liste', role: custom(), perms: [] },
    { name: 'fiyatsız en geniş', role: custom(), perms: NO_PRICE_MAX },
    { name: 'düzenlenmiş ADMIN (fiyatsız en geniş)', role: 'ADMIN', perms: NO_PRICE_MAX },
  ];
  const seen = new Set<string>();
  return all.filter((set) => {
    // düzenlenmiş hazır rol bilerek aynı seti taşır: rol adının yetki vermediğini kanıtlar
    const key = set.role === 'ADMIN' && set.perms ? 'düzenlenmiş' : setKey(heldBy(set));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})();
