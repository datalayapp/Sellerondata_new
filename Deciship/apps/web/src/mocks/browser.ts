// Dev-only mock API (VITE_MOCK=1). Never bundled into production builds.
import { setupWorker } from 'msw/browser';
import { http, HttpResponse, delay, passthrough } from 'msw';
import { canonicalSurchargeCode, guessInvoiceMeta, isTariffSuspect, mappingDiagnostics, normalizeTracking, sumMoney, turkeyDate, zoneKey, type ColumnMapping as CoreColumnMapping, type DiffType } from '@deciship/core';
import { headlineOf } from '../lib/importHeadline';
import { accountHandlers, activeCompanyConfirmed, activeMemberName, activeOrg, activePerson, loadDb, productGuard } from './account';
import { claimOf, createDisputeMock, selectionDigestOf } from './disputes';
import type {
  AiTariffReview,
  BoxPreset,
  ImportIssue,
  ImportOptions,
  TariffImportDraft,
  OnboardingPatch,
  OnboardingState,
  TariffVersion,
  Carrier,
  InvoiceLine,
  InvoiceListItem,
  InvoiceTotals,
  MeasurementListItem,
  Tariff,
  PdfExtractBody,
  PdfScanMode,
  JobKind,
  JobStage,
  JobStatus,
  JobView,
  TariffPdfScan,
  TariffPdfSection,
  TariffPdfUpload,
  BulkRecalcPreview,
  BulkDecideBody,
  BulkDecideFilter,
  BulkDecideResult,
  InvoiceBasis,
  InvoiceRecalcPreview,
  PrevResult,
  RecalcBasis,
  RecalcLineResult,
} from '../api/types';

const now = new Date();
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number, h = 10) => {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  d.setHours(h, 12, 0, 0);
  return d;
};
let seq = 1000;
const id = () => crypto.randomUUID();
const err = (status: number, code: string, message: string, details?: unknown) => HttpResponse.json({ error: { code, message, details } }, { status });
/** Y83: uzun işler yalnız `?async=1` ile (API `requireAsync`). */
const asyncRequired = () => err(400, 'ASYNC_REQUIRED', 'Bu işlem artık arka planda yürüyor. Sayfayı yenileyip yeniden deneyin.');

const org = activeOrg();
const SETTINGS_KEY = `sod_mock_ds_settings:${org?.id ?? 'none'}`;
const company = {
  id: org?.id ?? 'o1',
  name: org?.name ?? 'Örnek Firma',
  settings: {
    edgeTolCm: 1,
    weightTolKg: 0.1,
    amountTol: 5,
    desiDivisor: 3000,
    requiredBoxPhotos: 1,
    warnEdgeCm: 150,
    warnWeightKg: 70,
    // kullanıcı kararı 2026-11-12: tartı okuması varsayılan kapalı
    scaleAiRead: false,
    currency: org?.currency ?? 'TRY',
    country: org?.country ?? 'TR',
    // API varsayılanları (lib/settings.ts): yanıtta her zaman bulunur
    unknownSurchargesAsDiff: false,
    disputeReminders: true,
    timeZone: 'Europe/Istanbul',
    ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>),
  } as Record<string, unknown> & { desiDivisor: number },
};
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(company.settings));
/** Test kancası: `sod_mock_guess_currency` dosyadaki para birimi sütununu değiştirir; `none`: yanıtta para birimi yok. */
/** Test kancası: `sod_mock_no_invoice_date` dosyada fatura tarihi bulunamamış gibi yanıtlar. */
function withoutMissingDate<T extends { invoiceDate?: string }>(meta: T): T {
  if (localStorage.getItem('sod_mock_no_invoice_date')) delete meta.invoiceDate;
  return meta;
}

function guessedCurrency(): { currency?: string } {
  const hook = localStorage.getItem('sod_mock_guess_currency');
  if (hook === 'none') return {};
  return { currency: hook ?? 'TRY' };
}
/** Ölçüm süzgecindeki kişiler: `Member` projeksiyonu. */
const membersDb = [
  { id: 'm1', name: 'Selin Aydın' },
  { id: 'm5', name: 'Mehmet Demir' },
];
const presets: BoxPreset[] = [
  { id: 'p1', name: 'K1', lengthCm: 30, widthCm: 20, heightCm: 15, sortOrder: 0, active: true },
  { id: 'p2', name: 'K2', lengthCm: 40, widthCm: 30, heightCm: 25, sortOrder: 1, active: true },
  { id: 'p3', name: 'K3', lengthCm: 50, widthCm: 40, heightCm: 30, sortOrder: 2, active: true },
];
const carriersDb: Carrier[] = [
  { id: 'cf', code: 'fedex', name: 'FedEx', active: true, defaultMapping: null },
  { id: 'ca', code: 'aras', name: 'Aras Kargo', active: true, defaultMapping: null },
  // Test kancası: `sod_mock_third_carrier` üçüncü taşıyıcı ekler (yükleme sihirbazında okuma sürerken başka seçim).
  ...(localStorage.getItem('sod_mock_third_carrier')
    ? [{ id: 'cy', code: 'yurtici', name: 'Yurtiçi Kargo', active: true, defaultMapping: null } as Carrier]
    : []),
];
const weightsA = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10];
const tariffsDb: Tariff[] = [
  {
    id: 't1',
    carrierId: 'cf',
    name: 'FedEx International Economy 2026',
    service: 'IE',
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ],
    discountPct: 38,
    fuelPct: 25,
    fuelVariable: true,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    active: true,
    isDefault: true,
    zones: [
      { country: 'FR', zone: 'A' },
      { country: 'DE', zone: 'A' },
      { country: 'NL', zone: 'A' },
      { country: 'GB', zone: 'B' },
      { country: 'US', zone: 'D' },
    ],
    rates: weightsA.flatMap((w) => [
      { zone: 'A', weightUpto: w, price: w === 6 ? 1527.75 : Math.round((420 + w * 185) * 100) / 100 },
      { zone: 'B', weightUpto: w, price: Math.round((480 + w * 205) * 100) / 100 },
      { zone: 'D', weightUpto: w, price: Math.round((610 + w * 260) * 100) / 100 },
    ]),
    overflow: [{ zone: 'A', perUnit: 160 }],
    surcharges: [{ code: 'RES', name: 'Konuma teslim', kind: 'FIXED', amount: 95 }],
  },
];

// kg başı bantları olan tarife (71 kg üstü: fiyat × ücretli kg)
tariffsDb.push({
  id: 't2',
  carrierId: 'cf',
  name: 'FedEx International Priority 2026',
  service: 'International Priority',
  currency: 'USD',
  divisor: 5000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [
    { upto: 20, step: 0.5 },
    { upto: null, step: 1 },
  ],
  discountPct: 0,
  fuelPct: 5,
  fuelVariable: true,
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  active: true,
  isDefault: false,
  zones: [
    { country: 'DE', zone: 'R' },
    { country: 'US', zone: 'E' },
    { country: 'AE', zone: 'B' },
  ],
  rates: ['B', 'E', 'R'].flatMap((z, zi) => [
    ...[0.5, 1, 2, 5, 10, 20, 30, 50, 70].map((w) => ({ zone: z, weightUpto: w, price: Math.round((19 + w * 4.2) * (1 + zi * 0.12) * 100) / 100 })),
    ...(
      [
        [99, 7.35],
        [299, 6.90],
        [9999, 6.31],
      ] as const
    ).map(([w, p]) => ({ zone: z, weightUpto: w, price: Math.round(p * (1 + zi * 0.12) * 100) / 100, perKg: true })),
  ]),
  overflow: [],
  surcharges: [{ code: 'ODA', name: 'Uzak bölge', kind: 'PER_KG', amount: 0.45 }],
});

// geçen yılın tarifesi (fatura tarifesi seçiminde "geçerli değil" uyarısı için) ve pasif bir tarife (listede gizli)
tariffsDb.push(
  { ...tariffsDb[0], id: 't3', name: 'FedEx International Economy 2025', isDefault: false, validFrom: '2025-01-01', validTo: '2025-12-31' },
  { ...tariffsDb[0], id: 't4', name: 'FedEx Eski Sözleşme', isDefault: false, active: false, validFrom: null, validTo: null },
);

// Gerçek API ile aynı (routes/tariffs.ts, rapor 10-B17): her yazım tarifenin `updatedAt`'ini ilerletir; PUT'ta gelen
// `expectedUpdatedAt` tutmazsa 409 STALE. Saat aynı milisaniyede iki yazımda da ilerler.
let tariffClock = 0;
function touchTariff(t: Tariff): Tariff {
  tariffClock = Math.max(Date.now(), tariffClock + 1);
  t.updatedAt = new Date(tariffClock).toISOString();
  return t;
}
for (const t of tariffsDb) t.updatedAt ??= '2026-10-01T09:00:00.000Z';
/**
 * Gerçek API ile aynı (rapor 02-B10, `assertNoDuplicateRows`): aynı bölge + ağırlık fiyatı ya da aynı gruptaki ek ücret iki
 * kez gelirse 400 VALIDATION, `details` satırın yolu ve iletiyle.
 */
function duplicateTariffRow(b: Partial<Tariff>): { message: string; path: string } | null {
  const rates = new Set<string>();
  for (const [i, r] of (b.rates ?? []).entries()) {
    const k = `${zoneKey(r.zone)}|${r.weightUpto}`;
    if (rates.has(k)) return { message: `${r.zone} bölgesinin ${r.weightUpto} kg fiyatı iki kez girilmiş.`, path: `rates.${i}` };
    rates.add(k);
  }
  const codes = new Set<string>();
  for (const [i, c] of (b.surcharges ?? []).entries()) {
    const k = canonicalSurchargeCode(c.code);
    if (codes.has(k)) return { message: `${c.code} ek ücreti iki kez girilmiş.`, path: `surcharges.${i}` };
    codes.add(k);
  }
  return null;
}
const duplicateError = (d: { message: string; path: string }) => err(400, 'VALIDATION', d.message, [d]);
/** Varsayılan yapılan tarifenin taşıyıcısında işaret yalnız önceki varsayılandan kalkar (o da değişmiş sayılır). */
function clearOtherDefault(t: Tariff) {
  if (!t.isDefault) return;
  for (const x of tariffsDb) if (x.carrierId === t.carrierId && x.id !== t.id && x.isDefault) touchTariff(Object.assign(x, { isDefault: false }));
}

// ---- güvenli tarife içe aktarma: taslaklar + sürümler ----
// Dosya adı "list", "rates", "lb" ya da "us-" içeriyorsa olaydaki FedEx U.S. List Rates CSV'si taklit edilir
// (pound + USD + "Zone A…"), aksi halde temiz bir Türkiye çıkışlı dosya. "noai" → yapay zekâ kapalı, "aifail" → ilk inceleme 502.
// Yapay zekâ incelemesi yalnız istenince çalışır; temiz dosyada hiç çağrılmaz.
interface VersionRec {
  tariffId: string;
  snap: Tariff;
  meta: TariffVersion;
}
const versionsDb: VersionRec[] = [];
const zoneCountOf = (t: Tariff) => new Set(t.rates.map((r) => r.zone)).size;
function snapshot(t: Tariff, reason: TariffVersion['reason'], label: string, at = new Date(), user: { name: string } | null = { name: membersDb[0].name }): string {
  const vid = id();
  versionsDb.unshift({
    tariffId: t.id,
    snap: structuredClone(t),
    meta: { id: vid, createdAt: iso(at), reason, label, user, rateCount: t.rates.length, zoneCount: zoneCountOf(t), countryCount: t.zones.length, currency: t.currency },
  });
  return vid;
}
snapshot(
  { ...tariffsDb[0], rates: tariffsDb[0].rates.map((r) => ({ ...r, price: Math.round(r.price * 0.93 * 100) / 100 })) },
  'IMPORT',
  'fedex-ie-2025.xlsx içe aktarılmadan önceki sürüm',
  daysAgo(41, 15),
);
snapshot({ ...tariffsDb[0], fuelPct: 22 }, 'EDIT', 'Elle düzenlenmeden önceki sürüm', daysAgo(6, 11), { name: 'Selin Kaya' });

interface DraftRec {
  tariffId: string;
  kind: 'incident' | 'clean';
  fileName: string;
  noAi: boolean;
  aiFail: number;
  /** POST /tariff-imports: henüz tarife yok, onayda bu taşıyıcıya yeni tarife oluşturulur */
  newCarrierId?: string;
  /** PDF'ten çıkarılan taslak */
  pdf?: PdfDraftRec;
  /** son yapay zekâ incelemesi (hangi seçeneklerle) — onay kuralı için */
  ai?: { key: string; verdict: AiTariffReview['verdict'] };
}
const optKey = (o: ImportOptions) => JSON.stringify({ c: o.convertLbToKg ? 1 : 0, cur: o.currency ?? null });

const nf = (n: number, d = 0) => n.toLocaleString('tr-TR', { maximumFractionDigits: d });

// ---- PDF tarife (FedEx Türkiye sözleşmesi taklidi) ----
// Yükleme hızlıdır (tarama yok). Tarama tuşla: mode 'code' (≈1 sn) ya da 'ai' (≈4 sn).
// Dosya adı: "taranmis"/"scan" → metin katmanı yok: kod taraması boş + mesaj, yalnız yapay zekâ okur (doğrulama null)
// · "eksik" → 3 fiyat PDF'te bulunamadı (uyarı) · "yavas" → uzun süreler · "noai" → yapay zekâ ile tarama 503 AI_DISABLED
interface PdfDocRec {
  doc: TariffPdfUpload;
  tariffId: string | null;
  carrierId: string;
  unmatched: boolean;
  slow: boolean;
  noAi: boolean;
  scanMode: PdfScanMode | null;
}
interface PdfDraftRec {
  docId: string;
  sectionIds: string[];
  includeCountryZones: boolean;
  newTariff: { name: string; service: string } | null;
}
const pdfDocsDb = new Map<string, PdfDocRec>();
const LETTERS = (a: string, b: string) => Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i));
const WORLD = LETTERS('A', 'I');
const EUROPE = LETTERS('R', 'W');
const sec = (x: Partial<TariffPdfSection> & Pick<TariffPdfSection, 'id' | 'title'>): TariffPdfSection => ({
  service: 'International Priority',
  direction: 'export',
  priceType: 'net',
  zones: WORLD,
  weightMin: 0.5,
  weightMax: 70,
  currency: 'USD',
  pages: [],
  hasAdditionalStep: false,
  hasPerKgBands: false,
  ...x,
});
// yalnız koli tabloları (zarf/pak yok)
const FEDEX_SECTIONS: TariffPdfSection[] = [
  sec({
    id: 's-ip',
    title: 'IP ihracat · Dünya (A–I) · kutu 0,5–1.000 kg · net',
    service: 'International Priority (IP)',
    pages: [5],
    weightMax: 1000,
    hasPerKgBands: true,
    listDiscount: { listSectionId: 's-list-ip', discountTableId: 'd1', listPages: [19], discountPages: [15], diff: { compared: 1200, differing: 840, maxDiff: 0.18 } },
  }),
  sec({
    id: 's-ip-eu',
    title: 'IP ihracat · Avrupa (R–W) · kutu 0,5–1.000 kg · net',
    service: 'International Priority (IP)',
    zones: EUROPE,
    pages: [6],
    weightMax: 1000,
    hasPerKgBands: true,
    listDiscount: { listSectionId: 's-list-ip-eu', discountTableId: 'd1', listPages: [20], discountPages: [15], diff: { compared: 800, differing: 510, maxDiff: 0.2 } },
  }),
  sec({ id: 's-ipe', title: 'International Priority Express (IPE)', service: 'International Priority Express', pages: [11, 12] }),
  sec({ id: 's-ie', title: 'International Economy (IE)', service: 'International Economy', pages: [14, 15], hasAdditionalStep: true }),
  sec({ id: 's-ipi', title: 'IP İthalat (Import)', direction: 'import', pages: [17, 18], hasPerKgBands: true }),
  sec({
    id: 's-list-ip',
    title: 'IP ihracat · Dünya (A–I) · kutu 0,5–1.000 kg · liste',
    service: 'International Priority (IP)',
    priceType: 'list',
    pages: [19],
    weightMax: 1000,
    hasPerKgBands: true,
    listDiscount: { listSectionId: 's-list-ip', discountTableId: 'd1', listPages: [19], discountPages: [15], diff: null },
  }),
  sec({
    id: 's-list-ip-eu',
    title: 'IP ihracat · Avrupa (R–W) · kutu 0,5–1.000 kg · liste',
    service: 'International Priority (IP)',
    priceType: 'list',
    zones: EUROPE,
    pages: [20],
    weightMax: 1000,
    hasPerKgBands: true,
    listDiscount: { listSectionId: 's-list-ip-eu', discountTableId: 'd1', listPages: [20], discountPages: [15], diff: null },
  }),
  sec({ id: 's-list-ie', title: 'IE liste fiyatları (indirimsiz)', service: 'International Economy', priceType: 'list', pages: [27, 28] }),
];
function fedexScan(mode: PdfScanMode, scanned: boolean): TariffPdfScan {
  const document: TariffPdfScan['document'] = {
    carrier: 'FedEx',
    validFrom: '2026-01-01',
    currency: 'USD',
    weightUnit: 'kg',
    dimDivisor: 5000,
    fuel: { kind: 'FIXED_PCT', pct: 5 },
    notes: ['Fiyatlar KDV hariç, ABD doları (USD).'],
    countryZonePages: [29],
  };
  if (mode === 'code' && scanned)
    return {
      mode,
      document: { ...document, carrier: null, validFrom: null, currency: null, weightUnit: null, dimDivisor: null, fuel: { kind: 'UNKNOWN', pct: null }, notes: [], countryZonePages: [] },
      sections: [],
      suggestedSectionIds: [],
      hasCountryZones: false,
      message: 'PDF taranmış görüntü; yalnızca yapay zekâ ile okunabilir.',
    };
  // yapay zekâ taraması tablo içermez → liste × indirim yalnız kod taramasında
  const code = mode === 'code';
  return {
    mode,
    document,
    sections: code ? FEDEX_SECTIONS : FEDEX_SECTIONS.map((x) => ({ ...x, listDiscount: null })),
    suggestedSectionIds: ['s-ip', 's-ip-eu'],
    suggestionSource: 'invoices',
    suggestedPricing: code ? 'listDiscount' : 'table',
    discountTables: code
      ? [
          { id: 'd1', title: 'IP ihracat indirimi', service: 'IP', direction: 'export', pages: [15], zones: [...WORLD, ...EUROPE], bands: 12 },
          { id: 'd2', title: 'IE ihracat indirimi', service: 'IE', direction: 'export', pages: [15], zones: [...WORLD, ...EUROPE], bands: 12 },
        ]
      : [],
    hasCountryZones: true,
    message: null,
  };
}
const PDF_W = [...Array.from({ length: 40 }, (_, i) => (i + 1) * 0.5), ...Array.from({ length: 50 }, (_, i) => 21 + i)];
const PK_BANDS: [number, number][] = [
  [99, 7.35],
  [299, 6.90],
  [9999, 6.31],
];
function pdfRates(ids: string[]) {
  const out: { zone: string; weightUpto: number; price: number; perKg?: boolean }[] = [];
  const zoneF = (z: string) => 1 + (z.charCodeAt(0) - 65) * 0.06;
  for (const id of ids) {
    const zs = id === 's-ip-eu' ? EUROPE : WORLD;
    const k = id.startsWith('s-list') ? 1.6 : id === 's-ie' ? 0.85 : id === 's-ipe' ? 1.12 : 1;
    const ws = id === 's-ipe' ? PDF_W.filter((w) => w <= 70) : PDF_W;
    zs.forEach((z) => {
      const f = (EUROPE.includes(z) ? 0.7 + (z.charCodeAt(0) - 82) * 0.05 : zoneF(z)) * k;
      ws.forEach((w) => out.push({ zone: z, weightUpto: w, price: r2((18.4 + w * 4.1 + Math.sqrt(w) * 3) * f) }));
      if (id === 's-ip' || id === 's-ip-eu' || id === 's-ipi' || id === 's-list-ip') PK_BANDS.forEach(([w, p]) => out.push({ zone: z, weightUpto: w, price: r2(p * f), perKg: true }));
    });
  }
  return out;
}
const PDF_COUNTRIES: { country: string; zone: string }[] = [
  { country: 'DE', zone: 'R' },
  { country: 'FR', zone: 'R' },
  { country: 'NL', zone: 'R' },
  { country: 'IT', zone: 'S' },
  { country: 'ES', zone: 'S' },
  { country: 'GB', zone: 'T' },
  { country: 'PL', zone: 'U' },
  { country: 'US', zone: 'E' },
  { country: 'CA', zone: 'E' },
  { country: 'AE', zone: 'B' },
  { country: 'SA', zone: 'B' },
  { country: 'CN', zone: 'C' },
  { country: 'JP', zone: 'D' },
  { country: 'AU', zone: 'F' },
  { country: 'BR', zone: 'G' },
];

function buildPdfDraft(draftId: string, rec: DraftRec, o: ImportOptions): TariffImportDraft {
  const p = rec.pdf!;
  const doc = pdfDocsDb.get(p.docId)!;
  const t = tariffsDb.find((x) => x.id === rec.tariffId);
  const isNew = !t || Boolean(p.newTariff);
  const tariffCur = o.currency ?? (isNew ? 'USD' : t!.currency);
  const rates = pdfRates(p.sectionIds);
  const secs = FEDEX_SECTIONS.filter((s) => p.sectionIds.includes(s.id));
  const checks: ImportIssue[] = [];
  if (tariffCur !== 'USD')
    checks.push({
      severity: 'error',
      code: 'CURRENCY_MISMATCH',
      title: `Fiyatlar USD, tarife ${tariffCur}`,
      detail: `PDF'teki fiyatlar ABD doları; tarife ${tariffCur}. Bu haliyle 25 $ fiyat 25 ${tariffCur} sayılır.`,
      suggestion: 'Faturalarınız USD ise tarifenin para birimini USD yapın.',
    });
  const unmatched = doc.unmatched
    ? [
        { zone: 'C', weight: 14.5, price: 98.41, page: 6 },
        { zone: 'H', weight: 42, price: 233.9, page: 7 },
        { zone: 'T', weight: 3, price: 31.62, page: 8 },
      ]
    : [];
  if (unmatched.length)
    checks.push({
      severity: 'warning',
      code: 'PDF_UNMATCHED',
      title: `${unmatched.length} fiyat PDF'te bulunamadı`,
      detail: 'Bu fiyatlar okunurken yanlış hücreden alınmış olabilir. Kaynak ve doğrulama bölümünde sayfalarını görebilirsiniz.',
      suggestion: 'PDF’teki sayfasında kontrol edin; gerekirse uyguladıktan sonra editörde düzeltin.',
    });
  if (p.sectionIds.includes('s-ip') && p.sectionIds.includes('s-ipe'))
    checks.push({
      severity: 'warning',
      code: 'ZONE_OVERLAP',
      title: 'IP ve IPE aynı bölgeleri içeriyor',
      detail: 'İki tablo aynı bölge ve ağırlıklar için farklı fiyat veriyor; sonra gelen (IPE) öncekinin üzerine yazar.',
      suggestion: 'Faturanızdaki hizmete uyan tabloyu seçin; diğerini ayrı tarife olarak alın.',
    });
  if (secs.some((s) => s.priceType === 'list'))
    checks.push({
      severity: 'warning',
      code: 'LIST_PRICE',
      title: 'Liste fiyatı seçildi',
      detail: 'İndirimsiz genel fiyat; faturalarınız net fiyatla kesildiyse her satır fark gösterir.',
    });
  if (secs.some((s) => s.hasPerKgBands))
    checks.push({ severity: 'info', code: 'PER_KG_BANDS', title: '71 kg üstü bantlar kg başı fiyat olarak alındı (71–99, 100–299, 300+ kg)' });
  if (p.includeCountryZones) checks.push({ severity: 'info', code: 'ZONES_READ', title: `${PDF_COUNTRIES.length} ülke eşlemesi okundu (sayfa 29)` });
  const order = { error: 0, warning: 1, info: 2 } as const;
  checks.sort((a, b) => order[a.severity] - order[b.severity]);
  const ws = rates.map((r) => r.weightUpto);
  const zonesN = new Set(rates.map((r) => r.zone)).size;
  const scanned = !doc.doc.textLayer;
  const method = doc.scanMode === 'code' ? 'code' : 'text';
  const verification = scanned ? null : { method, checked: rates.length, matched: rates.length - unmatched.length, unmatched } as const;
  const fixes = tariffCur !== 'USD' ? [{ id: 'setCurrency' as const, label: 'Tarifenin para birimini USD yap', value: 'USD', resolves: ['CURRENCY_MISMATCH'] }] : [];
  const maxW = ws.length ? Math.max(...ws.filter((w) => w < 9999)) : 0;
  const okLines = [
    `${nf(rates.length)} fiyat okundu: ${zonesN} bölge, 0,5–${nf(maxW)} kg.`,
    scanned ? 'Taranmış PDF: birkaç fiyatı belgeyle göz ile karşılaştırın.' : method === 'code' ? 'Fiyatlar doğrudan PDF metninden okundu.' : 'Fiyatlar PDF metniyle birebir aynı.',
    ...(t && !isNew && (t.fuelPct !== 5 || (t.validFrom ?? '').slice(0, 10) !== '2026-01-01') ? ['Belgede yakıt %5 ve 01.01.2026 geçerlilik var; aşağıdan uygulayabilirsiniz.'] : []),
  ];
  return {
    kind: 'pdf',
    draftId,
    fileName: doc.doc.fileName,
    summary: {
      weightCount: new Set(ws).size,
      zoneCount: zonesN,
      countryCount: p.includeCountryZones ? PDF_COUNTRIES.length : 0,
      surchargeCount: 0,
      minWeight: ws.length ? Math.min(...ws) : null,
      maxWeight: ws.length ? maxW : null,
      detectedWeightUnit: 'kg',
      detectedCurrency: 'USD',
      tariffCurrency: tariffCur,
    },
    zones: p.includeCountryZones ? PDF_COUNTRIES.filter((c) => rates.some((r) => r.zone === c.zone)) : [],
    rates,
    overflow: [],
    surcharges: [],
    checks,
    canApply: !checks.some((c) => c.severity === 'error'),
    fixes,
    comparison: isNew ? null : [],
    aiAvailable: !rec.noAi,
    source: { documentId: p.docId, sectionTitles: secs.map((s) => s.title), pages: secs.flatMap((s) => s.pages).concat(p.includeCountryZones ? [29] : []) },
    verification,
    suggestedMeta: { fuelPct: 5, validFrom: '2026-01-01', currency: 'USD' },
    target: isNew ? { kind: 'new', carrierId: doc.carrierId } : { kind: 'existing', tariffId: t!.id },
    suggestedDefaults: isNew ? { currency: 'USD', divisor: 5000 } : undefined,
    headline: headlineOf(checks, { fixable: fixes.length > 0, okLines }),
  };
}

function pdfAiReview(rec: DraftRec): AiTariffReview {
  const doc = pdfDocsDb.get(rec.pdf!.docId);
  const warn = Boolean(doc?.unmatched);
  return {
    verdict: warn ? 'caution' : 'ok',
    summary: warn
      ? 'FedEx Türkiye sözleşmesinden Türkiye çıkışlı net (anlaşmalı) International Priority fiyatları. Bulunamayan 3 fiyat büyük olasılıkla komşu hücreden okunmuş; sayfa 6–8’de kontrol edin.'
      : 'FedEx Türkiye sözleşmesinden Türkiye çıkışlı net (anlaşmalı) International Priority fiyatları: kg, USD, 01.01.2026’dan itibaren. Yakıt %5 sabit.',
    issues: warn ? [{ severity: 'warning', code: 'CELL_SHIFT', title: '3 fiyat komşu hücreden okunmuş olabilir', detail: 'Değerler aynı satırdaki bir sonraki bölgenin fiyatına çok yakın.' }] : [],
    detected: { carrier: 'FedEx', service: 'International Priority', origin: 'Türkiye', weightUnit: 'kg', currency: 'USD', effectiveDate: '2026-01-01', isListRate: false },
    identity: {
      description: `FedEx International Priority ihracat (koli) için Türkiye çıkışlı anlaşmalı fiyatlar; ${rec.pdf!.sectionIds.length} tablo, 01.01.2026’dan itibaren.`,
      suggestedName: 'FedEx International Priority 2026',
      suggestedService: 'International Priority',
      suggestedValidFrom: '2026-01-01',
      suggestedValidTo: '2026-12-31',
    },
    model: 'claude (deneme)',
  };
}
const draftsDb = new Map<string, DraftRec>();
const LB = 0.45359237;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function buildDraft(draftId: string, rec: DraftRec, o: ImportOptions): TariffImportDraft {
  // test kancaları: dosyada indirim sütunu yok (uyarı, core NO_DISCOUNT) ya da dolu
  const noDiscountFile = !!localStorage.getItem('sod_mock_no_discount');
  const fileDiscount = localStorage.getItem('sod_mock_file_discount');
  if (rec.pdf) return buildPdfDraft(draftId, rec, o);
  // new tariff (POST /tariff-imports): no current tariff → compare with nothing, default TRY
  const t: Tariff = tariffsDb.find((x) => x.id === rec.tariffId) ?? { ...SEED_TARIFF, id: 'new', currency: 'TRY', zones: [] };
  const checks: ImportIssue[] = [];
  let rates: TariffImportDraft['rates'];
  let zones: TariffImportDraft['zones'];
  let surcharges: TariffImportDraft['surcharges'] = [];
  let unit: 'kg' | 'lb';
  let cur: string;
  let pairs: [string, string][]; // [new zone, old zone] for the comparison
  if (rec.kind === 'incident') {
    unit = 'lb';
    cur = 'USD';
    const zn = ['Zone A', 'Zone B', 'Zone C', 'Zone D', 'Zone E', 'Zone F', 'Zone G'];
    rates = [];
    for (let w = 1; w <= 150; w++) {
      zn.forEach((z, zi) => rates.push({ zone: z, weightUpto: o.convertLbToKg ? Math.round(w * LB * 1000) / 1000 : w, price: r2(9.8 + w * 1.15 + zi * 2.4 + Math.sqrt(w) * zi) }));
    }
    zones = [];
    pairs = [
      ['Zone A', 'A'],
      ['Zone B', 'B'],
      ['Zone D', 'D'],
    ];
    if (!o.convertLbToKg)
      checks.push({
        severity: 'error',
        code: 'WEIGHT_UNIT_LB',
        title: 'Ağırlıklar pound (lb) cinsinden, kg değil',
        detail: 'Başlıkta “lbs” geçiyor ve ağırlıklar 1, 2, 3 … 150 diye artıyor. Tarife kg ile hesaplanır; bu haliyle 10 lb’lik koli 10 kg gibi fiyatlanır.',
        suggestion: 'Ağırlıkları kg’ye çevirin ya da taşıyıcıdan kg cinsinden fiyat listesi isteyin.',
      });
    if ((o.currency ?? t.currency) !== 'USD')
      checks.push({
        severity: 'error',
        code: 'CURRENCY_MISMATCH',
        title: `Fiyatlar USD, tarife ${t.currency}`,
        detail: `Fiyatlar ABD doları ($) ile yazılmış; tarife ${t.currency}. Bu haliyle 25 $ fiyat 25 ₺ sayılır.`,
        suggestion: 'Faturalarınız USD ise tarifenin para birimini USD yapın; değilse faturalarınızla aynı para biriminde liste isteyin.',
      });
    checks.push({
      severity: 'warning',
      code: 'SKIPPED_ROWS',
      title: '8 satır okunamadı, atlandı',
      detail: 'Bu satırlarda ağırlık yerine açıklama metni var (ör. “Multiweight”, dipnotlar).',
      rows: [3, 4, 155, 156, 157, 158, 159, 160],
    });
    checks.push({
      severity: 'warning',
      code: 'ZONE_NAMES_UNMAPPED',
      title: 'Bölge adları mevcut eşlemeyle uyuşmuyor',
      detail: 'Dosyada “Zone A … Zone G” var; tarifedeki ülke eşlemesi A, B ve D bölgelerini kullanıyor. Eşleme düzeltilmezse faturalarda “Tarife yok” görünür.',
      suggestion: 'Bölgeler sayfası olan Excel şablonunu kullanın ya da uyguladıktan sonra Bölge eşleme bölümünü güncelleyin.',
    });
  } else {
    unit = 'kg';
    cur = t.currency;
    // samples/tariff-template-example.xlsx: fiyatlar şablondaki gibi (6 kg A = 1.527,75); başka dosya mevcut tarifeden %4 yüksek
    rates = /template/i.test(rec.fileName) ? SEED_TARIFF.rates.map((r) => ({ ...r })) : (t.rates.length ? t.rates : SEED_TARIFF.rates).map((r) => ({ ...r, price: r2(r.price * 1.04) }));
    zones = [...t.zones, { country: 'IT', zone: 'A' }];
    surcharges = [{ code: 'RES', name: 'Konuma teslim', kind: 'FIXED', amount: 99 }];
    pairs = zoneCountOf(t) && !rec.newCarrierId ? Array.from(new Set(t.rates.map((r) => r.zone))).map((z) => [z, z]) : [];
    checks.push({ severity: 'info', code: 'SURCHARGES_READ', title: '1 ek ücret okundu (RES, 99 TRY)' });
    checks.push({ severity: 'info', code: 'ZONES_READ', title: `${zones.length} ülke eşlemesi okundu; IT yeni eklendi` });
  }
  const comparison = pairs.map(([nz, oz]) => {
    const oldMedian = median(t.rates.filter((r) => r.zone === oz).map((r) => r.price));
    const newMedian = median(rates.filter((r) => r.zone === nz).map((r) => r.price));
    return { zone: nz === oz ? nz : `${nz} ↔ ${oz}`, oldMedian: r2(oldMedian), newMedian: r2(newMedian), ratio: oldMedian ? Math.round((newMedian / oldMedian) * 1000) / 1000 : 0 };
  });
  if (comparison.some((c) => c.ratio < 0.5 || c.ratio > 2))
    checks.push({
      severity: 'warning',
      code: 'PRICE_LEVEL',
      title: 'Fiyatlar mevcut tarifeden çok farklı',
      detail: `Ortanca fiyat, mevcut tarifenin yaklaşık ${comparison[0].ratio.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} katı.`,
      suggestion: 'Para birimini ve hizmet tipini kontrol edin.',
    });
  const ws = rates.map((r) => r.weightUpto);
  const order = { error: 0, warning: 1, info: 2 } as const;
  checks.sort((a, b) => order[a.severity] - order[b.severity]);
  const fixes: TariffImportDraft['fixes'] =
    rec.kind === 'incident'
      ? [
          ...(o.convertLbToKg ? [] : [{ id: 'convertLbToKg' as const, label: 'Ağırlıkları pound’dan kg’ye çevir', resolves: ['WEIGHT_UNIT_LB'] }]),
          ...((o.currency ?? t.currency) === 'USD' ? [] : [{ id: 'setCurrency' as const, label: 'Tarifenin para birimini USD yap', value: 'USD', resolves: ['CURRENCY_MISMATCH'] }]),
        ]
      : [];
  const avg = comparison.length ? comparison.reduce((a, c) => a + c.ratio, 0) / comparison.length : 0;
  const okLines = [
    `${nf(new Set(ws).size)} ağırlık × ${nf(new Set(rates.map((r) => r.zone)).size)} bölge okundu.`,
    ...(comparison.length ? [`Fiyatlar mevcut tarifeden ortalama %${nf(Math.abs(avg - 1) * 100)} ${avg >= 1 ? 'yüksek' : 'düşük'}.`] : []),
    ...(surcharges.length || zones.length ? [`${surcharges.length} ek ücret, ${zones.length} ülke eşlemesi.`] : []),
  ];
  if (noDiscountFile) checks.push({ severity: 'warning', code: 'NO_DISCOUNT', title: 'Dosyada indirim yok', detail: 'Fiyatlar net sayılacak. Bunlar liste fiyatıysa beklenen tutar yüksek çıkar ve yanlış fark görünür.', suggestion: 'Fiyat sayfasına "İndirim %" sütunu ekleyin; net fiyatsa 0 yazın.' });
  if (fileDiscount) checks.push({ severity: 'info', code: 'DISCOUNT_READ', title: `İndirim %${fileDiscount} belgeden alındı` });
  return {
    headline: headlineOf(checks, { fixable: fixes.length > 0, okLines }),
    draftId,
    fileName: rec.fileName,
    summary: {
      weightCount: new Set(ws).size,
      zoneCount: new Set(rates.map((r) => r.zone)).size,
      countryCount: zones.length,
      surchargeCount: surcharges.length,
      minWeight: ws.length ? Math.min(...ws) : null,
      maxWeight: ws.length ? Math.max(...ws) : null,
      detectedWeightUnit: unit,
      detectedCurrency: cur,
      tariffCurrency: o.currency ?? t.currency,
    },
    zones,
    rates,
    overflow: [],
    surcharges,
    checks,
    canApply: !checks.some((c) => c.severity === 'error'),
    fixes,
    comparison: pairs.length && !rec.newCarrierId ? comparison : null,
    aiAvailable: !rec.noAi,
    ...(fileDiscount ? { suggestedMeta: { discountPct: Number(fileDiscount) } } : {}),
    kind: 'table',
    target: rec.newCarrierId ? { kind: 'new', carrierId: rec.newCarrierId } : { kind: 'existing', tariffId: rec.tariffId },
    suggestedDefaults: rec.newCarrierId ? { currency: 'TRY', divisor: 5000 } : undefined,
  };
}

function aiReview(rec: DraftRec, _o: ImportOptions = {}): AiTariffReview {
  if (rec.kind === 'incident')
    return {
      verdict: 'reject',
      summary:
        'Bu dosya FedEx’in ABD çıkışlı liste fiyatı (U.S. Package Standard List Rates). Ağırlıklar pound, fiyatlar ABD doları, bölgeler ABD içi teslimat bölgeleri. Türkiye çıkışlı anlaşmalı tarifeniz yerine kullanılırsa faturalarınız yanlış karşılaştırılır.',
      issues: [
        {
          severity: 'error',
          code: 'ORIGIN_NOT_TR',
          title: 'Çıkış ülkesi Türkiye değil',
          detail: 'Başlıkta “U.S.” geçiyor ve bölgeler ABD içi mesafe bölgeleri; bu ABD çıkışlı liste fiyatı.',
          suggestion: 'FedEx müşteri temsilcinizden Türkiye çıkışlı anlaşmalı fiyat listenizi Excel olarak isteyin.',
        },
        { severity: 'warning', code: 'LIST_RATE', title: 'Herkese açık liste fiyatı', detail: 'Size özel indirimi içermez; faturalarınızdaki fiyatlarla uyuşmaz.' },
        {
          severity: 'warning',
          code: 'SERVICE_MISMATCH',
          title: 'Hizmet tipi faturalarınızdakiyle uyuşmuyor',
          detail: 'Dosya ABD içi “Package Standard” hizmetini anlatıyor; bu tarife International Economy (IE).',
        },
      ],
      detected: { carrier: 'FedEx', service: 'U.S. Package (Standard List Rates)', origin: 'ABD', weightUnit: 'lb', currency: 'USD', effectiveDate: '2026-01-05', isListRate: true },
      identity: {
        description: 'FedEx International Priority için ABD çıkışlı genel liste fiyatları (05.01.2026’dan itibaren); Türkiye çıkışlı anlaşmalı fiyatınız değil.',
        suggestedName: 'FedEx International Priority — ABD liste fiyatı 2026',
        suggestedService: 'IP',
        suggestedValidFrom: '2026-01-05',
        suggestedValidTo: null,
      },
      model: 'claude (deneme)',
    };
  return {
    verdict: 'ok',
    summary: 'Türkiye çıkışlı FedEx International Economy fiyat listesi: ağırlıklar kg, fiyatlar TRY, bölgeler mevcut tarifenizle aynı. Fiyatlar mevcut tarifeden ortalama %4 yüksek; yıllık zamla uyumlu.',
    issues: [],
    detected: { carrier: 'FedEx', service: 'International Economy', origin: 'Türkiye', weightUnit: 'kg', currency: 'TRY', effectiveDate: '2026-01-01', isListRate: false },
    identity: {
      description: 'FedEx International Economy için Türkiye çıkışlı anlaşmalı fiyat listesi (01.01.2026–31.12.2026).',
      suggestedName: 'FedEx International Economy 2026',
      suggestedService: 'IE',
      suggestedValidFrom: '2026-01-01',
      suggestedValidTo: '2026-12-31',
    },
    model: 'claude (deneme)',
  };
}

const people = ['Mehmet Demir', 'Selin Kaya'];
const methods = ['LIDAR', 'REFERENCE', 'MANUAL', 'PRESET', 'AR'] as const;
/** Gerçek ölçüm kaydının panel tipinde olmayan alanları (API `serializeMeasurement`; sözleşme testi ister). */
type MockMeasurement = MeasurementListItem & {
  note?: string | null;
  clientId?: string;
  createdAt?: string;
  superseded?: boolean;
  dimConfidence?: number | null;
  ocrWeightKg?: number | null;
};
const MEASUREMENT_DEFAULTS = { boxPresetId: null, deleted: false, deletedAt: null, dimConfidence: null, note: null, ocrWeightKg: null, superseded: false };
const measDb: MockMeasurement[] = Array.from({ length: 23 }, (_, i) => {
  const l = [40, 30, 50, 35, 45][i % 5];
  const w = [30, 20, 40, 25, 35][i % 5];
  const h = [25, 15, 30, 20, 22][i % 5];
  const no = i === 0 ? '794812345305' : `7948123${String(45000 + i * 17).padStart(5, '0')}`;
  const measuredAt = iso(daysAgo(Math.floor(i / 3), 9 + (i % 8)));
  return {
    ...MEASUREMENT_DEFAULTS,
    id: `me${i}`,
    clientId: `c0ffee00-0000-4000-8000-${String(i).padStart(12, '0')}`,
    createdAt: measuredAt,
    trackingNo: no,
    trackingRaw: no,
    lengthCm: l,
    widthCm: w,
    heightCm: h,
    weightKg: i === 0 ? 4 : Math.round((2 + (i % 7) * 0.85) * 100) / 100,
    desi: Math.round(((l * w * h) / 3000) * 100) / 100,
    volumetricKg5000: Math.round(((l * w * h) / 5000) * 1000) / 1000,
    dimMethod: methods[i % 5],
    weightMethod: i % 3 ? 'OCR' : 'MANUAL',
    measuredAt,
    measuredBy: { id: i % 4 ? 'm5' : 'm1', name: people[i % 4 ? 0 : 1] },
    photoCount: i === 7 ? 0 : 2,
    version: i === 0 ? 2 : 1,
    invoiceStatus: i < 12 ? (i % 4 === 0 ? 'DIFF' : 'MATCH') : null,
  };
});

const photo = (label: string, color: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${color}"/><path d="M200 170l120-60 120 60v150l-120 60-120-60z" fill="#c69c6d" stroke="#5a3e1b" stroke-width="4"/><text x="24" y="456" font-family="sans-serif" font-size="28" fill="#fff">${label}</text></svg>`,
  )}`;

const NO_MEAS = { id: 'none', trackingNo: '', lengthCm: 0, widthCm: 0, heightCm: 0, weightKg: 0, measuredAt: new Date(0).toISOString(), measuredBy: { id: 'm1', name: '' } };
const mkLineFor = (i: number, invoiceId: string) => mkLine(i, invoiceId);
/** Panel tipinde olmayan ama API satırında hep bulunan alan (ölçü sütunlarının birleşik hâli; düz CSV'de null). */
const LINE_EXTRA = { dims: null };
/** Satırdaki ölçümün API'de bulunan diğer alanları (`lineMeasurement`). */
const measurementRefExtra = (m: Partial<MockMeasurement>) => ({
  trackingNo: m.trackingNo ?? '',
  dimMethod: m.dimMethod ?? 'MANUAL',
  weightMethod: m.weightMethod ?? 'MANUAL',
  photoCount: m.photoCount ?? 0,
  version: m.version ?? 1,
});
function mkLine(i: number, invoiceId: string): InvoiceLine {
  const m = measDb[i] ?? NO_MEAS;
  const kinds = ['DIFF', 'MATCH', 'MATCH', 'MATCH', 'DIFF', 'MATCH', 'UNMATCHED', 'MATCH', 'DIFF', 'MATCH', 'MATCH', 'NO_TARIFF'] as const;
  const status = kinds[i % kinds.length];
  const expected = status === 'MATCH' || status === 'DIFF' ? 1184 + i * 13.5 : null;
  const diff = status === 'DIFF' ? [458.5, 212.4, 95][i % 3] : status === 'MATCH' ? 0 : null;
  const net = (expected ?? 980) + (diff ?? 0);
  return {
    // API satırında hep bulunan alanlar (`serializeLine`); sözleşme testi ister
    billedDivisor: null,
    reference: null,
    measurementId: status === 'UNMATCHED' || !measDb[i] ? null : m.id,
    measurementPinned: false,
    pricingBasis: expected != null ? 'TARIFF' : null,
    rateDeviationPct: 0,
    confidence: 'HIGH',
    confidenceReason: null,
    reviewCode: null,
    decisionReason: null,
    decidedAt: null,
    originalTrackingNo: null,
    parseFlags: [],
    parseChecked: false,
    fx: null,
    prevResult: null,
    recalcPending: null,
    recalcPendingAt: null,
    ...LINE_EXTRA,
    id: `l${invoiceId}-${i}`,
    invoiceId,
    rowIndex: i,
    trackingNo: status === 'UNMATCHED' ? `77401234${6100 + i}` : m.trackingNo,
    shipDate: '2026-10-22',
    service: 'IE',
    destCountry: ['FR', 'DE', 'GB', 'NL'][i % 4],
    actualKg: m.weightKg,
    billedKg: status === 'DIFF' ? 9 : 6,
    dimL: status === 'DIFF' ? 50 : m.lengthCm,
    dimW: status === 'DIFF' ? 40 : m.widthCm,
    dimH: status === 'DIFF' ? 30 : m.heightCm,
    baseAmount: Math.round((net / 0.775) * 100) / 100,
    discountAmount: Math.round((net / 0.775) * 0.38 * 100) / 100,
    fuelAmount: Math.round(net * 0.2 * 100) / 100,
    surcharges: i === 4 ? [{ code: 'ADR', name: 'Adres düzeltme', amount: 95 }] : [],
    netAmount: Math.round(net * 100) / 100,
    currency: 'TRY',
    status,
    diffTypes: status === 'DIFF' ? ([['DIMENSION'], ['SURCHARGE', 'PRICE'], ['WEIGHT']] as const)[i % 3].slice() : [],
    ourChargeableKg: status === 'UNMATCHED' ? null : 6,
    billedChargeableKg: status === 'DIFF' ? 9 : 6,
    expectedAmount: expected,
    diffAmount: diff,
    breakdown: expected
      ? [
          { label: 'Tarife fiyatı (Bölge A, 6,0 kg)', amount: 1527.75 },
          { label: 'İndirim %38', amount: -580.55 },
          { label: 'Yakıt %25', amount: 236.8 },
        ]
      : [],
    note: status === 'NO_TARIFF' ? 'Kur alınamadı (USD→TRY, 15.10.2026) — TCMB yanıt vermedi' : null,
    tariffId: 't1',
    tariff: { id: 't1', name: 'FedEx International Economy 2026' },
    decision: 'OPEN',
    measurement:
      status === 'UNMATCHED'
        ? null
        : {
            ...measurementRefExtra(m),
            id: m.id,
            lengthCm: m.lengthCm,
            widthCm: m.widthCm,
            heightCm: m.heightCm,
            weightKg: m.weightKg,
            measuredAt: m.measuredAt,
            measuredByName: m.measuredBy.name,
            photos: [
              { id: `ph${i}a`, kind: 'PHOTO_BOX', url: photo('Kutu', '#4f6b8a') },
              { id: `ph${i}b`, kind: 'PHOTO_SCALE', url: photo('Tartı 4,02 kg', '#33533d') },
            ],
          },
  };
}

function totalsOf(lines: InvoiceLine[]): InvoiceTotals {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // API gibi (`computeTotals`): türe göre fazla ödeme ve uzlaştırma adımları hep gelir (sahte: ilk fark türüne göre)
  const over = lines.filter((l) => l.status === 'DIFF' && l.decision !== 'ACCEPTED');
  const byType = new Map<DiffType, { type: DiffType; lines: number; amount: number }>();
  for (const l of over) {
    const type = l.diffTypes[0] ?? 'PRICE';
    const e = byType.get(type) ?? { type, lines: 0, amount: 0 };
    e.lines++;
    e.amount = r2(e.amount + (l.diffAmount ?? 0));
    byType.set(type, e);
  }
  const overchargeTotal = r2(over.reduce((s, l) => s + (l.diffAmount ?? 0), 0));
  return {
    flaggedLines: lines.filter((l) => !!l.parseFlags?.length && !l.parseChecked).length,
    acceptedLines: lines.filter((l) => l.decision === 'ACCEPTED').length,
    pakUnmatched: 0,
    pakNoTariff: 0,
    uncheckedSurchargeTotal: 0,
    estimatedOverchargeTotal: 0,
    estimatedLines: 0,
    overchargeByType: [...byType.values()].sort((a, b) => b.amount - a.amount),
    reconciliation: { steps: [{ key: 'netDiff', amount: overchargeTotal, lines: over.length }], overchargeTotal },
    lines: lines.length,
    match: lines.filter((l) => l.status === 'MATCH').length,
    diff: lines.filter((l) => l.status === 'DIFF').length,
    unmatched: lines.filter((l) => l.status === 'UNMATCHED').length,
    noTariff: lines.filter((l) => l.status === 'NO_TARIFF').length,
    billedTotal: r2(lines.reduce((s, l) => s + l.netAmount, 0)),
    comparedBilledTotal: r2(lines.filter((l) => l.expectedAmount != null).reduce((s, l) => s + l.netAmount, 0)),
    fxMissing: lines.filter((l) => l.status === 'NO_TARIFF' && l.note?.startsWith('Kur alınamadı')).length,
    expectedTotal: r2(lines.reduce((s, l) => s + (l.expectedAmount ?? 0), 0)),
    overchargeTotal: r2(lines.filter((l) => l.status === 'DIFF' && l.decision !== 'ACCEPTED').reduce((s, l) => s + (l.diffAmount ?? 0), 0)),
    verifiedTotal: r2(lines.filter((l) => l.decision === 'VERIFIED').reduce((s, l) => s + (l.diffAmount ?? 0), 0)),
    pendingLines: lines.filter((l) => l.recalcPending).length,
  };
}

const linesDb = new Map<string, InvoiceLine[]>();
type MockInvoice = InvoiceListItem & {
  currency: string;
  tariffId?: string | null;
  tariff?: { id: string; name: string } | null;
  periodFrom?: string | null;
  periodTo?: string | null;
};
const invoicesDb: MockInvoice[] = [];

// ---- Mesaj 4: geçmiş sonuçlar donar (sahte dayanak, önizleme ve onay) ----
// Fatura hesaplandığı andaki tarife sürümünü ve ayarı saklar; tarife ya da ayar sonradan değişince `basis.state` bunu söyler.
// Önizleme rakamları sahtedir ama tutarlıdır: yeni tarife fark satırlarını %15 azaltır, yeni ayar 100'ün altındaki farkı siler,
// yeniden hesap bekleyen satırın farkı yarıya iner, kuru alınamamış satır dolar.
type MockRev = { id: string; at: string };
const tariffRevs = new Map<string, MockRev>();
function revOf(tid: string): MockRev {
  let r = tariffRevs.get(tid);
  if (!r) {
    r = { id: `rev-${tid}-1`, at: iso(daysAgo(30)) };
    tariffRevs.set(tid, r);
  }
  return r;
}
function bumpRev(tid: string) {
  const n = Number(revOf(tid).id.split('-').pop()) + 1;
  tariffRevs.set(tid, { id: `rev-${tid}-${n}`, at: iso(new Date()) });
}
const rulesKey = () => {
  const s = company.settings as Record<string, unknown>;
  return JSON.stringify([s.edgeTolCm, s.weightTolKg, s.amountTol, s.fxTolerancePct ?? 1.5, s.unknownSurchargesAsDiff === true]);
};
type MockPin = { tariffId: string | null; tariffName: string | null; revisionId: string | null; revisionAt: string | null; rules: string; calculatedAt: string };
const pins = new Map<string, MockPin>();
function pinFor(tariffId: string | null | undefined): MockPin {
  const t = tariffId ? tariffsDb.find((x) => x.id === tariffId) : null;
  const r = t ? revOf(t.id) : null;
  return { tariffId: t?.id ?? null, tariffName: t?.name ?? null, revisionId: r?.id ?? null, revisionAt: r?.at ?? null, rules: rulesKey(), calculatedAt: iso(new Date()) };
}
function pinOf(inv: MockInvoice): MockPin {
  let p = pins.get(inv.id);
  if (!p) {
    p = pinFor(inv.tariffId);
    pins.set(inv.id, p);
  }
  return p;
}
const repin = (inv: MockInvoice) => pins.set(inv.id, pinFor(inv.tariffId));
function basisOf(inv: MockInvoice): InvoiceBasis {
  const p = pinOf(inv);
  const base = { tariffName: p.tariffName, calculatedAt: p.calculatedAt };
  if (!p.revisionId) return { state: 'NONE', ...base };
  if (!tariffsDb.some((x) => x.id === p.tariffId)) return { state: 'TARIFF_REMOVED', ...base };
  if (revOf(p.tariffId!).id !== p.revisionId) return { state: 'TARIFF_CHANGED', ...base };
  if (p.rules !== rulesKey()) return { state: 'RULES_CHANGED', ...base };
  return { state: 'CURRENT', ...base };
}
/** Taşıyıcı ve seçim verilince faturanın tarifesi (seçilen, yoksa varsayılan ya da ilk etkin). */
function resolveTariff(carrierId: string, tariffId: string | null | undefined) {
  const own = tariffsDb.filter((t) => t.carrierId === carrierId && t.active);
  return (tariffId ? tariffsDb.find((x) => x.id === tariffId) : null) ?? own.find((x) => x.isDefault) ?? own[0] ?? null;
}
const cents2 = (n: number) => Math.round(n * 100) / 100;
type MockPatch = { carrierId?: string; tariffId?: string | null; invoiceDate?: string; currency?: string };
/** Düzenleme önizlemesi ve PATCH aynı hesabı yapar: taşıyıcı / tarife değişiyorsa `tariff`, değilse `pinned`. */
function patchSim(inv: MockInvoice, patch: MockPatch) {
  const moves = (patch.carrierId !== undefined && patch.carrierId !== inv.carrier.id) || (patch.tariffId !== undefined && (patch.tariffId ?? null) !== (inv.tariffId ?? null));
  if (!moves) return { basis: 'pinned' as const, s: simulate(inv, 'pinned') };
  const carrierId = patch.carrierId ?? inv.carrier.id;
  const t = resolveTariff(carrierId, patch.carrierId && patch.carrierId !== inv.carrier.id ? null : (patch.tariffId ?? null));
  return { basis: 'tariff' as const, s: simulate(inv, 'tariff', { toPin: pinFor(t?.id ?? null) }) };
}
type MockChange = { line: InvoiceLine; after: RecalcLineResult; frozen: boolean };
/**
 * Yazmadan hesap: hangi satır nasıl değişir. `to`: yazılırsa faturanın yeni dayanağı. API gibi her kip yalnız kendi
 * parçasını günceller: `tariff` tarife sürümünü (ayar faturadaki kalır), `rules` ayarı (sürüm faturadaki kalır).
 */
function simulate(inv: MockInvoice, basis: RecalcBasis, o: { lineIds?: string[]; toPin?: MockPin } = {}) {
  const pin = pinOf(inv);
  const to: MockPin = basis === 'tariff' ? { ...(o.toPin ?? pinFor(inv.tariffId)), rules: pin.rules } : basis === 'rules' ? { ...pin, rules: rulesKey() } : pin;
  const tariffFactor = to.revisionId !== pin.revisionId ? 0.85 : 1;
  const rulesChanged = to.rules !== pin.rules;
  const lines = (linesDb.get(inv.id) ?? []).filter((l) => !o.lineIds || o.lineIds.includes(l.id));
  const changes: MockChange[] = [];
  let skipped = 0;
  for (const l of lines) {
    let status = l.status;
    let diff = l.diffAmount ?? null;
    let expected = l.expectedAmount ?? null;
    if (status === 'NO_TARIFF' && l.note?.startsWith('Kur alınamadı') && !o.lineIds) {
      status = 'MATCH';
      expected = l.netAmount;
      diff = 0;
    }
    if (l.recalcPending && diff != null) diff = cents2(diff * 0.5);
    if (status === 'DIFF' && diff != null) {
      diff = cents2(diff * tariffFactor);
      if (rulesChanged && diff < 100) diff = 0;
      if (diff <= 0) status = 'MATCH';
    }
    if (diff != null && expected != null && status !== 'NO_TARIFF') expected = cents2(l.netAmount - diff);
    const same = status === l.status && Math.round((diff ?? 0) * 100) === Math.round((l.diffAmount ?? 0) * 100);
    if (same) continue;
    if (disputesMock.lineLocked(inv.id, l.id)) {
      skipped++;
      continue;
    }
    changes.push({
      line: l,
      frozen: l.decision !== 'OPEN',
      after: { status, diffTypes: status === 'DIFF' ? (l.diffTypes.length ? l.diffTypes : ['PRICE']) : [], expectedAmount: expected, diffAmount: diff },
    });
  }
  const afterLines = (linesDb.get(inv.id) ?? []).map((l) => {
    const c = changes.find((x) => x.line.id === l.id);
    return c ? { ...l, ...c.after } : l;
  });
  return { pin, to, rulesChanged, changes, skipped, before: totalsOf(linesDb.get(inv.id) ?? []), after: totalsOf(afterLines) };
}
const simToken = (inv: MockInvoice, s: ReturnType<typeof simulate>) =>
  `${inv.id}|${s.to.revisionId}|${s.to.rules}|${s.changes.map((c) => `${c.line.id}:${Math.round((c.after.diffAmount ?? 0) * 100)}`).join(',')}`;
const sideOf = (p: MockPin) => ({ tariffId: p.tariffId, tariffName: p.tariffName, revisionId: p.revisionId, revisionAt: p.revisionAt });
function previewOf(inv: MockInvoice, s: ReturnType<typeof simulate>): InvoiceRecalcPreview {
  const lr = (l: Pick<InvoiceLine, 'status' | 'diffTypes' | 'expectedAmount' | 'diffAmount'>): RecalcLineResult => ({
    status: l.status,
    diffTypes: l.diffTypes,
    expectedAmount: l.expectedAmount ?? null,
    diffAmount: l.diffAmount ?? null,
  });
  return {
    token: simToken(inv, s),
    basis: { from: sideOf(s.pin), to: sideOf(s.to), rulesChanged: s.rulesChanged },
    totals: { before: s.before, after: s.after },
    changedLines: s.changes.length,
    // sahte hesap yalnız görünür değişikliği bulur: yazılacak satır = değişen satır
    writeLines: s.changes.length,
    frozenChanged: s.changes.filter((c) => c.frozen).length,
    skippedInDispute: s.skipped,
    lines: s.changes.slice(0, 200).map((c) => ({ id: c.line.id, rowIndex: c.line.rowIndex, trackingNo: c.line.trackingNo, decision: c.line.decision, before: lr(c.line), after: c.after })),
  };
}
/** Hesabı yazar: eski sonuç `prevResult`'a, bekleyen işaret silinir, karar değişmez. */
function writeSim(inv: MockInvoice, s: ReturnType<typeof simulate>, basis: RecalcBasis) {
  const at = iso(new Date());
  for (const c of s.changes) {
    const l = c.line;
    const cause: PrevResult['cause'] =
      l.recalcPending === 'MEASUREMENT' ? 'MEASUREMENT' : l.recalcPending === 'DUPLICATE' ? 'DUPLICATE' : basis === 'tariff' ? 'TARIFF' : basis === 'rules' ? 'RULES' : 'OTHER';
    if (l.expectedAmount != null)
      l.prevResult = { status: l.status, diffTypes: l.diffTypes, expectedAmount: l.expectedAmount ?? null, diffAmount: l.diffAmount ?? null, ourChargeableKg: l.ourChargeableKg ?? null, at, cause };
    Object.assign(l, c.after);
    if (c.after.status !== 'NO_TARIFF' && l.note?.startsWith('Kur alınamadı')) l.note = null;
    l.recalcPending = null;
    l.recalcPendingAt = null;
  }
  pins.set(inv.id, { ...(basis === 'pinned' ? s.pin : s.to), calculatedAt: at });
  inv.totals = totalsOf(linesDb.get(inv.id) ?? []);
}
/**
 * Toplu önizleme: kapsamdaki faturalar (etkin itirazı olanlar atlanır, sayısı döner). Tarife geçişi `tariff`, ayar
 * geçişi `rules` kipiyle; fazla ödeme para birimine göre ayrı toplanır (API `totalsByCurrency`).
 */
function bulkPreview(scope: MockInvoice[], basis: 'tariff' | 'rules'): BulkRecalcPreview & { sims: { inv: MockInvoice; s: ReturnType<typeof simulate> }[] } {
  const live = scope.filter((i) => !disputesMock.hasActive(i.id));
  const sims = live.map((inv) => ({ inv, s: simulate(inv, basis) }));
  const byCurrency = new Map<string, { invoices: number; before: number; after: number }>();
  for (const { inv, s } of sims) {
    const cur = inv.currency ?? 'TRY';
    const t = byCurrency.get(cur) ?? { invoices: 0, before: 0, after: 0 };
    byCurrency.set(cur, { invoices: t.invoices + 1, before: t.before + s.before.overchargeTotal, after: t.after + s.after.overchargeTotal });
  }
  return {
    sims,
    token: sims.map((x) => simToken(x.inv, x.s)).join(';') || 'empty',
    invoices: sims.slice(0, 200).map(({ inv, s }) => ({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      carrierName: inv.carrier.name,
      currency: inv.currency,
      before: { overchargeTotal: s.before.overchargeTotal },
      after: { overchargeTotal: s.after.overchargeTotal },
      changedLines: s.changes.length,
    })),
    totalsByCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, t]) => ({ currency, invoices: t.invoices, before: { overchargeTotal: cents2(t.before) }, after: { overchargeTotal: cents2(t.after) } })),
    changedInvoices: sims.length,
    skippedInDispute: scope.length - live.length,
  };
}
const tariffScope = (t: Tariff) => tariffUsage(t).using.filter((i) => pinOf(i).revisionId !== revOf(t.id).id);
const settingsScope = () => invoicesDb.filter((i) => pinOf(i).rules !== rulesKey());
function bulkApplyData(scope: MockInvoice[], token: unknown, basis: 'tariff' | 'rules') {
  const p = bulkPreview(scope, basis);
  if (token !== p.token) return null;
  for (const { inv, s } of p.sims) writeSim(inv, s, basis);
  // API ile aynı: `lines` geçirilen faturaların TOPLAM satır sayısı; itirazdaki faturalar `skipped.inDispute`
  return {
    invoices: p.sims.length,
    lines: p.sims.reduce((a, x) => a + (linesDb.get(x.inv.id) ?? []).length, 0),
    skipped: { inDispute: scope.length - p.sims.length, stale: 0 },
  };
}
/** `?async=1` toplu önizleme: iş (202). Sonuç `BulkPreview`, aşama bulkCheck. */
function bulkPreviewJob(ref: NonNullable<JobView['ref']>, scope: MockInvoice[], basis: 'tariff' | 'rules') {
  const { sims: _sims, ...p } = bulkPreview(scope, basis);
  return HttpResponse.json(startMockJob('BULK_RECOMPARE_PREVIEW', ref, 'bulkCheck', p), { status: 202 });
}
/** `?async=1` toplu uygulama: iş (202). Aynı belirteçle süren iş varsa ona bağlanır; farklı belirteçle 409 JOB_ACTIVE. */
function bulkApplyJob(ref: NonNullable<JobView['ref']>, scope: MockInvoice[], token: string, basis: 'tariff' | 'rules') {
  const active = [...jobsDb.values()].find((j) => j.view.kind === 'BULK_RECOMPARE_APPLY' && j.view.ref?.id === ref.id && !jobIsFinished(j.view.status));
  if (active && active.token !== token) return err(409, 'JOB_ACTIVE', 'Bu işlem zaten sürüyor.', { job: jobCopy(active, false) });
  if (active) return HttpResponse.json({ job: jobCopy(active, false), joined: true }, { status: 202 });
  const r = bulkApplyData(scope, token, basis);
  const stale = { statusCode: 409, code: 'PREVIEW_STALE', message: 'Önizleme eskidi; yeniden önizleyin.' };
  return HttpResponse.json(startMockJob('BULK_RECOMPARE_APPLY', ref, 'bulkWrite', r ?? undefined, undefined, { token, fail: r ? undefined : stale }), { status: 202 });
}

/**
 * API ile aynı kural (`tariffSaveCounts`): `using` bu tarifeyle fiyatlanan faturalar (seçili, seçim yoksa taşıyıcının
 * varsayılanı buysa). `affectedInvoices` toplu önizlemenin kapsamı (`tariffScope`: bunlardan bugünkü sürümde olmayanlar),
 * `otherInvoices` taşıyıcının başka tarifeye düşen faturaları.
 */
function tariffUsage(t: Tariff) {
  const own = invoicesDb.filter((i) => i.carrier.id === t.carrierId);
  const active = tariffsDb.filter((x) => x.carrierId === t.carrierId && x.active);
  const fallback = active.find((x) => x.isDefault) ?? active[0];
  const using = own.filter((i) => i.tariffId === t.id || (!i.tariffId && fallback?.id === t.id));
  return { using, own };
}
const tariffCounts = (t: Tariff) => {
  const { using, own } = tariffUsage(t);
  return { affectedInvoices: tariffScope(t).length, otherInvoices: own.length - using.length };
};

/** Fatura tarifesi: seçilen, yoksa taşıyıcının varsayılanı (ya da en son güncellenen etkin); tüm satırlar o tarifeyle. */
function applyInvoiceTariff(inv: MockInvoice) {
  const lines = linesDb.get(inv.id) ?? [];
  const own = tariffsDb.filter((t) => t.carrierId === inv.carrier.id && t.active);
  const t = (inv.tariffId ? tariffsDb.find((x) => x.id === inv.tariffId) : null) ?? own.find((x) => x.isDefault) ?? own[0] ?? null;
  inv.tariffId = t?.id ?? null;
  inv.tariff = t ? { id: t.id, name: t.name } : null;
  for (const l of lines) {
    l.tariffId = t?.id ?? null;
    l.tariff = t ? { id: t.id, name: t.name } : null;
  }
  // dayanak yalnız ilk atamada ya da tarife değişince yenilenir (fatura no düzeltmek "tarife değişti" notunu silmez)
  if (pins.get(inv.id)?.tariffId !== inv.tariffId) repin(inv);
}
function tariffsUsedOf(iid: string) {
  const m = new Map<string, { id: string; name: string; lines: number }>();
  for (const l of linesDb.get(iid) ?? []) {
    if (!l.tariff) continue;
    const cur = m.get(l.tariff.id) ?? { ...l.tariff, lines: 0 };
    cur.lines++;
    m.set(l.tariff.id, cur);
  }
  return [...m.values()].sort((a, b) => b.lines - a.lines);
}
/** Tarife yanıtlarındaki taşıyıcı özeti. */
function carrierRef(carrierId: string) {
  const c = carriersDb.find((x) => x.id === carrierId);
  return c ? { id: c.id, name: c.name, code: c.code } : null;
}
/** Liste ve pano satırı: API'nin liste alanları (tarife, dönem gibi ayrıntı alanları yalnız `GET /invoices/:id`'de). */
const invoiceListItem = (i: MockInvoice) => ({ id: i.id, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate, currency: i.currency, carrier: i.carrier, totals: i.totals, createdAt: i.createdAt });
function addInvoice(invoiceNo: string, carrier: Carrier, date: string, n: number, fixedId?: string, made?: (iid: string) => InvoiceLine[]) {
  const iid = fixedId ?? crypto.randomUUID();
  const lines = made ? made(iid) : Array.from({ length: n }, (_, i) => mkLine(i, iid));
  linesDb.set(iid, lines);
  invoicesDb.unshift({ id: iid, invoiceNo, invoiceDate: date, carrier: { id: carrier.id, name: carrier.name, code: carrier.code }, totals: totalsOf(lines), currency: 'TRY', createdAt: iso(daysAgo(1)) });
  return iid;
}
addInvoice(org?.id === 'o2' ? '9-482-22001' : '9-482-11735', carriersDb[0], '2026-10-27', 12, 'i1');

// SPEC §FX: USD tarifeli satırlar, TRY faturada kurla çevrilir (satır 2 tam uyumlu, satır 4 kur farkı toleransta)
company.settings = { ...company.settings, ...{ fxTolerancePct: 1.5 } };
{
  const fxRate = 41.2345;
  const usd = [
    { label: 'Tarife fiyatı (Bölge A, 6,0 kg)', amount: 37.05, currency: 'USD' },
    { label: 'İndirim %38', amount: -14.08, currency: 'USD' },
    { label: 'Yakıt %25', amount: 5.74, currency: 'USD' },
  ];
  const expUsd = 28.71;
  const conv = Math.round(expUsd * fxRate * 100) / 100; // 1.183,84
  const ls = linesDb.get('i1')!;
  for (const [i, billed, rateDate] of [[1, conv, '2026-10-22'], [3, 1200, '2026-10-22']] as const) {
    const l = ls[i]!;
    const fx = { base: 'USD', quote: 'TRY', rate: fxRate, date: rateDate, source: 'TCMB', requestedDate: '2026-10-22', expected: expUsd, converted: conv };
    Object.assign(l, {
      expectedAmount: conv,
      netAmount: billed,
      diffAmount: Math.round((billed - conv) * 100) / 100,
      status: 'MATCH',
      breakdown: [...usd, { label: `Beklenen 28,71 USD × 41,2345 (TCMB 22.10.2026)`, amount: conv, currency: 'TRY', fx }],
      fx,
      note: billed !== conv ? 'Kur farkı tolerans içinde (%1,5)' : null,
    });
  }
  invoicesDb.find((x) => x.id === 'i1')!.totals = totalsOf(ls);
  applyInvoiceTariff(invoicesDb.find((x) => x.id === 'i1')!);
}

// ---- itiraz takibi ----
const disputesMock = createDisputeMock({
  invoices: invoicesDb,
  linesOf: (iid) => linesDb.get(iid) ?? [],
  country: () => company.settings.country as string | null | undefined,
  person: activePerson,
});

/**
 * Test kancası `sod_mock_disputes`: her durumda örnek itiraz (gönderilmedi ve süresi yaklaşan, gönderildi, kısmi geri alınan,
 * reddedilen, kapanan, geri çekilip yeniden gönderilen, USD fatura). Faturalar i1'in ardına eklenir; kanca yoksa depo eskisi gibi.
 * Tarihler bugüne göredir: `page.clock` sabitlenince tohum da o güne göre kurulur.
 */
function seedDisputes() {
  const DAY = 86_400_000;
  const tday = turkeyDate(new Date());
  const ago = (n: number) => new Date(Date.parse(`${tday}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
  // Türkiye saatiyle o günün saati (UTC+3)
  const at = (n: number, h = 11) => new Date(Date.parse(`${ago(n)}T00:00:00Z`) + (h - 3) * 3_600_000 + 15 * 60_000).toISOString();
  const can = { id: 'p4', name: 'Can Yıldız' };
  const selin = { id: 'p1', name: 'Selin Aydın' };
  const fedex = carriersDb.find((c) => c.code === 'fedex')!;
  const aras = carriersDb.find((c) => c.code === 'aras')!;
  const TYPES: DiffType[][] = [['DIMENSION'], ['WEIGHT'], ['SURCHARGE', 'PRICE']];
  let trk = 8801;
  const make = (iid: string, no: string, carrier: Carrier, age: number, claims: number[], currency = 'TRY') => {
    const usd = currency !== 'TRY';
    const lines: InvoiceLine[] = Array.from({ length: claims.length + 2 }, (_, i) => {
      const base = mkLine(i + 1, iid);
      const claim = claims[i];
      const expected = usd ? Math.round((28.71 + i * 3.4) * 100) / 100 : Math.round((1184 + i * 13.5) * 100) / 100;
      const l: InvoiceLine = {
        ...base,
        id: `l${iid}-${i}`,
        rowIndex: i,
        trackingNo: `77405512${trk++}`,
        shipDate: ago(age + 4),
        currency,
        tariffId: usd ? 't2' : 't1',
        tariff: usd ? { id: 't2', name: 'FedEx International Priority 2026' } : base.tariff,
        breakdown: usd ? [{ label: 'Tarife fiyatı (Bölge E, 6,0 kg)', amount: expected, currency }] : base.breakdown,
        fx: null,
        note: null,
      };
      if (claim == null) return { ...l, status: 'MATCH', diffTypes: [], expectedAmount: expected, netAmount: expected, diffAmount: 0, decision: 'OPEN' };
      return {
        ...l,
        status: 'DIFF',
        diffTypes: TYPES[i % 3]!.slice(),
        expectedAmount: expected,
        netAmount: Math.round((expected + claim) * 100) / 100,
        diffAmount: claim,
        decision: 'VERIFIED',
        decidedAt: at(age - 1, 10),
      };
    });
    linesDb.set(iid, lines);
    invoicesDb.push({
      id: iid,
      invoiceNo: no,
      invoiceDate: ago(age),
      carrier: { id: carrier.id, name: carrier.name, code: carrier.code },
      totals: totalsOf(lines),
      currency,
      createdAt: at(age - 1, 9),
      tariffId: usd ? 't2' : carrier.id === 'cf' ? 't1' : null,
      tariff: usd ? { id: 't2', name: 'FedEx International Priority 2026' } : carrier.id === 'cf' ? { id: 't1', name: 'FedEx International Economy 2026' } : null,
    });
    return iid;
  };
  const S = disputesMock.seed;

  // Gönderilmedi: TTK'ya 2 gün (FedEx) ve 1 gün (Aras, taşıyıcı süresi yok)
  make('dsp-unsent', '9-490-30112', fedex, 6, [458.5, 212.4, 95]);
  make('dsp-unsent2', 'AR-2026-0457', aras, 7, [186.2, 74.9]);
  // Gönderildi, yanıt bekleniyor (TTK içinde)
  make('dsp-sent', '9-488-77120', fedex, 12, [318.4, 129.9, 61.25]);
  S.send('dsp-sent', { sentOn: ago(9), channel: 'EMAIL', channelNote: 'efatura.tr@fedex.com' }, can, at(9, 10));
  // Kısmi geri alma: tek dekont iki satırı kapsar, biri eksik geldi; üçüncü satır bekliyor
  make('dsp-partial', '9-486-55031', fedex, 20, [458.5, 212.4, 95]);
  {
    const r = S.send('dsp-partial', { sentOn: ago(15), channel: 'PORTAL', reference: 'TR-DSP-558214' }, can, at(15, 9));
    S.result(r, { kind: 'RECOVERED', resultOn: ago(8), creditNoteNo: 'AD-2026-1183', lines: [[0, 400], [1]] }, can, at(7, 14));
  }
  // Reddedildi, süre geçtikten sonra gönderilmiş (TTK 8 gün dolduktan sonra)
  make('dsp-rejected', '9-484-10077', fedex, 30, [264.8, 118.6]);
  {
    const r = S.send('dsp-rejected', { sentOn: ago(20), channel: 'EMAIL' }, can, at(20, 16));
    S.result(r, { kind: 'REJECTED', resultOn: ago(12), reason: 'Ölçüm fotoğrafı yetersiz bulundu; taşıyıcı kendi ölçüsünü esas aldı.', lines: [[0], [1]] }, can, at(12, 11));
  }
  // Geri çekilip yeniden gönderildi, sonra tamamı geri alındı; ilk turda yanlış girilip geri alınmış bir dekont var
  make('dsp-closed', '9-480-90215', fedex, 40, [342.0, 156.75]);
  {
    const r1 = S.send('dsp-closed', { sentOn: ago(37), channel: 'OTHER', channelNote: 'Müşteri temsilcisine telefonla' }, selin, at(37, 15));
    S.result(r1, { kind: 'RECOVERED', resultOn: ago(34), creditNoteNo: 'AD-2026-0903', lines: [[0]] }, can, at(34, 10));
    S.revert(r1, 'Dekont numarası başka faturaya aitti.', can, at(33, 9));
    S.withdraw(r1, 'Yanlış kanaldan gönderildi; taşıyıcı portaldan istiyor.', can, at(33, 10));
    const r2 = S.send('dsp-closed', { sentOn: ago(32), channel: 'PORTAL', reference: 'TR-DSP-551977' }, can, at(32, 10));
    S.result(r2, { kind: 'RECOVERED', resultOn: ago(25), creditNoteNo: 'AD-2026-0977', lines: [[0], [1]] }, can, at(25, 15));
  }
  // USD fatura: ilk turda biri geri alındı, öbürü reddedildi; reddedilen yeniden gönderildi (eski tur yerini yeniye bıraktı)
  make('dsp-usd', '9-479-40001', fedex, 25, [18.4, 9.75], 'USD');
  {
    const r1 = S.send('dsp-usd', { sentOn: ago(22), channel: 'EMAIL' }, can, at(22, 10));
    S.result(r1, { kind: 'RECOVERED', resultOn: ago(18), creditNoteNo: 'CN-55120', lines: [[0]] }, can, at(18, 12));
    S.result(r1, { kind: 'REJECTED', resultOn: ago(18), reason: 'Ek ücret sözleşmede var dendi.', lines: [[1]] }, can, at(18, 13));
    S.resend(r1, { sentOn: ago(16), channel: 'EMAIL', channelNote: 'Sözleşme maddesi eklendi' }, can, at(16, 9));
  }
}
if (localStorage.getItem('sod_mock_disputes') && !org?.empty) seedDisputes();
for (const inv of invoicesDb) pinOf(inv);

/** Test kancası `sod_mock_overlap`: '1' gönderilerin hepsi tek eski faturada, '2' iki eski faturaya yayılmış (Mesaj 5 Y5). */
function mockOverlap() {
  const v = localStorage.getItem('sod_mock_overlap');
  if (v === '1') return { total: 18, matched: 18, invoiceId: 'inv-overlap', invoiceNo: 'MNG-2026-77120' };
  if (v === '2') return { total: 18, matched: 11, invoiceId: 'inv-overlap', invoiceNo: 'MNG-2026-77120', otherInvoices: [{ invoiceId: 'inv-overlap-2', invoiceNo: 'MNG-2026-77121', matched: 5 }] };
  return null;
}

/**
 * Test kancası `sod_mock_review` (Mesaj 5 Y2): i1'de uyumlu çıkan ama hizmeti tarifeden farklı bir satır ve yakıt oranı
 * olağandışı bir fark satırı ("İncele" rozeti ve süzgeci).
 */
if (localStorage.getItem('sod_mock_review') && !org?.empty) {
  const ls = linesDb.get('i1');
  const match = ls?.find((l) => l.status === 'MATCH');
  const diff = ls?.find((l) => l.status === 'DIFF');
  if (match) Object.assign(match, { service: 'IP', confidence: 'LOW', reviewCode: 'SERVICE', confidenceReason: 'Bu satırın hizmeti (IP) tarifenizdeki hizmetten (IE) farklı; bu hizmet için tarife ekleyin' });
  if (diff) Object.assign(diff, { confidence: 'LOW', reviewCode: 'FUEL_RATE', confidenceReason: 'Faturadaki yakıt taşıma bedelinin %60 oranını aşıyor; beklenen tarifedeki yakıt oranıyla hesaplandı' });
}

/**
 * Test kancası `sod_mock_recalc` (Mesaj 4): i1'in tarifesi sonradan değişmiş (bant "tarife değişti"), satır 1 itiraz listesinde ve
 * ölçümü değişmiş (rozet + "Yeni ölçümle hesapla"), satır 5'in eski farkı saklı ("ölçüm değişti, eski fark").
 */
if (localStorage.getItem('sod_mock_recalc') && !org?.empty) {
  const i1 = invoicesDb.find((x) => x.id === 'i1');
  const ls = linesDb.get('i1');
  if (i1 && ls) {
    Object.assign(ls[0], { decision: 'VERIFIED', recalcPending: 'MEASUREMENT', recalcPendingAt: iso(daysAgo(2)) });
    if (ls[4]?.diffAmount != null && ls[4].expectedAmount != null)
      ls[4].prevResult = { status: 'DIFF', diffTypes: ['DIMENSION'], expectedAmount: ls[4].expectedAmount - 120 + ls[4].diffAmount, diffAmount: 120, ourChargeableKg: 5, at: iso(daysAgo(5)), cause: 'MEASUREMENT' };
    i1.totals = totalsOf(ls);
    if (i1.tariffId) bumpRev(i1.tariffId);
  }
}

const json = async (r: Request) => (await r.json()) as Record<string, unknown>;

/** Son önizlenen örnek CSV: satırları POST /invoices kullanır. */
let sampleCsv: { headers: string[]; rows: string[][] } | null = null;
/** PDF fatura önizlemesinin dosya no'su (ilki `f1`). */
let pdfPreviewNo = 0;
const readCsv = (text: string) => {
  const [head, ...rows] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((r) => r.split(','));
  return { headers: head, rows };
};
/** Yalnız #5305 ölçülüyse: ölçü farkı +458,50 ve #5288 mükerrer +1.120,00; kalanı eşleşmez. */
function sampleLines(iid: string, csv: NonNullable<typeof sampleCsv>): InvoiceLine[] {
  const at = (r: string[], h: string) => r[csv.headers.indexOf(h)] ?? '';
  const seen = new Set<string>();
  return csv.rows.map((r, i) => {
    const trackingNo = at(r, 'Tracking ID');
    const net = Number(at(r, 'Net Charge Amount'));
    const m = measDb.find((x) => x.trackingNo === trackingNo);
    const dup = seen.has(trackingNo);
    seen.add(trackingNo);
    const base = mkLineFor(i, iid);
    const measured = m && trackingNo === '794812345305';
    const status: InvoiceLine['status'] = dup || measured ? 'DIFF' : 'UNMATCHED';
    return {
      ...base,
      trackingNo,
      netAmount: net,
      destCountry: at(r, 'Recipient Country/Territory'),
      status,
      diffTypes: dup ? ['DUPLICATE'] : measured ? ['DIMENSION'] : [],
      expectedAmount: measured ? 1184 : dup ? 0 : null,
      diffAmount: measured ? 458.5 : dup ? net : null,
      note: null,
      breakdown: measured ? base.breakdown : [],
      measurement: m ? { ...base.measurement!, id: m.id, lengthCm: m.lengthCm, widthCm: m.widthCm, heightCm: m.heightCm, weightKg: m.weightKg, measuredByName: m.measuredBy.name } : null,
    };
  });
}

/** /tariffs/:id/import ve /tariff-imports ortak: .pdf → belge keşfi, .xlsx/.csv → taslak */
async function mockUpload(f: File, tariffId: string | null, carrierId: string | null) {
  if (/\.pdf$/i.test(f.name)) {
    // fast: the document is only stored; scanning is a separate button
    const slow = /yavas/i.test(f.name);
    await delay(500);
    const docId = `doc${++seq}`;
    const t = tariffId ? tariffsDb.find((x) => x.id === tariffId) : null;
    const doc: TariffPdfUpload = {
      kind: 'pdf',
      documentId: docId,
      fileName: f.name,
      pages: 33,
      textLayer: !/taranmis|scan/i.test(f.name),
      target: tariffId ? { kind: 'existing', tariffId } : { kind: 'new', carrierId: carrierId! },
      ...(tariffId ? {} : { suggestedDefaults: { currency: 'USD', divisor: 5000 } }),
      // test kancası: yapay zekâ anahtarı yok
      ...(localStorage.getItem('sod_mock_pdf_empty') ? { aiAvailable: false } : {}),
    };
    pdfDocsDb.set(docId, { doc, tariffId, carrierId: carrierId ?? t?.carrierId ?? 'cf', unmatched: /eksik/i.test(f.name), slow, noAi: /noai/i.test(f.name), scanMode: null });
    return HttpResponse.json(doc);
  }
  if (!/\.(xlsx|csv)$/i.test(f.name)) return err(400, 'INVALID_FILE', 'Bu dosya okunamadı: yalnızca .xlsx, .csv ve .pdf desteklenir.');
  await delay(400);
  const draftId = `d${++seq}`;
  const rec: DraftRec = {
    tariffId: tariffId ?? '',
    kind: /list|rates|lb|us-/i.test(f.name) ? 'incident' : 'clean',
    fileName: f.name,
    noAi: /noai/i.test(f.name),
    aiFail: /aifail/i.test(f.name) ? 1 : 0,
    newCarrierId: carrierId ?? undefined,
  };
  draftsDb.set(draftId, rec);
  return HttpResponse.json(buildDraft(draftId, rec, {}));
}
const page = <T,>(items: T[], url: URL) => {
  const p = Number(url.searchParams.get('page') ?? 1);
  const ps = Number(url.searchParams.get('pageSize') ?? 50);
  return { items: items.slice((p - 1) * ps, p * ps), total: items.length, page: p, pageSize: ps };
};
function reportFile(invoiceId: string, ext: 'xlsx' | 'pdf') {
  const no = invoicesDb.find((x) => x.id === invoiceId)?.invoiceNo ?? invoiceId;
  return new HttpResponse(new Uint8Array(4096), {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="fark-raporu-${no}.${ext}"` },
  });
}

const settingsView = () => ({
  name: activeOrg()?.name ?? company.name,
  ...company.settings,
  fxSource: 'TCMB döviz alış/satış ortalaması',
  // test kancası: ENABLE_DATA_RESET karşılığı. Varsayılan kapalı (ARCHITECTURE §11).
  dataResetEnabled: !!localStorage.getItem('sod_mock_data_reset'),
});

const ONBOARDING_KEY = `sod_mock_ds_onboarding:${org?.id ?? 'none'}`;
const readOnboarding = (): OnboardingState => JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? (org?.empty ? '{}' : '{"completedAt":"2026-01-01T00:00:00.000Z"}')) as OnboardingState;
const writeOnboarding = (st: OnboardingState) => localStorage.setItem(ONBOARDING_KEY, JSON.stringify(st));
function onboardingFlags() {
  const st = readOnboarding();
  // API gibi: Merkez'de firma onayı yoksa kurulum bitmiş sayılmaz
  const completed = activeCompanyConfirmed() && !!st.completedAt;
  const carriers = carriersDb.filter((c) => c.active).length;
  return { completed, required: !completed && carriers === 0, showBanner: !completed && !st.bannerDismissedAt };
}
function onboardingStatus() {
  return {
    ...onboardingFlags(),
    // API gibi (`readState`): bu dört alan hep gelir
    state: { done: [], skipped: [], completedAt: null, bannerDismissedAt: null, ...readOnboarding() },
    boxPresetsReady: presets.some((p) => p.active),
    requiredSteps: ['tasiyicilar', 'tarifeler', 'olcum'],
    company: {
      name: activeOrg()?.name ?? company.name,
      currency: String(company.settings.currency ?? 'TRY'),
      country: String(company.settings.country ?? 'TR'),
      timeZone: String(company.settings.timeZone ?? 'Europe/Istanbul'),
      confirmed: activeCompanyConfirmed(),
    },
    carriers: carriersDb.map((c) => {
      const ts = tariffsDb.filter((t) => t.carrierId === c.id);
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        active: c.active,
        tariffs: ts.map((t) => ({ id: t.id, name: t.name, active: t.active, isDefault: t.isDefault })),
        activeTariffCount: ts.filter((t) => t.active).length,
      };
    }),
    boxPresets: presets.filter((p) => p.active).length,
    invoices: [],
    demo: { active: demoActive(), available: demoAvailable() },
  };
}
function clearData() {
  carriersDb.length = 0;
  tariffsDb.length = 0;
  invoicesDb.length = 0;
  measDb.length = 0;
  linesDb.clear();
  disputesMock.reset();
}
const SEED_TARIFF = tariffsDb[0];

// ---- Mesaj 14: örnek veriyle deneme turu (MESAJ-14 §4.3) ----
// Örnek taşıyıcı ve tarifeler, firma boşaltılmadan önceki tohumdan alınır. Ölçüm örneği yoktur (sahte sunucuda ölçümler `clientId` taşımaz).
// Test kancası: `sod_mock_no_demo` sunucudaki `DEMO_TOUR=off` gibi uçları 404 yapar.
const DEMO_SEED = { carriers: carriersDb.map((c) => ({ ...c })), tariffs: tariffsDb.map((t) => structuredClone(t)) };
const demoEnabled = () => !localStorage.getItem('sod_mock_no_demo');
const demoActive = () => !!(company.settings as { demo?: unknown }).demo;
const demoAvailable = () => demoEnabled() && !demoActive() && !carriersDb.length && !tariffsDb.length && !invoicesDb.length && !measDb.length;
const dayStamp = (n: number) => iso(daysAgo(n)).slice(0, 10);
/** FedEx faturası 5 gün önce (son güne 3 gün kalır), Aras faturası 20 gün önce (süresi dolmuş). */
function loadDemoData() {
  carriersDb.push(...DEMO_SEED.carriers.map((c) => ({ ...c })));
  tariffsDb.push(...DEMO_SEED.tariffs.map((t) => structuredClone(t)));
  addInvoice('DEMO-FEDEX-001', carriersDb.find((c) => c.code === 'fedex') ?? carriersDb[0], dayStamp(5), 12);
  addInvoice('DEMO-ARAS-001', carriersDb.find((c) => c.code === 'aras') ?? carriersDb[0], dayStamp(20), 8);
  return { carriers: DEMO_SEED.carriers.length, tariffs: DEMO_SEED.tariffs.length, measurements: 0, invoices: 2 };
}
/** Deneme bitince: taşıyıcı, tarife ve fatura gider; çalışanın deneme sırasında kaydettiği ölçüm kalır (`measDb` değişmez). */
function clearDemoData() {
  const removed = { invoices: invoicesDb.length, tariffs: tariffsDb.length, carriers: carriersDb.length, measurements: 0 };
  carriersDb.length = 0;
  tariffsDb.length = 0;
  invoicesDb.length = 0;
  linesDb.clear();
  disputesMock.reset();
  return removed;
}
function setDemo(on: boolean) {
  if (on) (company.settings as Record<string, unknown>).demo = { startedAt: iso(new Date()), byMemberId: activePerson()?.id ?? null };
  else delete (company.settings as Record<string, unknown>).demo;
  saveSettings();
}

// yeni firmada veri yoktur: kurulum sihirbazı açılır, firma değişince önceki firmanın verisi görünmez
if (org?.empty) clearData();
// sayfa yenilenince bellekteki örnek veri düşer ama deneme kaydı kalır: deneme açıksa örnek veri geri yüklenir
if (org?.empty && demoActive()) loadDemoData();

// ---- Mesaj 14: satır süzgeci (liste ve toplu karar aynı tanımı kullanır) ve toplu karar ----
const lineMatches = (l: InvoiceLine, f: BulkDecideFilter) =>
  (!f.decision?.length || f.decision.includes(l.decision)) &&
  (!f.status || l.status === f.status) &&
  (!f.diffType || l.diffTypes.includes(f.diffType)) &&
  (!f.q || l.trackingNo.includes(f.q)) &&
  (!f.recalcPending || !!l.recalcPending) &&
  (!f.review || l.confidence === 'LOW') &&
  (!f.flagged || (!!l.parseFlags?.length && !l.parseChecked));
const BULK_MAX = 5000;
/**
 * API'nin küme özetinin (Y127 `selectionDigest`) sahte karşılığı: süzgecin bütün satırlarının kimliği, kararı, durumu ve
 * işareti, kimliğe göre sıralı; 64 onaltılık hane (API SHA-256 + `updatedAt` kullanır; sahte sunucu yazılma anını tutmaz).
 */
function mockDigest(rows: readonly InvoiceLine[]): string {
  const text = rows.map((l) => `${l.id}|${l.decision}|${l.status}|${l.recalcPending ?? ''}`).sort().join('\n');
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
function bulkDecide(iid: string, b: BulkDecideBody) {
  const inv = invoicesDb.find((x) => x.id === iid);
  if (!inv) return err(404, 'NOT_FOUND', 'Fatura bulunamadı');
  const lines = linesDb.get(iid) ?? [];
  const decisions = ['VERIFIED', 'ACCEPTED', 'OPEN'];
  const hasIds = Array.isArray(b.lineIds);
  const hasFilter = !!b.filter && typeof b.filter === 'object';
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  // API gibi: gerekçe 1.000 (tek satırla aynı); süzgeçte `expectedCount` + `selectionDigest`; `undoOf` yalnız OPEN + kimliklerle
  const badUndo = !!b.undoOf && (b.decision !== 'OPEN' || !hasIds);
  if (
    !decisions.includes(b.decision) ||
    hasIds === hasFilter ||
    reason.length > 1000 ||
    (hasIds && !b.lineIds!.length) ||
    (hasFilter && (typeof b.expectedCount !== 'number' || typeof b.selectionDigest !== 'string')) ||
    badUndo
  )
    return err(400, 'VALIDATION', 'Girilen bilgiler geçersiz');
  if (b.decision === 'ACCEPTED' && !reason) return err(400, 'REASON_REQUIRED', 'Satırı uyumlu saymak için gerekçe yazılmalıdır');
  // Test kancası: `sod_mock_bulk_changed` bir sonraki toplu kararı API'nin "seçim değişti" yanıtıyla reddeder, hiçbir şey yazılmaz
  // (API'de listeden sonra süzgecin bir satırı yazılmış gibi; sahte sunucu yazılma anını tutmadığı için kancayla).
  // Servis çalışanı istekleri sayfadan önce yanıtladığı için `page.route` bu isteği göremez.
  if (localStorage.getItem('sod_mock_bulk_changed')) {
    localStorage.removeItem('sod_mock_bulk_changed');
    const n = hasIds ? b.lineIds!.length : (b.expectedCount ?? 0);
    return err(409, 'SELECTION_CHANGED', 'Seçili satırlar değişti; listeyi yenileyip yeniden deneyin.', { listed: n, current: n, changed: 1 });
  }
  let target: InvoiceLine[];
  if (hasIds) {
    if (b.lineIds!.length > BULK_MAX) return err(400, 'BULK_TOO_MANY', 'Tek seferde en çok 5.000 satır seçilebilir.');
    const ids = new Set(b.lineIds);
    target = lines.filter((l) => ids.has(l.id));
  } else {
    target = lines.filter((l) => lineMatches(l, b.filter!));
    // API gibi: önce sayı, sonra küme özeti (sahte özet yazılma anını içermez)
    if (target.length !== b.expectedCount) return err(409, 'SELECTION_CHANGED', 'Seçili satırlar değişti; listeyi yenileyip yeniden deneyin.', { listed: b.expectedCount, current: target.length, changed: 0 });
    if (target.length > BULK_MAX) return err(400, 'BULK_TOO_MANY', 'Tek seferde en çok 5.000 satır seçilebilir.');
    if (mockDigest(target) !== b.selectionDigest) return err(409, 'SELECTION_CHANGED', 'Seçili satırlar değişti; listeyi yenileyip yeniden deneyin.', { listed: b.expectedCount, current: target.length, changed: 1 });
  }
  const skipped = { inDispute: 0, noGap: 0, review: 0, decided: 0, pending: 0, notDecided: 0, noClaim: 0, changedSince: 0 };
  const changed: InvoiceLine[] = [];
  for (const l of target) {
    // API ile aynı uygunluk: itirazdaki satır hiçbir kararla değişmez
    if (disputesMock.lineLocked(iid, l.id)) skipped.inDispute++;
    else if (b.decision === 'OPEN') {
      if (l.decision === 'OPEN') skipped.notDecided++;
      // Geri al: yalnız o işlemin kararı (an aynı); arada verilen karar kalır
      else if (b.undoOf && l.decidedAt !== b.undoOf.decidedAt) skipped.changedSince++;
      else changed.push(l);
    } else if (l.decision !== 'OPEN') skipped.decided++;
    else if (l.status !== 'DIFF') skipped.noGap++;
    else if (l.recalcPending) skipped.pending++;
    else if (b.decision === 'VERIFIED' && !l.diffTypes.includes('DUPLICATE') && !((l.diffAmount ?? 0) > 0)) skipped.noClaim++;
    else if (b.decision === 'VERIFIED' && l.confidence === 'LOW') skipped.review++;
    else changed.push(l);
  }
  const reopened = b.decision === 'OPEN' ? changed.filter((l) => !!l.recalcPending).map((l) => l.id) : [];
  const at = iso(new Date());
  for (const l of changed) {
    l.decision = b.decision;
    l.decisionReason = b.decision === 'ACCEPTED' ? reason : b.decision === 'VERIFIED' ? reason || null : null;
    l.decidedAt = b.decision === 'OPEN' ? null : at;
  }
  // API gibi: kararı geri alınan ve yeniden hesap bekleyen satırlar faturanın sabit dayanağıyla hesaplanır
  if (reopened.length) writeSim(inv, simulate(inv, 'pinned', { lineIds: reopened }), 'pinned');
  inv.totals = totalsOf(lines);
  const result: BulkDecideResult = {
    opId: id(),
    decision: b.decision,
    changed: changed.length,
    changedLineIds: changed.map((l) => l.id),
    decidedAt: b.decision === 'OPEN' || !changed.length ? null : at,
    skipped,
    totals: inv.totals,
  };
  return HttpResponse.json(result);
}

// ---- Mesaj 7: arka plan işleri ----
// `?async=1` ile başlayan iş bellekte durur. İlk yoklamada RUNNING (1 / 2), sonrakinde SUCCEEDED döner.
// Test kancaları: `sod_mock_job_polls` (SUCCEEDED'dan önceki RUNNING yoklama sayısı, varsayılan 1) ve
// `sod_mock_job_fail` ('1' ise iş AI_FAILED ile biter).
interface MockJob {
  view: JobView;
  result: unknown;
  polls: number;
  /** toplu uygulama: onaylanan önizleme belirteci (farklı belirteçle ikinci başlatma 409 JOB_ACTIVE) */
  token?: string;
  /** iş bu hatayla biter (ör. bayat önizleme: PREVIEW_STALE) */
  fail?: NonNullable<JobView['error']>;
}
const jobsDb = new Map<string, MockJob>();
const jobIsFinished = (st: JobStatus) => st === 'SUCCEEDED' || st === 'FAILED' || st === 'CANCELLED';
const jobCopy = (j: MockJob, withResult: boolean): JobView => {
  const { result: _r, ...rest } = j.view;
  void _r;
  return withResult && (j.view.status === 'SUCCEEDED' || (j.view.status === 'CANCELLED' && j.view.kind === 'BULK_RECOMPARE_APPLY')) ? { ...rest, result: j.result } : { ...rest };
};
function startMockJob(kind: JobKind, ref: NonNullable<JobView['ref']>, stage: JobStage, result: unknown, params?: Record<string, unknown>, extra: { token?: string; fail?: MockJob['fail'] } = {}) {
  const active = [...jobsDb.values()].find((j) => j.view.kind === kind && j.view.ref?.id === ref.id && !jobIsFinished(j.view.status));
  if (active) return { job: jobCopy(active, false), joined: true };
  const at = new Date().toISOString();
  const j: MockJob = {
    polls: 0,
    result,
    ...extra,
    view: {
      id: `job-${++seq}`,
      kind,
      status: 'QUEUED',
      progress: { done: 0, total: null, stage },
      label: null,
      ref,
      ...(params ? { params } : {}),
      attempt: 1,
      cancellable: true,
      cancelRequested: false,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
    },
  };
  jobsDb.set(j.view.id, j);
  return { job: jobCopy(j, false), joined: false };
}
function pollMockJob(j: MockJob) {
  const v = j.view;
  if (jobIsFinished(v.status)) return;
  j.polls += 1;
  const need = Math.max(1, Number(localStorage.getItem('sod_mock_job_polls') ?? 1) || 1);
  const at = new Date().toISOString();
  v.startedAt ??= at;
  v.elapsedMs = j.polls * 1000;
  if (j.polls <= need) {
    v.status = 'RUNNING';
    v.progress = { ...v.progress, done: j.polls, total: need + 1 };
    // toplu uygulama: yazım sırasında sayaçlar (kontrol aşamasında ve diğer türlerde yok)
    if (v.kind === 'BULK_RECOMPARE_APPLY') v.counters = { invoices: j.polls, lines: j.polls * 10, inDispute: 0, stale: 0 };
    return;
  }
  v.finishedAt = at;
  if (j.fail) {
    v.status = 'FAILED';
    v.error = j.fail;
  } else if (localStorage.getItem('sod_mock_job_fail') === '1') {
    v.status = 'FAILED';
    v.error = { statusCode: 502, code: 'AI_FAILED', message: 'Yapay zekâ yanıt vermedi; biraz sonra yeniden deneyin.' };
  } else {
    v.status = 'SUCCEEDED';
    v.progress = { ...v.progress, done: need + 1, total: need + 1 };
    if (v.kind === 'BULK_RECOMPARE_APPLY') v.counters = { invoices: need + 1, lines: (need + 1) * 10, inDispute: 0, stale: 0 };
  }
}

export const handlers = [
  // Mesaj 14: deneme açıkken kendi veri ekleme 409 (API `DEMO_BLOCKED` ile aynı kapsam). Yanıt dönmezse sıradaki işleyici çalışır.
  ...(['/api/deciship/invoices', '/api/deciship/invoices/preview', '/api/deciship/invoices/samples', '/api/deciship/carriers', '/api/deciship/tariffs', '/api/deciship/tariffs/:id/duplicate'] as const).map((path) =>
    http.post(path, () => (demoActive() ? err(409, 'DEMO_ACTIVE', 'Örnek veriyle deneme açık. Kendi verinizi eklemek için önce denemeyi bitirin.') : undefined)),
  ),
  http.get('/api/deciship/jobs/:jobId', ({ params }) => {
    const j = jobsDb.get(String(params.jobId));
    if (!j) return err(404, 'NOT_FOUND', 'İş bulunamadı.');
    pollMockJob(j);
    return HttpResponse.json(jobCopy(j, true));
  }),
  http.get('/api/deciship/jobs', ({ request }) => {
    const q = new URL(request.url).searchParams;
    const items = [...jobsDb.values()]
      .filter((j) => (!q.get('active') || !jobIsFinished(j.view.status)) && (!q.get('kind') || j.view.kind === q.get('kind')) && (!q.get('refType') || j.view.ref?.type === q.get('refType')) && (!q.get('refId') || j.view.ref?.id === q.get('refId')))
      .slice(-20)
      .map((j) => jobCopy(j, false));
    return HttpResponse.json({ items });
  }),
  http.post('/api/deciship/jobs/:jobId/cancel', ({ params }) => {
    const j = jobsDb.get(String(params.jobId));
    if (!j) return err(404, 'NOT_FOUND', 'İş bulunamadı.');
    if (jobIsFinished(j.view.status)) return err(409, 'JOB_FINISHED', 'Bu iş zaten bitti.');
    j.view.status = 'CANCELLED';
    j.view.finishedAt = new Date().toISOString();
    // toplu uygulama: yazılanlar kalır, bölüm sonucu `stopped` ile döner (sahte sunucu işi baştan yazmıştı: kalan 0)
    if (j.view.kind === 'BULK_RECOMPARE_APPLY') j.result = { ...(j.result as object), stopped: 0 };
    return HttpResponse.json(jobCopy(j, false));
  }),
  http.delete('/api/deciship/invoices/preview/:fileId', () => new HttpResponse(null, { status: 204 })),
  // Y80-E2 / Y95: sürdürme bandı (sahte sunucuda yarım kalan okuma yok) ve açık önizlemenin tazelenmesi
  http.get('/api/deciship/invoices/preview/resumable', () => HttpResponse.json({ items: [] })),
  http.post('/api/deciship/invoices/preview/:fileId/keep', () => new HttpResponse(null, { status: 204 })),
  ...accountHandlers,
  productGuard,
  // `sod_mock_ai_quota`: bu ayki yapay zekâ hakkı dolmuş gibi (Y62-E3; PDF seçeneği kapanır)
  http.get('/api/deciship/me', () => {
    const aiAvailable = !localStorage.getItem('sod_mock_no_ai');
    const quotaExhausted = aiAvailable && Boolean(localStorage.getItem('sod_mock_ai_quota'));
    // API gibi (routes/me.ts): oturumdaki üyelik (kimlik ölçümlerdeki `measuredBy.id` ile aynı tür)
    const name = activeMemberName();
    return HttpResponse.json({
      company: { id: company.id, name: activeOrg()?.name ?? company.name, settings: company.settings },
      member: { id: membersDb.find((x) => x.name === name)?.id ?? 'm1', name },
      aiAvailable,
      ai: { available: aiAvailable, quotaExhausted },
      onboarding: onboardingFlags(),
    });
  }),
  http.get('/api/deciship/members', () => HttpResponse.json({ items: membersDb })),
  http.get('/api/deciship/settings/onboarding', () => HttpResponse.json(onboardingStatus())),
  http.patch('/api/deciship/settings/onboarding', async ({ request }) => {
    const b = (await request.json()) as OnboardingPatch;
    const st = readOnboarding();
    if (b.step) st.step = b.step;
    if (b.done) st.done = [...new Set([...(st.done ?? []), b.done])];
    if (b.skipped) st.skipped = [...new Set([...(st.skipped ?? []), b.skipped])];
    if (b.complete !== undefined) st.completedAt = b.complete ? new Date().toISOString() : null;
    if (b.dismissBanner) st.bannerDismissedAt = new Date().toISOString();
    writeOnboarding(st);
    return HttpResponse.json(onboardingStatus());
  }),
  http.post('/api/deciship/settings/data/reset', async ({ request }) => {
    if (!localStorage.getItem('sod_mock_data_reset')) return err(404, 'NOT_FOUND', 'Kayıt bulunamadı.');
    const b = await json(request);
    const removed = { invoices: invoicesDb.length, measurements: measDb.length, carriers: carriersDb.length };
    clearData();
    return HttpResponse.json({ removed, loaded: b.samples ? { carriers: 0, tariffs: 0, measurements: 0 } : null });
  }),
  http.get('/api/deciship/dashboard', ({ request }) => {
    // test kancası: yalnız bu ayda fatura var (dönem seçimi)
    const only = localStorage.getItem('sod_mock_invoice_month');
    const month = new URL(request.url).searchParams.get('month');
    // para birimleri toplanmaz: baş rakam TRY faturalarından, diğer para birimi ayrı satırda
    const all = only && month !== only ? [] : invoicesDb.filter((i) => i.currency === 'TRY').map((i) => i.totals);
    const usd = only && month !== only ? [] : invoicesDb.filter((i) => i.currency === 'USD');
    const sum = (k: keyof InvoiceTotals) => all.reduce((s, t) => s + ((t[k] as number | undefined) ?? 0), 0);
    const topDiffTypes = [
      { type: 'DIMENSION', count: 2, amount: 917 },
      { type: 'SURCHARGE', count: 1, amount: 212.4 },
      { type: 'WEIGHT', count: 1, amount: 95 },
    ];
    // API gibi: para birimi satırında tahmini fazla ödeme ve fark türleri de var
    const perCurrency = { estimatedOverchargeTotal: 0, topDiffTypes };
    return HttpResponse.json({
      month: month ?? turkeyDate(new Date()).slice(0, 7),
      otherCurrencies: [],
      measurements: { count: measDb.length, byMethod: { LIDAR: 7, REFERENCE: 5, MANUAL: 5, PRESET: 4, AR: 2 }, today: 3 },
      invoices: { count: all.length, lines: sum('lines'), match: sum('match'), diff: sum('diff'), unmatched: sum('unmatched'), noTariff: sum('noTariff') },
      overchargeTotal: sum('overchargeTotal'),
      verifiedTotal: sum('verifiedTotal'),
      coveragePct: 91.7,
      topDiffTypes,
      recentInvoices: invoicesDb.slice(0, 5).map(invoiceListItem),
      currency: 'TRY',
      ...disputesMock.dashboardTotals('TRY'),
      byCurrency: [
        { currency: 'TRY', invoices: all.length, lines: sum('lines'), billedTotal: sum('billedTotal'), overchargeTotal: sum('overchargeTotal'), verifiedTotal: sum('verifiedTotal'), ...perCurrency, ...disputesMock.dashboardTotals('TRY') },
        ...(usd.length
          ? [
              {
                currency: 'USD',
                invoices: usd.length,
                lines: usd.reduce((x, i) => x + i.totals.lines, 0),
                billedTotal: usd.reduce((x, i) => x + i.totals.billedTotal, 0),
                overchargeTotal: usd.reduce((x, i) => x + i.totals.overchargeTotal, 0),
                verifiedTotal: usd.reduce((x, i) => x + i.totals.verifiedTotal, 0),
                ...perCurrency,
                ...disputesMock.dashboardTotals('USD'),
              },
            ]
          : []),
        // test kancası: ikinci para biriminde fatura
        ...(localStorage.getItem('sod_mock_multi_currency') ? [{ currency: 'USD', invoices: 2, lines: 9, billedTotal: 840, overchargeTotal: 120.5, verifiedTotal: 0, recoveredTotal: 0, disputePendingTotal: 0, ...perCurrency }] : []),
      ],
    });
  }),

  http.get('/api/deciship/settings', () => HttpResponse.json(settingsView())),
  http.patch('/api/deciship/settings', async ({ request }) => {
    const rest = await json(request);
    // API gibi: firma para birimi ve ülkesi yalnız Merkez'den gelir
    for (const field of ['currency', 'country', 'demo']) {
      if (field in (rest as object)) return HttpResponse.json({ error: { code: 'VALIDATION', message: field } }, { status: 400 });
    }
    Object.assign(company.settings, rest);
    saveSettings();
    return HttpResponse.json(settingsView());
  }),

  http.get('/api/deciship/box-presets', () => HttpResponse.json({ items: presets })),
  http.post('/api/deciship/box-presets', async ({ request }) => {
    const p = { id: id(), active: true, ...(await json(request)) } as BoxPreset;
    presets.push(p);
    return HttpResponse.json({ preset: p }, { status: 201 });
  }),
  http.patch('/api/deciship/box-presets/:id', async ({ request, params }) => {
    const p = presets.find((x) => x.id === params.id)!;
    Object.assign(p, await json(request));
    return HttpResponse.json({ preset: p });
  }),
  http.delete('/api/deciship/box-presets/:id', ({ params }) => {
    presets.splice(presets.findIndex((x) => x.id === params.id), 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/deciship/measurements', ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    const method = url.searchParams.get('method') ?? '';
    const items = measDb.filter((m) => (!q || m.trackingNo.includes(q)) && (!method || m.dimMethod === method));
    return HttpResponse.json(page(items, url));
  }),
  http.get('/api/deciship/measurements/:id', ({ params }) => {
    const m = measDb.find((x) => x.id === params.id);
    if (!m) return err(404, 'NOT_FOUND', 'Ölçüm bulunamadı');
    const inv = invoicesDb[invoicesDb.length - 1];
    const line = linesDb.get(inv.id)?.find((l) => l.measurement?.id === m.id);
    return HttpResponse.json({
      measurement: {
        ...m,
        photos: [
          { id: 'a', kind: 'PHOTO_BOX', url: photo('Kutu ön', '#4f6b8a') },
          { id: 'b', kind: 'PHOTO_BOX', url: photo('Kutu yan', '#5d4f8a') },
          { id: 'c', kind: 'PHOTO_SCALE', url: photo('Tartı', '#33533d') },
        ],
        history: m.version > 1 ? [{ ...m, id: 'old', version: 1, lengthCm: 41, widthCm: 30, heightCm: 25, weightKg: 4.1, createdAt: iso(daysAgo(2)) }] : [],
        invoiceLines: line
          ? [
              {
                id: line.id,
                invoiceId: inv.id,
                invoiceNo: inv.invoiceNo,
                invoiceDate: inv.invoiceDate,
                carrierName: inv.carrier.name,
                trackingNo: line.trackingNo,
                status: line.status,
                decision: line.decision,
                diffTypes: line.diffTypes,
                diffAmount: line.diffAmount,
                netAmount: line.netAmount,
                expectedAmount: line.expectedAmount,
                ourChargeableKg: line.ourChargeableKg,
                billedChargeableKg: line.billedChargeableKg,
                dims: null,
                measurementPinned: line.measurementPinned ?? false,
              },
            ]
          : [],
        // API gibi: bu kişi bu ölçümü düzenleyebilir mi (sahte sunucuda hep yönetici)
        canEdit: true,
      },
    });
  }),
  http.patch('/api/deciship/measurements/:id', async ({ request, params }) => {
    const m = measDb.find((x) => x.id === params.id)!;
    Object.assign(m, await json(request), { version: m.version + 1 });
    return HttpResponse.json({ measurement: m });
  }),
  http.post('/api/deciship/measurements', async ({ request }) => {
    const fd = await request.formData();
    const d = JSON.parse(String(fd.get('data')));
    const m = { ...MEASUREMENT_DEFAULTS, createdAt: iso(new Date()), ...d, id: id(), trackingNo: d.trackingRaw, desi: 0, volumetricKg5000: 0, measuredBy: { id: 'm1', name: activeMemberName() }, photoCount: fd.getAll('photos').length, version: 1 };
    measDb.unshift(m);
    return HttpResponse.json({ measurement: m }, { status: 201 });
  }),
  http.delete('/api/deciship/measurements/:id', ({ params }) => {
    measDb.splice(measDb.findIndex((x) => x.id === params.id), 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // API gibi: liste satırında kayıt anı ve bağlı fatura / tarife sayısı
  http.get('/api/deciship/carriers', () =>
    HttpResponse.json({
      items: carriersDb.map((c) => ({
        createdAt: '2026-01-05T09:00:00.000Z',
        ...c,
        invoiceCount: invoicesDb.filter((i) => i.carrier.id === c.id).length,
        tariffCount: tariffsDb.filter((t) => t.carrierId === c.id).length,
      })),
    }),
  ),
  http.post('/api/deciship/carriers', async ({ request }) => {
    const c = { id: id(), active: true, defaultMapping: null, ...(await json(request)) } as Carrier;
    carriersDb.push(c);
    return HttpResponse.json({ carrier: c }, { status: 201 });
  }),
  http.patch('/api/deciship/carriers/:id', async ({ request, params }) => {
    const c = carriersDb.find((x) => x.id === params.id)!;
    Object.assign(c, await json(request));
    return HttpResponse.json({ carrier: c });
  }),
  http.delete('/api/deciship/carriers/:id', ({ params }) => {
    carriersDb.splice(carriersDb.findIndex((x) => x.id === params.id), 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/deciship/tariffs', ({ request }) => {
    const cid = new URL(request.url).searchParams.get('carrierId');
    // API gibi (`TariffSummary`): liste fiyat tablolarını taşımaz, sayılarını verir
    const items = tariffsDb
      .filter((t) => !cid || t.carrierId === cid)
      .map(({ zones, rates, overflow: _o, surcharges, weightSteps: _w, countryAdjustments: _c, ...rest }) => ({
        ...rest,
        carrier: carrierRef(rest.carrierId),
        zoneCount: new Set(rates.map((r) => r.zone)).size,
        rateCount: rates.length,
        countryCount: zones.length,
        surchargeCount: surcharges.length,
      }));
    return HttpResponse.json({ items });
  }),
  // hata sayfasını denemek için: eksik alanlı tarife (eski paket / yeni API uyumsuzluğu taklidi)
  http.get('/api/deciship/tariffs/bozuk', () => HttpResponse.json({ tariff: { id: 'bozuk', name: 'Bozuk', carrierId: 'cf' } })),
  http.get('/api/deciship/tariffs/template.xlsx', () => new HttpResponse('mock', { headers: { 'Content-Type': 'application/octet-stream' } })),
  http.get('/api/deciship/tariffs/:id', ({ params }) => {
    const t = tariffsDb.find((x) => x.id === params.id);
    // API gibi: taşıyıcı özeti, ülke istisnaları (boşsa []) ve kayıt anı hep gelir
    return t ? HttpResponse.json({ tariff: { countryAdjustments: [], createdAt: '2026-01-05T09:00:00.000Z', ...t, carrier: carrierRef(t.carrierId) }, pinnedInvoices: invoicesDb.filter((i) => pinOf(i).tariffId === t.id).length }) : err(404, 'NOT_FOUND', 'Tarife bulunamadı');
  }),
  http.post('/api/deciship/tariffs', async ({ request }) => {
    const b = await json(request);
    const dup = duplicateTariffRow(b as Partial<Tariff>);
    if (dup) return duplicateError(dup);
    const t = touchTariff({ id: id(), ...b } as Tariff);
    clearOtherDefault(t);
    tariffsDb.push(t);
    return HttpResponse.json({ tariff: t }, { status: 201 });
  }),
  http.put('/api/deciship/tariffs/:id', async ({ request, params }) => {
    const i = tariffsDb.findIndex((x) => x.id === params.id);
    if (i < 0) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
    const { expectedUpdatedAt, ...b } = await json(request);
    const dup = duplicateTariffRow(b as Partial<Tariff>);
    if (dup) return duplicateError(dup);
    if (expectedUpdatedAt && expectedUpdatedAt !== tariffsDb[i].updatedAt)
      return err(409, 'STALE', 'Bu tarife siz bakarken değişti. Güncel hâlini yükleyip yeniden deneyin.', { updatedAt: tariffsDb[i].updatedAt });
    snapshot(tariffsDb[i], 'EDIT', 'Elle düzenlenmeden önceki sürüm');
    tariffsDb[i] = touchTariff({ id: String(params.id), ...b } as Tariff);
    clearOtherDefault(tariffsDb[i]);
    bumpRev(tariffsDb[i].id);
    return HttpResponse.json({ tariff: tariffsDb[i], ...tariffCounts(tariffsDb[i]) });
  }),
  http.delete('/api/deciship/tariffs/:id', ({ params }) => {
    // Mesaj 4: tarife gerçekten silinir; fatura sabit dayanağıyla (aynı rakamla) kalır, adı "(silindi)" ile görünür
    for (const inv of invoicesDb) {
      if (inv.tariffId !== params.id) continue;
      pinOf(inv);
      inv.tariffId = null;
      inv.tariff = null;
      for (const l of linesDb.get(inv.id) ?? []) if (l.tariffId === params.id) Object.assign(l, { tariffId: null, tariff: null });
    }
    tariffsDb.splice(tariffsDb.findIndex((x) => x.id === params.id), 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/deciship/tariffs/:id/default', ({ params }) => {
    const t = tariffsDb.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
    if (!t.active) return err(400, 'TARIFF_INACTIVE', 'Pasif tarife varsayılan yapılamaz');
    for (const x of tariffsDb) if (x.carrierId === t.carrierId && x.isDefault !== (x.id === t.id)) touchTariff(Object.assign(x, { isDefault: x.id === t.id }));
    return HttpResponse.json({ tariff: t });
  }),
  http.post('/api/deciship/tariffs/:id/duplicate', ({ params }) => {
    const t = touchTariff({ ...tariffsDb.find((x) => x.id === params.id)!, id: id() });
    t.name += ' (kopya)';
    t.isDefault = false;
    tariffsDb.push(t);
    return HttpResponse.json({ tariff: t }, { status: 201 });
  }),
  http.post('/api/deciship/tariffs/:id/quote', () =>
    HttpResponse.json({
      ok: true,
      zone: 'A',
      chargeableKg: 6,
      // API gibi (`quoteTariff`): hacim ağırlığı, hangisinin esas alındığı, navlun, ülke düzeltmesi, para birimi
      volumetricKg: 6,
      basis: 'VOLUMETRIC',
      freight: 947.2,
      adjustment: 0,
      adjustmentPct: 0,
      currency: 'TRY',
      lines: [
        { label: 'Tarife fiyatı (A, 6,0 kg)', amount: 1527.75 },
        { label: 'İndirim %38', amount: -580.55 },
        { label: 'Yakıt %25', amount: 236.8 },
      ],
      base: 1527.75,
      discount: 580.55,
      fuel: 236.8,
      surcharges: 0,
      total: 1184,
    }),
  ),
  http.post('/api/deciship/tariffs/:id/import', async ({ request, params }) => mockUpload((await request.formData()).get('file') as File, String(params.id), null)),
  http.post('/api/deciship/tariff-imports', async ({ request }) => {
    const fd = await request.formData();
    const cid = String(fd.get('carrierId') ?? '');
    if (!carriersDb.some((c) => c.id === cid)) return err(400, 'VALIDATION', 'Taşıyıcı seçin.');
    return mockUpload(fd.get('file') as File, null, cid);
  }),
  http.post('/api/deciship/tariff-documents/:docId/scan', async ({ request, params }) => {
    const doc = pdfDocsDb.get(String(params.docId));
    if (!doc) return err(404, 'NOT_FOUND', 'Belgenin süresi doldu; PDF’i yeniden yükleyin.');
    const mode = ((await json(request)).mode === 'ai' ? 'ai' : 'code') as PdfScanMode;
    const asJob = mode === 'ai' && new URL(request.url).searchParams.has('async');
    if (mode === 'ai') {
      if (doc.noAi) {
        await delay(400);
        return err(503, 'AI_DISABLED', 'Yapay zekâ anahtarı tanımlı değil.');
      }
      if (!asJob) return asyncRequired();
    } else await delay(900);
    const r = fedexScan(mode, !doc.doc.textLayer);
    const reply = (body: TariffPdfScan) =>
      asJob ? HttpResponse.json(startMockJob('TARIFF_PDF_SCAN', { type: 'TariffDocument', id: doc.doc.documentId }, 'tariffScan', body), { status: 202 }) : HttpResponse.json(body);
    if (localStorage.getItem('sod_mock_pdf_empty')) return reply({ ...r, sections: [], suggestedSectionIds: [], message: "Bu PDF'teki tablolar otomatik okunamadı. Yapay zekâ ile taramayı deneyin." });
    if (r.sections.length) doc.scanMode = mode;
    return reply(r);
  }),
  http.post('/api/deciship/tariff-documents/:docId/extract', async ({ request, params }) => {
    const doc = pdfDocsDb.get(String(params.docId));
    if (!doc) return err(404, 'NOT_FOUND', 'Belgenin süresi doldu; PDF’i yeniden yükleyin.');
    if (!doc.scanMode) return err(400, 'VALIDATION', 'Önce PDF’i tarayın.');
    const b = (await json(request)) as unknown as PdfExtractBody;
    if (!b.sectionIds?.length) return err(400, 'VALIDATION', 'En az bir tablo seçin.');
    if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
    const draftId = `d${++seq}`;
    const nt = 'newTariff' in b.target ? b.target.newTariff : null;
    const rec: DraftRec = {
      tariffId: nt ? '' : 'tariffId' in b.target ? b.target.tariffId : (doc.tariffId ?? ''),
      kind: 'clean',
      fileName: doc.doc.fileName,
      noAi: doc.noAi,
      aiFail: 0,
      newCarrierId: nt || !doc.tariffId ? doc.carrierId : undefined,
      pdf: { docId: doc.doc.documentId, sectionIds: b.sectionIds, includeCountryZones: b.includeCountryZones, newTariff: nt ? { name: nt.name ?? '', service: nt.service ?? '' } : null },
    };
    draftsDb.set(draftId, rec);
    const started = startMockJob('TARIFF_PDF_EXTRACT', { type: 'TariffDocument', id: doc.doc.documentId }, 'tariffExtract', buildDraft(draftId, rec, {}), {
      sectionIds: b.sectionIds,
      includeCountryZones: b.includeCountryZones,
      pricing: b.pricing ?? 'table',
    });
    return HttpResponse.json(started, { status: 202 });
  }),
  http.post('/api/deciship/tariff-imports/:draftId/recheck', async ({ request, params }) => {
    const rec = draftsDb.get(String(params.draftId));
    if (!rec) return err(404, 'DRAFT_NOT_FOUND', 'Taslak bulunamadı; dosyayı yeniden yükleyin.');
    const b = await json(request);
    await delay(300);
    return HttpResponse.json(buildDraft(String(params.draftId), rec, (b.options ?? {}) as ImportOptions));
  }),
  http.post('/api/deciship/tariff-imports/:draftId/review', async ({ request, params }) => {
    const rec = draftsDb.get(String(params.draftId));
    const ro = ((await json(request)).options ?? {}) as ImportOptions;
    if (!rec) return err(404, 'DRAFT_NOT_FOUND', 'Taslak bulunamadı; dosyayı yeniden yükleyin.');
    if (rec.noAi) return err(503, 'AI_DISABLED', 'Yapay zekâ anahtarı tanımlı değil.');
    await delay(2000);
    if (rec.aiFail > 0) {
      rec.aiFail--;
      return err(502, 'AI_FAILED', 'Yapay zekâ yanıtı okunamadı.');
    }
    const r = rec.pdf ? pdfAiReview(rec) : aiReview(rec, ro);
    rec.ai = { key: optKey(ro), verdict: r.verdict };
    return HttpResponse.json(r);
  }),
  http.post('/api/deciship/tariff-imports/:draftId/apply', async ({ request, params }) => {
    const rec = draftsDb.get(String(params.draftId));
    if (!rec) return err(404, 'NOT_FOUND', 'Önizlemenin süresi doldu, dosyayı tekrar yükleyin.');
    const b = await json(request);
    const o = (b.options ?? {}) as ImportOptions;
    const d = buildDraft(String(params.draftId), rec, o);
    const meta = (b.meta ?? {}) as { name?: string; service?: string | null; validFrom?: string | null; validTo?: string | null; currency?: string; divisor?: number; fuelPct?: number; discountPct?: number };
    if (meta.name !== undefined && !meta.name.trim()) return err(400, 'VALIDATION', 'Tarife adı boş olamaz.');
    if (rec.newCarrierId && !meta.name?.trim()) return err(400, 'VALIDATION', 'Yeni tarife için ad gerekli.');
    if (meta.validFrom && meta.validTo && meta.validFrom > meta.validTo) return err(400, 'VALIDATION', 'Geçerlilik bitişi başlangıçtan önce olamaz.');
    if (!d.canApply) return err(422, 'IMPORT_BLOCKED', 'Bu dosya bu haliyle yüklenemez.', { checks: d.checks });
    // ack iff code warnings, or an AI review of these same options whose verdict is not "ok" (AI not run → no ack)
    const aiNow = rec.ai && rec.ai.key === optKey(o) ? rec.ai.verdict : null;
    // Sunucuyla aynı: yeni tarifede oran yazıldıysa "Dosyada indirim yok" yanıtlanmıştır
    const warnN = d.checks.filter((c) => c.severity === 'warning' && !(c.code === 'NO_DISCOUNT' && rec.newCarrierId && meta.discountPct != null)).length;
    if ((warnN > 0 || (aiNow && aiNow !== 'ok')) && !b.acknowledged)
      return err(409, 'ACK_REQUIRED', 'Uyarılar onaylanmadan uygulanamaz.', { warnings: warnN, aiVerdict: aiNow, aiReviewed: Boolean(aiNow) });
    if (rec.newCarrierId) {
      await delay(500);
      const nt: Tariff = {
        id: id(),
        carrierId: rec.newCarrierId,
        name: meta.name!.trim(),
        service: meta.service ?? null,
        currency: o.currency ?? meta.currency ?? d.summary.tariffCurrency,
        divisor: meta.divisor ?? 5000,
        edgeRounding: 'CEIL_CM',
        weightSteps: [],
        discountPct: meta.discountPct ?? 0,
        fuelPct: meta.fuelPct ?? 0,
        fuelVariable: true,
        validFrom: meta.validFrom ?? null,
        validTo: meta.validTo ?? null,
        active: true,
        isDefault: !tariffsDb.some((x) => x.carrierId === rec.newCarrierId),
        zones: d.zones,
        rates: d.rates,
        overflow: d.overflow,
        surcharges: d.surcharges,
      };
      tariffsDb.push(touchTariff(nt));
      draftsDb.delete(String(params.draftId));
      return HttpResponse.json({ tariff: nt, versionId: null, ...tariffCounts(nt) });
    }
    const t = tariffsDb.find((x) => x.id === rec.tariffId)!;
    const versionId = snapshot(t, 'IMPORT', `${rec.fileName} içe aktarılmadan önceki sürüm`);
    t.rates = d.rates;
    t.overflow = d.overflow;
    t.surcharges = d.surcharges;
    if (d.zones.length) t.zones = d.zones;
    if (o.currency) t.currency = o.currency;
    Object.assign(t, meta);
    touchTariff(t);
    bumpRev(t.id);
    draftsDb.delete(String(params.draftId));
    return HttpResponse.json({ tariff: t, versionId, ...tariffCounts(t) });
  }),
  http.get('/api/deciship/tariffs/:id/versions', ({ params }) => HttpResponse.json({ items: versionsDb.filter((v) => v.tariffId === params.id).map((v) => v.meta) })),
  http.post('/api/deciship/tariffs/:id/versions/:versionId/restore', ({ params }) => {
    const v = versionsDb.find((x) => x.meta.id === params.versionId && x.tariffId === params.id);
    const i = tariffsDb.findIndex((x) => x.id === params.id);
    if (!v || i < 0) return err(404, 'NOT_FOUND', 'Sürüm bulunamadı');
    const when = new Date(v.meta.createdAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const versionId = snapshot(tariffsDb[i], 'RESTORE', `Geri yüklemeden önceki sürüm (${when} tarihli sürüm geri yüklendi)`);
    tariffsDb[i] = touchTariff({ ...structuredClone(v.snap), id: tariffsDb[i].id });
    const t = tariffsDb[i];
    bumpRev(t.id);
    return HttpResponse.json({ tariff: t, versionId, ...tariffCounts(t) });
  }),
  // Mesaj 4: toplu önizleme → onay (token zorunlu, etkin itirazı olan fatura atlanır)
  http.post('/api/deciship/tariffs/:id/recompare-invoices/preview', async ({ request, params }) => {
    const t = tariffsDb.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
    if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
    return bulkPreviewJob({ type: 'Tariff', id: t.id }, tariffScope(t), 'tariff');
  }),
  http.post('/api/deciship/tariffs/:id/recompare-invoices', async ({ request, params }) => {
    const t = tariffsDb.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
    const b = await json(request);
    if (!b.token) return err(400, 'VALIDATION', 'token gerekli');
    if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
    return bulkApplyJob({ type: 'Tariff', id: t.id }, tariffScope(t), String(b.token), 'tariff');
  }),
  // SPEC §3.9: ülke istisnası; Mesaj 4'te fatura kendiliğinden yeniden hesaplanmaz (yeni sürüm doğar)
  http.post('/api/deciship/tariffs/:id/country-adjustments', async ({ request, params }) => {
    const t = tariffsDb.find((x) => x.id === params.id);
    if (!t) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
    const b = (await json(request)) as unknown as NonNullable<Tariff['countryAdjustments']>[number];
    const versionId = snapshot(t, 'EDIT', 'Ülke istisnasından önceki sürüm');
    const rest = (t.countryAdjustments ?? []).filter((x) => x.country !== b.country);
    t.countryAdjustments = b.pct === 0 ? rest : [...rest, b];
    touchTariff(t);
    bumpRev(t.id);
    return HttpResponse.json({ tariff: t, versionId, totals: null, health: null });
  }),
  http.post('/api/deciship/settings/recompare-invoices/preview', async ({ request }) => {
    if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
    return bulkPreviewJob({ type: 'Company', id: org?.id ?? 'company' }, settingsScope(), 'rules');
  }),
  http.post('/api/deciship/settings/recompare-invoices', async ({ request }) => {
    const b = await json(request);
    if (!b.token) return err(400, 'VALIDATION', 'token gerekli');
    if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
    return bulkApplyJob({ type: 'Company', id: org?.id ?? 'company' }, settingsScope(), String(b.token), 'rules');
  }),

  ...disputesMock.handlers,
  http.post('/api/deciship/settings/demo', () => {
    if (!demoEnabled()) return err(404, 'NOT_FOUND', 'Kayıt bulunamadı.');
    if (demoActive()) return err(409, 'DEMO_ACTIVE', 'Örnek veriyle deneme açık. Kendi verinizi eklemek için önce denemeyi bitirin.');
    if (carriersDb.length || tariffsDb.length || invoicesDb.length || measDb.length) return err(409, 'DEMO_NOT_EMPTY', 'Örnek veri yalnız henüz veri girilmemiş firmada açılabilir.');
    setDemo(true);
    const loaded = loadDemoData();
    writeOnboarding({ ...readOnboarding(), completedAt: new Date().toISOString() });
    return HttpResponse.json(loaded, { status: 201 });
  }),
  http.delete('/api/deciship/settings/demo', () => {
    if (!demoEnabled()) return err(404, 'NOT_FOUND', 'Kayıt bulunamadı.');
    if (!demoActive()) return err(409, 'DEMO_NOT_ACTIVE', 'Örnek veriyle deneme açık değil.');
    const removed = clearDemoData();
    setDemo(false);
    writeOnboarding({ ...readOnboarding(), completedAt: null });
    return HttpResponse.json({ removed });
  }),
  http.post('/api/deciship/invoices/:id/lines/decide', async ({ request, params }) => bulkDecide(String(params.id), (await json(request)) as unknown as BulkDecideBody)),
  http.get('/api/deciship/invoices', ({ request }) => {
    const url = new URL(request.url);
    // Mesaj 14 §4.2: q = fatura no (büyük-küçük harf duyarsız) ya da tam takip no (4+ karakter); status = DIFF | UNMATCHED | TO_DISPUTE
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64).toLowerCase();
    const tracking = normalizeTracking(q);
    const status = url.searchParams.get('status');
    const list = invoicesDb.filter((i) => {
      if (q && !i.invoiceNo.toLowerCase().includes(q) && !(tracking.length >= 4 && (linesDb.get(i.id) ?? []).some((l) => normalizeTracking(l.trackingNo) === tracking))) return false;
      if (status === 'DIFF') return i.totals.diff > 0;
      if (status === 'UNMATCHED') return i.totals.unmatched > 0;
      if (status === 'TO_DISPUTE') return i.totals.overchargeTotal > 0 && !disputesMock.hasActive(i.id);
      return true;
    });
    const p = page(list, url);
    return HttpResponse.json({ ...p, items: p.items.map((i) => ({ ...invoiceListItem(i), ...disputesMock.listFields(i.id) })) });
  }),
  http.get('/api/deciship/invoices/:id', ({ params }) => {
    // API bozuk kimliği 400 ile reddedebilir
    if (params.id === 'bozuk') return err(400, 'VALIDATION', 'Geçersiz kimlik');
    const inv = invoicesDb.find((x) => x.id === params.id);
    if (!inv) return err(404, 'NOT_FOUND', 'Fatura bulunamadı');
    // API ile aynı kural: karşılaştırılan satırların çoğunda fiyat farkı → tarife şüphesi
    const ls = linesDb.get(inv.id) ?? [];
    const compared = ls.filter((l) => l.status === 'MATCH' || l.status === 'DIFF').length;
    const priceDiff = ls.filter((l) => l.status === 'DIFF' && l.diffTypes.includes('PRICE')).length;
    // Mesaj 5: ilk örnek faturada yükleme özeti ve "Nasıl hesaplandı?" dökümü (adımların toplamı fazla ödemeye eşit)
    const m5 =
      inv.id === 'i1'
        ? {
            importReport: {
              version: 1,
              source: 'table',
              rowsInFile: 15,
              linesImported: 12,
              skippedCount: 3,
              byReason: { BAD_NET: 2, NO_TRACKING: 1 },
              skippedRows: [
                { row: 4, reason: 'BAD_NET', rawNet: 'n/a' },
                { row: 9, reason: 'BAD_NET', rawNet: '—' },
                { row: 15, reason: 'NO_TRACKING', amount: 45 },
              ],
              noTrackingAmount: 45,
            },
            totals: {
              ...inv.totals,
              overchargeByType: [{ type: 'PRICE', lines: inv.totals.diff, amount: inv.totals.overchargeTotal }],
              reconciliation: {
                steps: [
                  { key: 'netDiff', amount: Math.round((inv.totals.overchargeTotal + 45) * 100) / 100, lines: inv.totals.diff },
                  { key: 'uncompared', amount: 0, lines: 0 },
                  { key: 'accepted', amount: -45, lines: 1 },
                ],
                overchargeTotal: inv.totals.overchargeTotal,
              },
            },
          }
        : {};
    return HttpResponse.json({
      invoice: {
        ...inv,
        ...m5,
        tariffId: inv.tariffId ?? null,
        tariff: inv.tariff ?? null,
        tariffsUsed: tariffsUsedOf(inv.id),
        tariffSuspect: isTariffSuspect(compared, priceDiff),
        dispute: disputesMock.invoiceDispute(inv.id),
        basis: basisOf(inv),
        status: 'PROCESSED',
        fileUrl: '#',
        fileName: 'fedex-9-482-11735.csv',
        // API gibi: kaynak dosya, biçimi, kayıtlı sütun eşlemesi ve dönem (yoksa null) hep gelir
        sourceFileId: `file-${inv.id}`,
        fileFormat: 'csv',
        mapping: { trackingNo: 'Tracking ID', billedKg: 'Rated Weight', netAmount: 'Net Charge Amount', surchargeColumns: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false },
        periodFrom: inv.periodFrom ?? null,
        periodTo: inv.periodTo ?? null,
      },
    });
  }),
  // Mesaj 4: önce/sonra (yazmaz) ve onay (token ile)
  http.post('/api/deciship/invoices/:id/recalculate/preview', async ({ request, params }) => {
    await delay(250);
    const inv = invoicesDb.find((x) => x.id === params.id);
    if (!inv) return err(404, 'NOT_FOUND', 'Fatura bulunamadı');
    const b = await json(request);
    const basis = b.basis as RecalcBasis;
    const lineIds = b.lineIds as string[] | undefined;
    const patch = b.patch as MockPatch | undefined;
    // API ile aynı: satır seçimi ve düzenleme önizlemesi yalnız sabit dayanakla
    if ((lineIds || patch) && basis !== 'pinned') return err(400, 'VALIDATION', 'Seçili satırlar ve fatura düzenlemesi yalnız faturanın kendi tarifesi ve ayarıyla hesaplanır');
    if ((basis !== 'pinned' || patch) && disputesMock.hasActive(inv.id))
      return err(409, 'INVOICE_HAS_DISPUTE', 'Bu faturanın gönderilmiş itirazı var; önce itirazı geri çekin.');
    if (lineIds?.some((lid) => disputesMock.lineLocked(inv.id, lid))) return err(409, 'LINE_IN_DISPUTE', 'Bu satır gönderilmiş itirazda; önce itirazı geri çekin.');
    const s = patch ? patchSim(inv, patch).s : simulate(inv, basis, { lineIds });
    return HttpResponse.json(previewOf(inv, s));
  }),
  http.post('/api/deciship/invoices/:id/recalculate', async ({ request, params }) => {
    await delay(400);
    const inv = invoicesDb.find((x) => x.id === params.id);
    if (!inv) return err(404, 'NOT_FOUND', 'Fatura bulunamadı');
    const b = await json(request);
    const basis = b.basis as RecalcBasis;
    const lineIds = b.lineIds as string[] | undefined;
    if (lineIds && basis !== 'pinned') return err(400, 'VALIDATION', 'Seçili satırlar yalnız faturanın kendi tarifesi ve ayarıyla hesaplanır');
    if (basis !== 'pinned' && disputesMock.hasActive(inv.id)) return err(409, 'INVOICE_HAS_DISPUTE', 'Bu faturanın gönderilmiş itirazı var; önce itirazı geri çekin.');
    if (lineIds?.some((lid) => disputesMock.lineLocked(inv.id, lid))) return err(409, 'LINE_IN_DISPUTE', 'Bu satır gönderilmiş itirazda; önce itirazı geri çekin.');
    const s = simulate(inv, basis, { lineIds });
    if (b.token !== simToken(inv, s)) return err(409, 'PREVIEW_STALE', 'Önizleme eskidi; yeniden önizleyin.');
    writeSim(inv, s, basis);
    return HttpResponse.json({ invoice: { ...inv, basis: basisOf(inv), tariffsUsed: tariffsUsedOf(inv.id), dispute: disputesMock.invoiceDispute(inv.id), status: 'PROCESSED' } });
  }),
  http.patch('/api/deciship/invoices/:id', async ({ request, params }) => {
    const inv = invoicesDb.find((x) => x.id === params.id);
    if (!inv) return err(404, 'NOT_FOUND', 'Fatura bulunamadı');
    const b = await json(request);
    // Mesaj 4: gönderilmiş itirazda hesabı değiştiren alanlar kilitli
    const changes = (k: 'currency' | 'carrierId' | 'invoiceDate' | 'tariffId') =>
      k in b && b[k] !== (k === 'carrierId' ? inv.carrier.id : ((inv as unknown as Record<string, unknown>)[k] ?? null));
    const recalcFields = (['currency', 'carrierId', 'invoiceDate', 'tariffId'] as const).some(changes);
    if (recalcFields && disputesMock.hasActive(inv.id))
      return err(409, 'INVOICE_HAS_DISPUTE', 'Bu faturanın gönderilmiş itirazı var; taşıyıcı, tarih, tarife ya da para birimini değiştirmeden önce itirazı geri çekin.');
    // API ile aynı: hesabı değiştiren alan aynı değişikliğin önizleme token'ıyla gelir; tutmazsa 409 PREVIEW_STALE
    const sim = recalcFields ? patchSim(inv, b as MockPatch) : null;
    if (sim && !b.token) return err(400, 'VALIDATION', 'Önce neyin değişeceğine bakılır; önizlemeyi açıp onaylayın');
    if (sim && b.token !== simToken(inv, sim.s)) return err(409, 'PREVIEW_STALE', 'Önizlemeden sonra fatura değişti; yeni önizlemeye bakıp yeniden onaylayın');
    if (b.carrierId && b.carrierId !== inv.carrier.id) {
      const c = carriersDb.find((x) => x.id === b.carrierId)!;
      inv.carrier = { id: c.id, name: c.name, code: c.code };
      inv.tariffId = null;
    }
    if ('tariffId' in b) {
      const t = b.tariffId ? tariffsDb.find((x) => x.id === b.tariffId) : null;
      if (b.tariffId && !t) return err(404, 'NOT_FOUND', 'Tarife bulunamadı');
      if (t && t.carrierId !== inv.carrier.id) return err(400, 'TARIFF_CARRIER_MISMATCH', 'Seçilen tarife bu faturanın taşıyıcısına ait değil');
      inv.tariffId = t?.id ?? null;
    }
    for (const k of ['invoiceNo', 'invoiceDate', 'currency', 'periodFrom', 'periodTo'] as const) if (k in b) (inv as unknown as Record<string, unknown>)[k] = b[k];
    // sunucu gibi: tarife değişince yalnız tarife parçası bugünküne geçer (ayar kalır), değişmeyince sabit dayanakla
    if (sim) writeSim(inv, sim.s, sim.basis);
    applyInvoiceTariff(inv);
    return HttpResponse.json({ invoice: { ...inv, tariffsUsed: tariffsUsedOf(inv.id), status: 'PROCESSED', fileUrl: '#', fileName: 'fedex-9-482-11735.csv' } });
  }),
  http.get('/api/deciship/invoices/:id/lines', ({ params, request }) => {
    const url = new URL(request.url);
    const filter: BulkDecideFilter = {
      status: (url.searchParams.get('status') || undefined) as BulkDecideFilter['status'],
      diffType: (url.searchParams.get('diffType') || undefined) as BulkDecideFilter['diffType'],
      decision: url.searchParams.get('decision')?.split(',') as BulkDecideFilter['decision'],
      q: url.searchParams.get('q') || undefined,
      recalcPending: url.searchParams.get('recalcPending') === 'true',
      review: url.searchParams.get('review') === 'true',
      flagged: url.searchParams.get('flagged') === 'true',
    };
    const iid = String(params.id);
    const items = (linesDb.get(iid) ?? [])
      .filter((l) => lineMatches(l, filter))
      .map((l) => ({ ...l, dispute: disputesMock.lineDispute(iid, l.id) }));
    // API gibi: "tümünü seç" süzgecin bütün satırlarının özetini geri gönderir; 5.000'i aşan süzgeçte özet yok
    const all = items.length <= BULK_MAX;
    // 10-B14: toplu kararın değiştirebileceği satırlar (kutusu açık olanlar)
    const eligible = items.filter((l) => l.status === 'DIFF' && l.decision === 'OPEN' && !l.recalcPending && !disputesMock.lineLocked(iid, l.id)).length;
    return HttpResponse.json({ ...page(items, url), selectionDigest: all ? mockDigest(items) : null, selectionEligible: all ? eligible : null });
  }),
  http.patch('/api/deciship/invoice-lines/:id', async ({ request, params }) => {
    const b = await json(request);
    // API gibi (10-B16): "Uyumlu say" gerekçesiz olmaz
    if (b.decision === 'ACCEPTED' && !b.reason)
      return err(400, 'REASON_REQUIRED', 'Satırı uyumlu saymak için gerekçe yazılmalıdır', [{ path: 'reason', message: 'Zorunlu alan' }]);
    for (const [iid, lines] of linesDb) {
      const l = lines.find((x) => x.id === params.id);
      if (l) {
        // API gibi (10-B13): panelin gördüğü karar tutmazsa hiçbir alan yazılmaz
        if ('expectedDecision' in b && b.expectedDecision !== l.decision)
          return err(409, 'LINE_CHANGED', 'Bu satırın kararı siz bakarken değişti; güncel hâline bakıp yeniden karar verin.');
        // API gibi (Y126, 10-B16): talebi olmayan ya da "Fark var" olmayan satır itiraz listesine girmez (aynı istekte takip no /
        // eşleşme düzeltmesi yoksa)
        const recompare = 'trackingNo' in b || 'measurementId' in b;
        if (b.decision === 'VERIFIED' && l.decision !== 'VERIFIED' && !recompare && !(l.status === 'DIFF' && claimOf(l) > 0))
          return err(409, 'NO_CLAIM', 'Bu satırda talep edilecek tutar yok; itiraz listesine eklenemez');
        const changes = ('decision' in b && b.decision !== l.decision) || 'trackingNo' in b || 'measurementId' in b;
        if (changes && disputesMock.lineLocked(iid, l.id))
          return err(409, 'LINE_IN_DISPUTE', 'Bu satır gönderilmiş bir itiraz paketinde; değiştirmek için önce itirazı geri çekin.');
        const reopened = b.decision === 'OPEN' && l.decision !== 'OPEN' && !!l.recalcPending;
        if ('decision' in b) {
          // API gibi (`decisionFields`): karar anı yazılır, OPEN'da silinir
          if (b.decision !== l.decision) l.decidedAt = b.decision === 'OPEN' ? null : iso(new Date());
          l.decision = b.decision as InvoiceLine['decision'];
          l.decisionReason = (b.reason as string) ?? null;
        }
        const inv = invoicesDb.find((x) => x.id === iid)!;
        // API gibi: kararı geri alınan ve yeniden hesap bekleyen satır aynı istekte faturanın sabit dayanağıyla hesaplanır
        if (reopened) writeSim(inv, simulate(inv, 'pinned', { lineIds: [l.id] }), 'pinned');
        inv.totals = totalsOf(lines);
        return HttpResponse.json({ line: { ...l, dispute: disputesMock.lineDispute(iid, l.id) }, totals: inv.totals });
      }
    }
    return err(404, 'NOT_FOUND', 'Satır bulunamadı');
  }),
  http.post('/api/deciship/invoices/:id/recompare', ({ params }) => {
    const inv = invoicesDb.find((x) => x.id === params.id);
    return HttpResponse.json({ invoice: inv, pendingLines: (linesDb.get(String(params.id)) ?? []).filter((l) => l.recalcPending).length });
  }),
  http.delete('/api/deciship/invoices/:id', ({ params }) => {
    if (disputesMock.hasActive(String(params.id))) return err(409, 'INVOICE_HAS_DISPUTE', 'Bu faturanın gönderilmiş itirazı var; silmeden önce itirazı geri çekin.');
    invoicesDb.splice(invoicesDb.findIndex((x) => x.id === params.id), 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/deciship/invoices/:id/dispute', ({ params, request }) => {
    // API gibi (10-B2, B3): metin gönderme ile aynı kümeden (geri alınmış satır yok) ve kümenin özetiyle
    const lines = disputesMock.draftLines(String(params.id));
    if (!lines.length) return err(400, 'NO_VERIFIED_LINES', 'İtiraz listesinde satır yok');
    const en = new URL(request.url).searchParams.get('lang') === 'en';
    const total = sumMoney(lines.map(claimOf));
    return HttpResponse.json({
      subject: en ? 'Billing dispute – invoice 9-482-11735' : 'Fatura itirazı – 9-482-11735',
      body: lines.map((l) => `${l.trackingNo}: ${claimOf(l)} TRY`).join('\n'),
      lineCount: lines.length,
      total,
      photoCount: 3,
      linesWithoutPhoto: 0,
      selectionDigest: selectionDigestOf(lines),
    });
  }),
  http.get('/api/deciship/invoices/:id/dispute/evidence.zip', () =>
    new HttpResponse(new Blob(['PK'], { type: 'application/zip' }), { headers: { 'Content-Type': 'application/zip' } }),
  ),
  http.post('/api/deciship/invoices/preview', async ({ request }) => {
    const fd = await request.formData();
    const f = fd.get('file') as File;
    // Test kancası: `sod_mock_preview_delay` = {"<carrierId>": ms}. Açıksa okuma o kadar bekler ve fatura no `MOCK-<carrierId>` olur (hangi okumanın kazandığı görünsün).
    let hookedNo: string | null = null;
    try {
      const delays = JSON.parse(localStorage.getItem('sod_mock_preview_delay') ?? 'null') as Record<string, number> | null;
      const cid = String(fd.get('carrierId') ?? '');
      if (delays && cid in delays) {
        hookedNo = `MOCK-${cid}`;
        await delay(Number(delays[cid]) || 0);
      }
    } catch {
      /* kanca bozuksa yok sayılır */
    }
    if (/fedex-9-482-11735/i.test(f.name)) {
      sampleCsv = readCsv(await f.text());
      const suggestedMapping = {
        trackingNo: 'Tracking ID',
        shipDate: 'Shipment Date',
        service: 'Service Type',
        destCountry: 'Recipient Country/Territory',
        actualKg: 'Actual Weight',
        billedKg: 'Rated Weight',
        dimL: 'Dim Length',
        dimW: 'Dim Width',
        dimH: 'Dim Height',
        netAmount: 'Net Charge Amount',
        fuelAmount: 'Fuel Surcharge',
        surchargeColumns: [],
        amountsIncludeVat: false,
        vatPct: 20,
        desiAsWeight: false,
      };
      // Test kancası: `sod_mock_ambiguous_dates` bütün tarihleri iki türlü okunur yapar; okuma kontrolü gerçek çekirdekten gelir.
      const ambiguous = localStorage.getItem('sod_mock_ambiguous_dates') === '1';
      if (ambiguous) {
        const i = sampleCsv.headers.indexOf('Shipment Date');
        for (const r of sampleCsv.rows) r[i] = '10/05/2026';
      }
      const ambiguousParts = ambiguous
        ? {
            suggestedMapping: { ...suggestedMapping, invoiceDate: 'Shipment Date' },
            diagnostics: mappingDiagnostics(sampleCsv, { ...suggestedMapping, invoiceDate: 'Shipment Date' } as CoreColumnMapping),
            guessedMeta: { invoiceNo: hookedNo ?? '9-482-11735', invoiceDate: '2026-05-10', ...guessedCurrency() },
          }
        : {};
      return HttpResponse.json({
        fileId: 'sample',
        format: 'csv',
        headers: sampleCsv.headers,
        sampleRows: sampleCsv.rows.slice(0, 10),
        rowCount: sampleCsv.rows.length,
        columnFill: sampleCsv.headers.map(() => sampleCsv!.rows.length),
        suggestedMapping,
        mappingSource: 'preset',
        confidence: 0.98,
        missing: [],
        guessedMeta: withoutMissingDate({ invoiceNo: hookedNo ?? '9-482-11735', invoiceDate: '2026-10-27', ...guessedCurrency() }),
        ...ambiguousParts,
        overlap: mockOverlap(),
      });
    }
    if (f.name.toLowerCase().endsWith('.pdf')) {
      // Test kancası: `sod_mock_ai_quota` açıksa API gibi iş açılmadan 429 (sayfa açılırken alınan `me` bunu henüz bilmez).
      if (localStorage.getItem('sod_mock_ai_quota') && new URL(request.url).searchParams.has('async'))
        return err(429, 'AI_QUOTA_EXCEEDED', 'Bu ayki yapay zekâ hakkınız doldu.');
      const pdfBody = {
        // Her okuma yeni önizleme dosyası (API gibi): "Yeniden oku"da eski dosyanın ne zaman silindiği görünsün.
        fileId: `f${++pdfPreviewNo}`,
        format: 'pdf',
        aiLines: [mkLine(0, 'x'), mkLine(1, 'x')].map((l) => ({ rowIndex: l.rowIndex, trackingNo: l.trackingNo, destCountry: l.destCountry, actualKg: l.actualKg, billedKg: l.billedKg, dims: { l: 40, w: 30, h: 25 }, netAmount: l.netAmount, surcharges: [], rawHash: `h${l.rowIndex}` })),
        guessedMeta: { invoiceNo: '9-482-99999', invoiceDate: '2026-10-28', currency: String(company.settings.currency ?? 'TRY') },
        warning: 'Yapay zekâ ile okundu, kontrol edin',
        // 2. satırın ağırlığı PDF metninde yok (05-B4): panelde kg hücreleri işaretlenir.
        pdfCheck: { method: 'text', checked: 2, unverified: 1, rows: [{ rowIndex: 1, codes: ['PDF_WEIGHT_UNVERIFIED'] }] },
        aiSkipped: { count: 1, amount: 45 },
      };
      // PDF okuma yalnız arka plan işidir (202); `async` yoksa API gibi 400 ASYNC_REQUIRED (Y83).
      if (!new URL(request.url).searchParams.has('async')) return asyncRequired();
      return HttpResponse.json(startMockJob('INVOICE_PDF_READ', { type: 'File', id: pdfBody.fileId }, 'pdfRead', pdfBody), { status: 202 });
    }
    const headers = ['Tracking ID', 'Shipment Date', 'Service Type', 'Recipient Country', 'Actual Weight', 'Rated Weight', 'Dim Length', 'Dim Width', 'Dim Height', 'Net Charge Amount', 'Fuel Surcharge', 'Residential'];
    return HttpResponse.json({
      fileId: 'f2',
      format: 'csv',
      headers,
      sampleRows: measDb.slice(0, 10).map((m) => [m.trackingNo, '22.10.2026', 'IE', 'FR', '4,0', '6,0', String(m.lengthCm), String(m.widthCm), String(m.heightCm), '1.184,00', '236,80', '']),
      rowCount: 18,
      columnFill: headers.map((h) => (h === 'Residential' ? 2 : 18)),
      // Test kancası: dosyadaki gönderilerin çoğu başka faturada ('1' tek fatura, '2' iki faturaya yayılmış).
      overlap: mockOverlap(),
      suggestedMapping: {
        trackingNo: 'Tracking ID',
        shipDate: 'Shipment Date',
        service: 'Service Type',
        destCountry: 'Recipient Country',
        actualKg: 'Actual Weight',
        billedKg: 'Rated Weight',
        dimL: 'Dim Length',
        dimW: 'Dim Width',
        dimH: 'Dim Height',
        fuelAmount: 'Fuel Surcharge',
        surchargeColumns: [{ header: 'Residential', code: 'RES' }],
        amountsIncludeVat: false,
        vatPct: 20,
        desiAsWeight: false,
      },
      mappingSource: 'preset',
      confidence: 0.86,
      missing: ['netAmount'],
      guessedMeta: { invoiceNo: '9-482-11801', invoiceDate: '2026-10-28', currency: String(company.settings.currency ?? 'TRY') },
    });
  }),
  http.post('/api/deciship/invoices/preview/verify', async ({ request }) => {
    // Test kancası: `sod_mock_verify_fail` kadar istek düşer (ağ hatası), sonrakiler çalışır.
    const failLeft = Number(localStorage.getItem('sod_mock_verify_fail') ?? 0);
    if (failLeft > 0) {
      localStorage.setItem('sod_mock_verify_fail', String(failLeft - 1));
      return err(503, 'UNAVAILABLE', 'Hizmet geçici olarak kullanılamıyor');
    }
    if (localStorage.getItem('sod_mock_ambiguous_dates') !== '1' || !sampleCsv) return passthrough();
    const mapping = (await json(request)).mapping as CoreColumnMapping;
    await delay(Number(localStorage.getItem('sod_mock_verify_delay') ?? 0));
    return HttpResponse.json({ diagnostics: mappingDiagnostics(sampleCsv, mapping), suggestAi: false, guessedMeta: guessInvoiceMeta(sampleCsv, mapping) });
  }),
  // Yapay zekâ ile eşleme (örnek CSV): gönderilen eşlemeyi alır, net tutarı ekler, bayrakları kendi kararıyla yazar (API gibi).
  // Test kancası: `sod_mock_ai_hold` duruyorsa yanıt o kaldırılana kadar bekler (beklerken ekranda ne yapılabildiği sınansın).
  http.post('/api/deciship/invoices/preview/ai-mapping', async ({ request }) => {
    if (!sampleCsv) return passthrough();
    const b = await json(request);
    while (localStorage.getItem('sod_mock_ai_hold')) await delay(50);
    const mapping = {
      ...(b.mapping as CoreColumnMapping),
      netAmount: 'Net Charge Amount',
      amountsIncludeVat: false,
      vatPct: 20,
      desiAsWeight: false,
    } as CoreColumnMapping;
    return HttpResponse.json({
      mapping,
      fieldSources: { ...((b.sources as Record<string, string> | undefined) ?? {}), netAmount: 'ai' },
      aiConfidence: { netAmount: { header: 'Net Charge Amount', confidence: 0.95, reason: 'Satır başı net ücret' } },
      decisions: { netAmount: 'ai' },
      dropped: [],
      diagnostics: mappingDiagnostics(sampleCsv, mapping),
      suggestAi: false,
      guessedMeta: guessInvoiceMeta(sampleCsv, mapping),
      overlap: null,
      usage: null,
    });
  }),
  http.post('/api/deciship/invoices', async ({ request }) => {
    const b = await json(request);
    // Test kancası: `sod_mock_invoice_delay` kur indirmesi süren karşılaştırmayı taklit eder (ms).
    await delay(Number(localStorage.getItem('sod_mock_invoice_delay') ?? 0));
    if (invoicesDb.some((i) => i.invoiceNo === b.invoiceNo)) return err(409, 'INVOICE_EXISTS', 'Bu fatura zaten yüklenmiş');
    const c = carriersDb.find((x) => x.id === b.carrierId)!;
    const csv = b.fileId === 'sample' ? sampleCsv : null;
    const iid = addInvoice(String(b.invoiceNo), c, String(b.invoiceDate), 12, undefined, csv ? (x) => sampleLines(x, csv) : undefined);
    const inv = invoicesDb.find((x) => x.id === iid)!;
    inv.tariffId = (b.tariffId as string | null) ?? null;
    applyInvoiceTariff(inv);
    return HttpResponse.json({ invoice: invoicesDb.find((x) => x.id === iid) }, { status: 201 });
  }),
  http.get('/api/deciship/invoices/:id/report.xlsx', ({ params }) => reportFile(String(params.id), 'xlsx')),
  http.get('/api/deciship/invoices/:id/report.pdf', ({ params }) => reportFile(String(params.id), 'pdf')),
  http.get('/api/deciship/invoices/:id/tariff-health', ({ params }) =>
    HttpResponse.json({
      health: {
        invoiceId: String(params.id),
        carrierName: 'FedEx',
        tariff: tariffsDb[0] ? { id: tariffsDb[0].id, name: tariffsDb[0].name, currency: tariffsDb[0].currency, countryAdjustments: [], revisionId: revOf(tariffsDb[0].id).id, removed: false } : null,
        // API gibi: faturadaki yakıt oranı ve notu (bulunamadıysa null)
        invoiceFuelPct: null,
        fuelNote: null,
        stale: false,
        checkedLines: 9,
        okLines: 9,
        skippedLines: 0,
        okTolerancePct: 2,
        // test kancası: tarifeden çok düşük fiyat
        groups: localStorage.getItem('sod_mock_health_suspect')
          ? [{ key: 'FR', status: 'cheaper', suspect: true, weak: false, country: 'FR', countryName: 'Fransa', service: 'IE', serviceMismatch: false, zone: 'A', currentAdjustmentPct: 0, lines: 4, medianDeviationPct: -38, minDeviationPct: -39.5, maxDeviationPct: -38, suggestedAdjustmentPct: null, message: 'Fransa (4 satır): FedEx tarifenizden %38 düşük fiyat uyguluyor' }]
          : [],
        overallNote: null,
        overallMedianPct: 0,
      },
    }),
  ),
  http.get('/api/deciship/reference-card.pdf', () => new HttpResponse('mock', { headers: { 'Content-Type': 'application/pdf' } })),
  // belge önyükleme ve varlıklar: mock'lanmaz, uyarı da üretmez
  http.all('*', () => passthrough()),
];

export async function startMocks() {
  const worker = setupWorker(...handlers);
  loadDb();
  await worker.start({ quiet: true, serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js`, options: { scope: import.meta.env.BASE_URL } } });
}
