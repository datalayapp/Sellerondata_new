import type { FastifyRequest } from 'fastify';
import { prisma } from '../db.ts';
import { can } from './access.ts';
import { DEFAULT_TIME_ZONE } from './time.ts';

export type CompanySettings = {
  edgeTolCm: number;
  weightTolKg: number;
  amountTol: number;
  desiDivisor: number;
  requiredBoxPhotos: number;
  /**
   * Mobilde akla aykırı ölçü uyarısı (Y44): bir kenar bu cm'yi ya da ağırlık bu kg'ı aşarsa kayıttan önce "Lütfen kontrol edin".
   * Yalnız uyarıdır; sunucu ölçümü bunlarla reddetmez ve hesaba girmez (`compareSettings` dayanağında yok).
   */
  warnEdgeCm: number;
  warnWeightKg: number;
  /**
   * Tartı fotoğrafını ücretli yapay zekâ okusun mu (kullanıcı kararı 2026-11-12; varsayılan kapalı, kayıtlı değer yoksa da kapalı).
   * Kapalıyken telefon fotoğrafı yalnız kanıt olarak saklar, ağırlık elle girilir; `POST /vision/scale` sağlayıcıya gitmeden 409
   * `AI_DISABLED` döner (`details.reason: 'scale_ai_off'`; eski mobil sürümler de tanır). Ölçen rol de görür (telefon buradan alır). Ücretsiz okuma (görüntü servisi) bu ayarın kapsamında değildir.
   */
  scaleAiRead: boolean;
  currency: string;
  /**
   * Firmanın ülkesi (ISO-2). Tek kaynak Merkez'dir (`org.updated`), DeciShip yazmaz. Varsayılanı yoktur: yoksa eski biçim olay
   * ya da henüz gelmemiş olaydır, `firmCountry` çözer. Okurken yazılmaz: çözülen değer Merkez'in söylediği gibi saklanmasın.
   */
  country?: string;
  /**
   * Firma bilgileri Merkez'de onaylandı mı (`org.updated` `companyConfirmed`). Ülke gibi tek kaynak Merkez'dir: DeciShip yazmaz,
   * `PATCH /settings` kabul etmez, ayar yanıtlarına girmez (kurulum yanıtında `company.confirmed`). `DEFAULT_SETTINGS`'te yoktur;
   * yeni açılan firma satırı `false` ile açılır (`identity.ts` `ensureCompany`). Okurken `companyConfirmedOf` çözer.
   */
  companyConfirmed?: boolean;
  /** Kur çevrilen satırlarda tolerans (%); SPEC §FX. */
  fxTolerancePct: number;
  /** Ölçümün hangi güne düştüğünü belirler (Pano, Merkez). IANA adı. */
  timeZone: string;
  /** Tarifede tanımlı olmayan ek ücretler satırı "Fark var" yapsın mı (varsayılan hayır: bilgi olarak listelenir). */
  unknownSurchargesAsDiff: boolean;
  /** İtiraz süresi hatırlatması (son güne 3 ve 1 gün kala e-posta); varsayılan açık. Yalnız ayar yetkisi olan görür ve yazar. */
  disputeReminders: boolean;
  /**
   * Örnek veriyle deneme turu açıksa başlangıç kaydı (MESAJ-14 §4.3). Yalnız `POST/DELETE /settings/demo` yazar, `PATCH /settings`
   * kabul etmez. Bandı herkes görür (`settingsFor`); `carrierIds` ve `loadingSince` sunucunundur, dışarı verilmez.
   */
  demo?: DemoFlag;
  /** İlk kurulum sihirbazının ilerlemesi (yalnız ayar yetkisi olan görür); bkz. `readOnboarding`. */
  onboarding?: OnboardingState;
};

/** Deneme turu bayrağı (`services/demoTour.ts`). */
export type DemoFlag = {
  startedAt: string;
  byMemberId: string | null;
  /** Başlatmada açılan örnek taşıyıcılar (önceden üretilen kimlikler). Bitirme yalnız bunları ve onlara bağlı kayıtları siler. */
  carrierIds?: string[];
  /** Örnek veri yüklenirken var (başlangıç anı); yükleme bitince kalkar. Süresi dolmamışken bitirme 409 DEMO_LOADING. */
  loadingSince?: string;
};

/**
 * İlk kurulum adımları (web: /kurulum). Sıra sihirbazdaki sıradır. `'sirket'` artık sihirbazda yok (firma bilgileri Merkez'de
 * onaylanır, `companyConfirmed`) ama listede kalır: kayıtlı eski ilerleme (`done: ['sirket']`, `step: 'sirket'`) ve eski
 * istemcinin `done: 'sirket'` isteği göçsüz çalışsın (400 almasın). Hiçbir kurala girmez.
 */
export const ONBOARDING_STEPS = ['sirket', 'tasiyicilar', 'faturalar', 'tarifeler', 'olcum', 'koliler', 'ozet'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Atlanırsa özette uyarı gösterilen adımlar. Firma adımı Merkez'in: burada yok. */
export const ONBOARDING_REQUIRED: OnboardingStep[] = ['tasiyicilar', 'tarifeler', 'olcum'];

export type OnboardingState = {
  /** Kaldığı adım: sihirbaz yeniden açılınca buradan devam eder. */
  step?: OnboardingStep;
  /** Kullanıcının "Kaydet ve devam et" ile onayladığı adımlar. */
  done?: OnboardingStep[];
  /** Bilerek atlanan adımlar. */
  skipped?: OnboardingStep[];
  startedAt?: string;
  completedAt?: string | null;
  /** Pano'daki "Kurulumu tamamlayın" bandı kapatıldı. */
  bannerDismissedAt?: string | null;
};

export function readOnboarding(raw: unknown): OnboardingState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // eski adım adı: "kalibrasyon" → "faturalar" (kayıtlı ilerleme bozulmasın)
  const legacy = (x: unknown) => (x === 'kalibrasyon' ? 'faturalar' : x);
  const isStep = (x: unknown): x is OnboardingStep => ONBOARDING_STEPS.includes(x as OnboardingStep);
  const steps = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(legacy).filter(isStep))] : []);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const step = legacy(o.step);
  return {
    step: isStep(step) ? step : undefined,
    done: steps(o.done),
    skipped: steps(o.skipped),
    startedAt: str(o.startedAt),
    completedAt: str(o.completedAt) ?? null,
    bannerDismissedAt: str(o.bannerDismissedAt) ?? null,
  };
}

/**
 * Kayıtlı kenar toleransı olmayan eski firmanın değeri: varsayılan 2026-11-14'te 1 cm'den 0,5 cm'ye indi (KALANLAR 1.10;
 * kenarlar zaten yukarı yuvarlanıyor, 1 cm en sık 1–2 desi şişirmesini "Uyumlu" gösteriyordu). Yeni firma 0,5'i kayıtlı
 * açılır (`DEFAULT_SETTINGS`); kayıtlı değeri olmayan firmanın hesabı sessizce değişmez (20261111120000 göçü de 1 yazar).
 */
export const LEGACY_EDGE_TOL_CM = 1;

export const DEFAULT_SETTINGS: CompanySettings = {
  edgeTolCm: 0.5,
  weightTolKg: 0.1,
  /** TRY firmanın varsayılanı; başka para biriminde `defaultAmountTol`. */
  amountTol: 5,
  desiDivisor: 3000,
  requiredBoxPhotos: 1,
  warnEdgeCm: 150,
  warnWeightKg: 70,
  scaleAiRead: false,
  currency: 'TRY',
  fxTolerancePct: 1.5,
  unknownSurchargesAsDiff: false,
  disputeReminders: true,
  timeZone: DEFAULT_TIME_ZONE,
};

/**
 * Tutar toleransını para birimleri arasında kabaca taşımak için birim değerleri (5 TL ≈ 0,50 USD/EUR/GBP; KARARLAR
 * "Tutar toleransı"). Yalnız firmanın varsayılan toleransı (`defaultAmountTol`) için; kur yokken toleransı çevirmek için
 * kullanılmaz (Y18: sabit yedek oran kalktı, `amountTolIn`).
 */
export const TOLERANCE_UNIT: Readonly<Record<string, number>> = { TRY: 1, USD: 0.1, EUR: 0.1, GBP: 0.1 };

/**
 * Firma para birimine göre varsayılan tutar toleransı: TRY 5; USD, EUR, GBP 0,5. Listede olmayan para biriminde 5
 * (bugünkü sayı). Merkez yalnız bu dört para birimini gönderir,
 * başkası yalnız elle yazılmış eski veride olur.
 */
export function defaultAmountTol(currency: string | null | undefined): number {
  const unit = TOLERANCE_UNIT[(currency ?? '').trim().toUpperCase()];
  return unit ? Math.round(DEFAULT_SETTINGS.amountTol * unit * 100) / 100 : DEFAULT_SETTINGS.amountTol;
}

export function readSettings(raw: unknown): CompanySettings {
  const obj = raw && typeof raw === 'object' ? (raw as Partial<CompanySettings>) : {};
  const s = { ...DEFAULT_SETTINGS, ...obj };
  // kayıtlı tolerans yoksa firmanın para biriminin varsayılanı (DEFAULT_SETTINGS'teki 5 TRY'nindir)
  if (typeof obj.amountTol !== 'number' || !Number.isFinite(obj.amountTol)) s.amountTol = defaultAmountTol(s.currency);
  if (typeof obj.edgeTolCm !== 'number' || !Number.isFinite(obj.edgeTolCm)) s.edgeTolCm = LEGACY_EDGE_TOL_CM;
  // Ücret doğuran tek anahtar: yalnız açıkça `true` yazılmışsa açık (eksik ya da bozuk değer kapalı).
  s.scaleAiRead = obj.scaleAiRead === true;
  return s;
}

/**
 * Firma bilgileri Merkez'de onaylı mı. Kayıtlı değer yoksa (bu alan gelmeden önce açılmış firma) onaylı sayılır: Hesap da
 * göçten önce açılmış her firmayı onaylı doldurur. Yalnız açıkça `false` onaysızdır (yeni firma, Merkez'in "onay bekliyor" olayı).
 */
export function companyConfirmedOf(settings: Pick<CompanySettings, 'companyConfirmed'>): boolean {
  return settings.companyConfirmed !== false;
}

/** Kullanıcı seçmediğinde yeni fatura ve tarifenin para birimi. Tek kaynak Merkez'dir (`org.updated`). */
export async function firmCurrency(companyId: string, db: Pick<typeof prisma, 'company'> = prisma): Promise<string> {
  const company = await db.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
  return readSettings(company.settings).currency;
}

/**
 * Firmanın ülkesi, bilinmiyorsa null. Türk Ticaret Kanunu süresi buna bağlıdır (`ttkApplies`):
 * - Merkez söylediyse o; para birimine bakılmaz (Türkiye'de dolar kullanan firma Türkiye'dedir).
 * - Söylemediyse ve Merkez'den sürümlü olay gelmişse eski biçim olaydır: Hesap ilk para birimini ülkeden türetir
 *   (TR ise TRY, değilse USD), Türkiye'deki eski firma uyarıyı kaybetmez, dolarlı eski firmaya da çıkmaz.
 * - Hiç olay gelmemişse (JIT) `currency` varsayılan TRY'dir, bir şey söylemez: bilinmiyor. Yeni firmanın henüz faturası yoktur,
 *   olay gelince düzelir. Yabancı firmaya yanlış hukuk söylemek, kısa süre uyarı göstermemekten pahalıdır.
 */
export function firmCountry(company: { settings: unknown; nameVersion: number | null }): string | null {
  const s = readSettings(company.settings);
  if (s.country) return s.country;
  if (company.nameVersion === null) return null;
  return s.currency === 'TRY' ? 'TR' : null;
}

/**
 * Kişinin göreceği ayarlar. Ayar yetkisi: hepsi (hatırlatma ayarı dahil). Deneme turu (`demo`): herkes. Fiyat gören: para birimi (ekrandaki tutarlar için).
 * Fatura gören: çözülmüş ülke (fatura ekranındaki süre için). Diğerleri: yalnız ölçüm için gerekenler.
 */
export function settingsFor(req: FastifyRequest, s: CompanySettings, country: string | null) {
  if (can(req, 'deciship.settings.manage')) {
    // Merkez onayı ayar yanıtına girmez: kurulum yanıtı `company.confirmed` taşır.
    const { demo, companyConfirmed: _confirmed, ...rest } = s;
    return { ...rest, ...(demo ? { demo: { startedAt: demo.startedAt, byMemberId: demo.byMemberId } } : {}), country };
  }
  return {
    desiDivisor: s.desiDivisor,
    // Deneme bandını web erişimi olan herkes görür; başlatanın kimliği yalnız ayar yetkisi olana gider.
    ...(s.demo ? { demo: { startedAt: s.demo.startedAt } } : {}),
    requiredBoxPhotos: s.requiredBoxPhotos,
    // Ölçen telefon uyarı eşiklerini buradan alır (Y44).
    warnEdgeCm: s.warnEdgeCm,
    warnWeightKg: s.warnWeightKg,
    // Telefon tartı fotoğrafını okutup okutmayacağını buradan bilir (kapalıysa okuma düğmesi ve iletisi yok).
    scaleAiRead: s.scaleAiRead,
    ...(can(req, 'deciship.prices.view') ? { currency: s.currency } : {}),
    ...(can(req, 'deciship.invoices.view') ? { country } : {}),
  };
}

export const DEFAULT_BOX_PRESETS = [
  { name: 'K1', lengthCm: 30, widthCm: 20, heightCm: 15, sortOrder: 1 },
  { name: 'K2', lengthCm: 40, widthCm: 30, heightCm: 25, sortOrder: 2 },
  { name: 'K3', lengthCm: 50, widthCm: 40, heightCm: 30, sortOrder: 3 },
];
