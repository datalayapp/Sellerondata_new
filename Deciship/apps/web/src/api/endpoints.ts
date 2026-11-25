import { asItems, download, request, unwrap } from './client';
import { withLineIds } from './lineIds';
import type {
  CountryAdjustment,
  CountryAdjustmentResult,
  TariffHealth,
  BoxPreset,
  Carrier,
  CarrierCode,
  Company,
  CompanySettings,
  Dashboard,
  Decision,
  DisputeListResponse,
  DisputeListStatus,
  DisputeResultBody,
  DisputeSendBody,
  DisputeText,
  InvoiceDispute,
  Invoice,
  InvoiceCreateBody,
  InvoiceCreateResult,
  InvoiceCreateStart,
  AiMappingResult,
  ColumnMapping,
  FieldSources,
  MappingVerifyResult,
  InvoiceLine,
  InvoiceLinePatch,
  InvoiceLinePatchResult,
  InvoicePatch,
  InvoiceListItem,
  InvoicePreview,
  MeasurementCreateData,
  MeasurementDetail,
  MeasurementListItem,
  MeasurementPatch,
  MeResponse,
  OnboardingPatch,
  OnboardingStatus,
  Page,
  LinePage,
  QuoteResult,
  Tariff,
  TariffBody,
  AiTariffReview,
  ImportMeta,
  ImportOptions,
  TariffImportDraft,
  TariffImportApplyResult,
  TariffImportUpload,
  PdfExtractBody,
  PdfScanMode,
  TariffPdfScan,
  TariffReplaceResult,
  TariffSaveResult,
  TariffVersion,
  TariffSummary,
  MemberSummary,
  BulkDecideBody,
  BulkDecideResult,
  DemoEndResult,
  DemoStartResult,
  InvoiceListParams,
  InvoiceRecalcPreview,
  InvoiceRecompareResult,
  RecalcBasis,
  RecalcPatch,
  InvoicePreviewStart,
  ResumablePreview,
  JobListQuery,
  JobStarted,
  JobView,
  PackagingLimits,
} from './types';
import { isJobStarted } from '../lib/jobs';

// ---- Mesaj 7: arka plan işleri ----
export const jobs = {
  get: (id: string) => request<JobView>(`/jobs/${id}`),
  list: async (q: JobListQuery) =>
    asItems(
      await request<{ items: JobView[] } | JobView[]>('/jobs', {
        query: { active: q.active ? 1 : undefined, kind: q.kind, refType: q.refType, refId: q.refId, mine: q.mine ? 1 : undefined },
      }),
    ),
  /** 409 JOB_FINISHED (iş zaten bitti) ya da JOB_NOT_CANCELLABLE; çağıran yoklamayla gerçek durumu görür. */
  cancel: (id: string) => request<JobView>(`/jobs/${id}/cancel`, { method: 'POST', body: {} }),
};

// ---- 5.1 auth ----
// Giriş, kayıt, çıkış ve kullanıcı yönetimi Merkez'dedir (`/api/account`). Burada yalnız firmanın DeciShip tarafı okunur.
export const auth = {
  me: () => request<MeResponse>('/me'),
};

/** Ölçüm süzgeci için kişi adları. Yönetim Merkez'de; bu liste salt okunurdur. */
export const members = {
  list: async () => asItems(await request<MemberSummary[] | { items: MemberSummary[] }>('/members')),
};

// ---- 5.3 settings & presets ----
export interface SettingsView extends CompanySettings {
  name: string;
  /** Sunucuda ENABLE_DATA_RESET açıksa true. Yoksa "Veriler" kartı görünmez (ARCHITECTURE §11). */
  dataResetEnabled?: boolean;
}

function normalizeSettings(r: unknown): SettingsView {
  const o = (r ?? {}) as Record<string, unknown>;
  const company = (o.company ?? null) as Company | null;
  const settings = (o.settings ?? company?.settings ?? o) as CompanySettings;
  const name = (o.name as string | undefined) ?? company?.name ?? (settings as unknown as { name?: string }).name ?? '';
  return { ...settings, name };
}

export const settings = {
  get: async () => normalizeSettings(await request<unknown>('/settings')),
  update: async (b: Partial<Omit<SettingsView, 'name' | 'dataResetEnabled'>>) =>
    normalizeSettings(await request<unknown>('/settings', { method: 'PATCH', body: b })),
  /** GEÇİCİ (deneme dönemi): verileri sil; `samples` ise ardından örnek verileri yükle. */
  resetData: (samples: boolean) =>
    request<{
      removed: { invoices: number; measurements: number; carriers: number };
      loaded: { carriers: number; tariffs: number; measurements: number } | null;
    }>('/settings/data/reset', { method: 'POST', body: { confirm: true, samples } }),
  /**
   * Mesaj 4: eski ayarla hesaplı faturalar bugünkü ayara geçerse ne değişir (yazmaz). Etkin itirazı olanlar atlanır.
   * Mesaj 7, Y83: yalnız arka plan işi (202 `{ job, joined }`); sonuç `job.result` = BulkRecalcPreview.
   */
  recompareInvoicesPreviewAsync: () => request<JobStarted>('/settings/recompare-invoices/preview', { method: 'POST', body: {}, query: { async: 1 } }),
  /**
   * Önizlemedeki faturaları bugünkü ayara geçirir; iş olarak başlar, sonuç `job.result` = BulkRecalcResult. Bayat önizleme
   * işte `PREVIEW_STALE`. 409 JOB_ACTIVE (`details.job`): başka onayla süren iş var.
   */
  recompareInvoicesAsync: (token: string) => request<JobStarted>('/settings/recompare-invoices', { method: 'POST', body: { token }, query: { async: 1 } }),
};

/**
 * Mesaj 14 §4.3: örnek veriyle deneme turu. 404: sunucuda kapalı (`DEMO_TOUR=off`).
 * `start`: 409 DEMO_NOT_EMPTY | DEMO_ACTIVE. `end`: 409 DEMO_NOT_ACTIVE. Deneme açıkken fatura, taşıyıcı ve tarife ekleme 409 DEMO_ACTIVE.
 */
export const demo = {
  start: () => request<DemoStartResult>('/settings/demo', { method: 'POST', body: {} }),
  end: () => request<DemoEndResult>('/settings/demo', { method: 'DELETE' }),
};

/** İlk kurulum sihirbazı: ilerleme + kontrol listesi (yalnız yönetici). */
export const onboarding = {
  get: () => request<OnboardingStatus>('/settings/onboarding'),
  update: (b: OnboardingPatch) => request<OnboardingStatus>('/settings/onboarding', { method: 'PATCH', body: b }),
};

type BoxPresetInput = Omit<BoxPreset, 'id' | 'active'> & { active?: boolean };
export const boxPresets = {
  list: async () =>
    asItems(await request<BoxPreset[] | { items: BoxPreset[] }>('/box-presets')).sort((a, b) => a.sortOrder - b.sortOrder),
  create: (b: BoxPresetInput) => request<unknown>('/box-presets', { body: b }).then((r) => unwrap<BoxPreset>(r, 'preset')),
  update: (id: string, b: Partial<BoxPresetInput>) =>
    request<unknown>(`/box-presets/${id}`, { method: 'PATCH', body: b }).then((r) => unwrap<BoxPreset>(r, 'preset')),
  remove: (id: string) => request<void>(`/box-presets/${id}`, { method: 'DELETE' }),
};

// ---- 5.4 measurements ----
interface MeasurementQuery {
  q?: string;
  from?: string;
  to?: string;
  userId?: string;
  method?: string;
  page?: number;
  pageSize?: number;
  /** deciship.measurements.manage: list soft-deleted measurements (SPEC §10.1) */
  deleted?: boolean;
}

export const measurements = {
  list: (q: MeasurementQuery) => request<Page<MeasurementListItem>>('/measurements', { query: { ...q } }),
  get: (id: string) => request<unknown>(`/measurements/${id}`).then((r) => unwrap<MeasurementDetail>(r, 'measurement')),
  create: (data: MeasurementCreateData, photos: File[]) => {
    const fd = new FormData();
    fd.append('data', JSON.stringify(data));
    photos.forEach((p) => fd.append('photos', p, p.name));
    return request<unknown>('/measurements', { body: fd }).then((r) => unwrap<MeasurementDetail>(r, 'measurement'));
  },
  /** Returns the NEW version (new id). With photos the body goes as multipart (`data` + `photos`). */
  update: (id: string, b: MeasurementPatch, photos: File[] = []) => {
    let body: MeasurementPatch | FormData = b;
    if (photos.length) {
      const fd = new FormData();
      fd.append('data', JSON.stringify(b));
      photos.forEach((p) => fd.append('photos', p, p.name));
      body = fd;
    }
    return request<unknown>(`/measurements/${id}`, { method: 'PATCH', body }).then((r) => unwrap<MeasurementDetail>(r, 'measurement'));
  },
  remove: (id: string) => request<void>(`/measurements/${id}`, { method: 'DELETE' }),
  /** 409 NEWER_EXISTS when a newer live version of the same tracking no exists */
  restore: (id: string) =>
    request<unknown>(`/measurements/${id}/restore`, { method: 'POST' }).then((r) => unwrap<MeasurementDetail>(r, 'measurement')),
  /** Kalıcı silme (yalnız silinmiş son sürüm; bütün sürümler ve fotoğraflar). 409 MEASUREMENT_PROTECTED `details.reason`, NOT_DELETED. */
  purge: (id: string) =>
    request<{ purged: { id: string; trackingNo: string; versions: number; photos: number } }>(`/measurements/${id}/purge`, { method: 'POST' }),
};

// ---- 5.7 carriers & tariffs ----
export const carriers = {
  list: async () => asItems(await request<Carrier[] | { items: Carrier[] }>('/carriers')),
  create: (b: { code: CarrierCode; name: string }) => request<unknown>('/carriers', { body: b }).then((r) => unwrap<Carrier>(r, 'carrier')),
  /** `packagingLimits`: poşet / zarf sınırı ayarı; null = taşıyıcı kodunun varsayılanı (ayar silinir). */
  update: (id: string, b: { name?: string; active?: boolean; code?: CarrierCode; packagingLimits?: PackagingLimits | null }) =>
    request<unknown>(`/carriers/${id}`, { method: 'PATCH', body: b }).then((r) => unwrap<Carrier>(r, 'carrier')),
  remove: (id: string) => request<void>(`/carriers/${id}`, { method: 'DELETE' }),
};

export const tariffs = {
  list: async (carrierId?: string) =>
    asItems(await request<TariffSummary[] | { items: TariffSummary[] }>('/tariffs', { query: { carrierId } })),
  get: (id: string) => request<unknown>(`/tariffs/${id}`).then((r) => unwrap<Tariff>(r, 'tariff')),
  /** Silme onayı için: bu tarifenin sürümleriyle hesaplı fatura sayısı (`pinnedInvoices`); tarife kendisi `get` ile okunur. */
  pinnedInvoices: (id: string) => request<{ pinnedInvoices?: number }>(`/tariffs/${id}`).then((r) => r.pinnedInvoices ?? null),
  create: (b: TariffBody) => request<unknown>('/tariffs', { body: b }).then((r) => unwrap<Tariff>(r, 'tariff')),
  /**
   * `expectedUpdatedAt`: taslağın dayandığı `Tariff.updatedAt`. Tarife bu arada başka yerde değiştiyse 409 STALE
   * (`details.updatedAt` = sunucudaki an); verilmezse son kaydeden kazanır (eski istemci).
   */
  replace: (id: string, b: TariffBody, expectedUpdatedAt?: string) =>
    request<TariffSaveResult>(`/tariffs/${id}`, { method: 'PUT', body: expectedUpdatedAt ? { ...b, expectedUpdatedAt } : b }),
  remove: (id: string) => request<void>(`/tariffs/${id}`, { method: 'DELETE' }),
  /** Tek tıkla varsayılan: yeni faturalarda önseçili gelir (taşıyıcının diğer tarifelerinden işaret kalkar). */
  setDefault: (id: string) => request<unknown>(`/tariffs/${id}/default`, { method: 'POST' }).then((r) => unwrap<Tariff>(r, 'tariff')),
  duplicate: (id: string) => request<unknown>(`/tariffs/${id}/duplicate`, { method: 'POST' }).then((r) => unwrap<Tariff>(r, 'tariff')),
  downloadTemplate: () => download('/tariffs/template.xlsx', 'tarife-sablonu.xlsx'),
  /**
   * Dosyayı okur ve kontrol eder; tarifeyi değiştirmez (400 INVALID_FILE).
   * .xlsx/.csv → taslak; .pdf → yalnız belge kaydı (kind:'pdf', hızlı; tarama ayrı bir tuşla yapılır).
   */
  importDraft: (id: string, file: File, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request<TariffImportUpload>(`/tariffs/${id}/import`, { body: fd, signal });
  },
  versions: async (id: string) => asItems(await request<TariffVersion[] | { items: TariffVersion[] }>(`/tariffs/${id}/versions`)),
  restoreVersion: (id: string, versionId: string) =>
    request<TariffReplaceResult>(`/tariffs/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  /**
   * Mesaj 4: bu tarifeyle hesaplı faturalar tarifenin bugünkü haline geçerse ne değişir (yazmaz). Mesaj 7, Y83: yalnız
   * arka plan işi (202 `{ job, joined }`); sonuç `job.result` = BulkRecalcPreview.
   */
  recompareInvoicesPreviewAsync: (id: string) =>
    request<JobStarted>(`/tariffs/${id}/recompare-invoices/preview`, { method: 'POST', body: {}, query: { async: 1 } }),
  /** Önizlemenin `token`'ı zorunlu; sonuç `job.result` = BulkRecalcResult, bayat önizleme işte PREVIEW_STALE. Etkin itirazı olan faturalar atlanır. */
  recompareInvoicesAsync: (id: string, token: string) =>
    request<JobStarted>(`/tariffs/${id}/recompare-invoices`, { method: 'POST', body: { token }, query: { async: 1 } }),
  quote: (id: string, b: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number; destCountry?: string }) =>
    request<QuoteResult>(`/tariffs/${id}/quote`, { body: b }),
  /** SPEC §3.9: ülke istisnası ekle/güncelle (pct 0 → kaldır). Mesaj 4: fatura kendiliğinden yeniden hesaplanmaz; web önizleme açar. */
  setCountryAdjustment: (id: string, b: CountryAdjustment) =>
    request<CountryAdjustmentResult>(`/tariffs/${id}/country-adjustments`, { body: b }),
};

export const tariffImports = {
  /** Yeni tarife için dosya okur (tarife henüz yok): .xlsx/.csv → taslak, .pdf → belge kaydı. */
  createDraft: (carrierId: string, file: File, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append('carrierId', carrierId);
    fd.append('file', file, file.name);
    return request<TariffImportUpload>('/tariff-imports', { body: fd, signal });
  },
  recheck: (draftId: string, options: ImportOptions) => request<TariffImportDraft>(`/tariff-imports/${draftId}/recheck`, { body: { options } }),
  /**
   * Yalnız istenince çalışır; KALANLAR 6.18: arka plan işi (202 `{ job, joined }`, sonuç `job.result`; 10–40 sn). 503
   * AI_DISABLED başlatırken, AI_BUSY / AI_FAILED işin hatası olarak gelir. Eski sunucunun 200 yanıtı `{ review }`.
   */
  review: async (draftId: string, options: ImportOptions, signal?: AbortSignal): Promise<JobStarted | { review: AiTariffReview }> => {
    const r = await request<AiTariffReview | JobStarted>(`/tariff-imports/${draftId}/review`, { body: { options }, signal, query: { async: 1 } });
    return isJobStarted(r) ? r : { review: r };
  },
  /** 422 IMPORT_BLOCKED (details.checks) | 409 ACK_REQUIRED */
  apply: (draftId: string, options: ImportOptions, acknowledged: boolean, meta?: ImportMeta) =>
    request<TariffImportApplyResult>(`/tariff-imports/${draftId}/apply`, { body: { options, acknowledged, ...(meta ? { meta } : {}) } }),
};

export const tariffDocuments = {
  /** Kodla tarama: yapay zekâsız, birkaç saniye, eşzamanlı. Yapay zekâ taraması yalnız `scanAsync` ile (Y83). */
  scan: (documentId: string, mode: Extract<PdfScanMode, 'code'>, signal?: AbortSignal) =>
    request<TariffPdfScan>(`/tariff-documents/${documentId}/scan`, { body: { mode }, signal }),
  /** Mesaj 7: yapay zekâ taraması iş olarak başlar (202 `{ job, joined }`); sonuç `job.result` (TariffPdfScan). */
  scanAsync: (documentId: string, signal?: AbortSignal) =>
    request<JobStarted>(`/tariff-documents/${documentId}/scan`, { body: { mode: 'ai' satisfies PdfScanMode }, query: { async: 1 }, signal }),
  /**
   * Seçilen tabloları çıkarır → taslak (kind:'pdf'). Mesaj 7, Y83: yalnız iş olarak (202 `{ job, joined }`); sonuç
   * `job.result` (TariffImportDraft).
   */
  extractAsync: (documentId: string, b: PdfExtractBody, signal?: AbortSignal) =>
    request<JobStarted>(`/tariff-documents/${documentId}/extract`, { body: b, query: { async: 1 }, signal }),
};

// ---- 5.8 invoices ----
interface LineQuery {
  status?: string;
  diffType?: string;
  decision?: string;
  q?: string;
  /** SPEC §11.5: yalnız "Kontrol edilecek" satırlar */
  flagged?: boolean;
  /** Mesaj 4: yalnız yeniden hesap bekleyen (donmuş, `recalcPending` dolu) satırlar (varsayım: sorgu adı `recalcPending=true`) */
  recalcPending?: boolean;
  /** Mesaj 5 (Y2): yalnız "İncele" (güveni düşük) satırlar; fark çıkan da uyumlu çıkan da */
  review?: boolean;
  page?: number;
  pageSize?: number;
}

export const invoices = {
  /** SPEC §11.1: eşleme değişince okuma kontrolü */
  verifyMapping: (b: { fileId: string; carrierId: string; mapping: ColumnMapping }) => request<MappingVerifyResult>('/invoices/preview/verify', { body: b }),
  /** SPEC §11.2: yapay zekâ ile eşle (10–30 sn). `signal`: taşıyıcı ya da dosya değişince, sayfadan çıkınca iptal. */
  aiMapping: (b: { fileId: string; carrierId: string; mapping?: ColumnMapping; sources?: FieldSources }, signal?: AbortSignal) =>
    request<AiMappingResult>('/invoices/preview/ai-mapping', { body: b, signal }),
  /**
   * Mesaj 7: PDF 202 `{ job, joined }` döner (sonuç `job.result` = bugünkü PDF önizleme yanıtı); CSV/XLSX'te aynı uç
   * 200 ve bugünkü yanıtı verir. 429 AI_QUOTA_EXCEEDED | TOO_MANY_REQUESTS başlatırken gelir. Y83: PDF `async` olmadan
   * 400 ASYNC_REQUIRED (eşzamanlı yol yok). `fresh` (Y62-E3 "Yeniden oku"): PDF'in önceki okuması kullanılmaz, yeniden
   * okunur ve ücretlenir (`?fresh=1`).
   */
  previewAsync: async (file: File, carrierId: string, signal?: AbortSignal, fresh = false): Promise<InvoicePreviewStart> => {
    const fd = new FormData();
    fd.append('carrierId', carrierId);
    fd.append('file', file, file.name);
    const r = await request<InvoicePreview | JobStarted>('/invoices/preview', { body: fd, signal, query: { async: 1, ...(fresh ? { fresh: 1 } : {}) } });
    return isJobStarted(r) ? r : { preview: r };
  },
  /** Vazgeçilen önizlemenin dosyasını siler. Yanıt (204 ya da 404) önemsizdir; hata yutulur, sayfadan çıkarken de gider. */
  discardPreview: async (fileId: string): Promise<void> => {
    try {
      await request<void>(`/invoices/preview/${encodeURIComponent(fileId)}`, { method: 'DELETE', keepalive: true });
    } catch {
      /* temizlik en iyi çabadır: sunucu 24 saat sonra kendisi siler */
    }
  },
  /** Y80-E2: kişinin okunmuş ya da okunmakta olan, içe aktarılmamış PDF önizlemeleri (sürdürme bandı). */
  resumable: async () => asItems(await request<{ items: ResumablePreview[] } | ResumablePreview[]>('/invoices/preview/resumable')),
  /** Y95: açık önizlemede çalışılıyor; sunucunun 24 saatlik temizliği saymaya yeniden başlasın. Hata yutulur (404: dosya artık yok). */
  keepPreview: async (fileId: string): Promise<boolean> => {
    try {
      await request<void>(`/invoices/preview/${encodeURIComponent(fileId)}/keep`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  },
  /** Y80-E3: kurulum örnek faturası, arka planda okunmuş PDF önizlemesinden (`previewAsync` işinin `result.fileId`). */
  sampleFromPreview: (fileId: string, carrierId: string) =>
    request<{ invoice: InvoiceListItem; lines: number }>('/invoices/samples', { body: { fileId, carrierId } }),
  /**
   * KALANLAR 6.18: büyük CSV/Excel 202 `{ job, joined }` döner (sonuç `job.result` aynı gövde; `lib/waitJob.ts` ile
   * beklenir), küçük dosya ve PDF 201. Büyük dosyada `async` olmadan 400 ASYNC_REQUIRED.
   */
  create: (b: InvoiceCreateBody) =>
    request<unknown>('/invoices', { body: b, query: { async: 1 } }).then((r): InvoiceCreateStart =>
      isJobStarted(r) ? r : r && typeof r === 'object' && 'invoice' in r ? (r as InvoiceCreateResult) : { invoice: r as Invoice, errors: [] },
    ),
  /** Kurulum: örnek fatura tek adımda (eşleme yok); faturalar listesinde görünmez. PDF 10–30 sn sürebilir. */
  uploadSample: (file: File, carrierId: string) => {
    const fd = new FormData();
    fd.append('carrierId', carrierId);
    fd.append('file', file, file.name);
    return request<{ invoice: InvoiceListItem; lines: number }>('/invoices/samples', { body: fd });
  },
  /** Mesaj 14: `q` (fatura no ya da takip no) ve `status` (DIFF | UNMATCHED | TO_DISPUTE) ile süzülür. */
  list: (q: InvoiceListParams) => request<Page<InvoiceListItem>>('/invoices', { query: { ...q } }),
  get: (id: string) => request<unknown>(`/invoices/${id}`).then((r) => unwrap<Invoice>(r, 'invoice')),
  /**
   * 409 INVOICE_EXISTS: numara aynı taşıyıcıda kullanılıyor. Taşıyıcı / tarife / tarih / para birimi değişiyorsa `token`
   * (aynı değişikliğin önizlemesi) zorunlu; bayatsa 409 PREVIEW_STALE, itiraz varsa 409 INVOICE_HAS_DISPUTE.
   */
  update: (id: string, b: InvoicePatch) =>
    request<unknown>(`/invoices/${id}`, { method: 'PATCH', body: b }).then((r) => unwrap<Invoice>(r, 'invoice')),
  lines: (id: string, q: LineQuery) => request<LinePage>(`/invoices/${id}/lines`, { query: { ...q } }),
  /** 10-B13: `expectedDecision` panelin gördüğü karar; bu arada değiştiyse 409 LINE_CHANGED. */
  decide: (lineId: string, decision: Decision, reason?: string, expectedDecision?: Decision) =>
    request<unknown>(`/invoice-lines/${lineId}`, { method: 'PATCH', body: { decision, reason, ...(expectedDecision ? { expectedDecision } : {}) } }),
  /**
   * Mesaj 14 §4.1: toplu karar. 400 VALIDATION | REASON_REQUIRED | BULK_TOO_MANY; 409 SELECTION_CHANGED (`details: { listed, current, changed }`).
   * Geri al: `changedLineIds` ile `decision: 'OPEN'`.
   */
  decideMany: (id: string, b: BulkDecideBody) => request<BulkDecideResult>(`/invoices/${id}/lines/decide`, { body: b }),
  updateLine: async (lineId: string, b: InvoiceLinePatch): Promise<InvoiceLinePatchResult> => {
    const r = await request<unknown>(`/invoice-lines/${lineId}`, { method: 'PATCH', body: b });
    const o = (r ?? {}) as Partial<InvoiceLinePatchResult>;
    return o.line ? (o as InvoiceLinePatchResult) : { line: r as InvoiceLine };
  },
  /** Faturanın sabit dayanağıyla yalnız açık satırlar (kur yeniden denemesi gibi); önizlemesiz. */
  recompare: (id: string) => request<Partial<InvoiceRecompareResult>>(`/invoices/${id}/recompare`, { method: 'POST' }),
  /**
   * Mesaj 4: önce/sonra (yazmaz). `basis: 'tariff' | 'rules'` ya da `patch` varken etkin itiraz 409 INVOICE_HAS_DISPUTE;
   * `lineIds` içinde itirazdaki satır 409 LINE_IN_DISPUTE. `lineIds` ve `patch` yalnız `basis: 'pinned'` ile (yoksa 400).
   */
  recalculatePreview: (id: string, b: { basis: RecalcBasis; lineIds?: string[]; patch?: RecalcPatch }) =>
    request<InvoiceRecalcPreview>(`/invoices/${id}/recalculate/preview`, { body: withLineIds(b) }),
  /** Önizlemenin `token`'ıyla yazar; özet tutmazsa 409 PREVIEW_STALE. */
  recalculate: (id: string, b: { basis: RecalcBasis; lineIds?: string[]; token: string }) =>
    request<unknown>(`/invoices/${id}/recalculate`, { body: withLineIds(b) }).then((r) => unwrap<Invoice>(r, 'invoice')),
  /** SPEC §3.9: tarife uyumu raporu */
  tariffHealth: (id: string) => request<{ health: TariffHealth }>(`/invoices/${id}/tariff-health`).then((r) => r.health),
  remove: (id: string) => request<void>(`/invoices/${id}`, { method: 'DELETE' }),
  downloadXlsx: (id: string, no: string) => download(`/invoices/${id}/report.xlsx`, `fark-raporu-${no}.xlsx`),
  downloadPdf: (id: string, no: string) => download(`/invoices/${id}/report.pdf`, `fark-raporu-${no}.pdf`),
  /** Mesaj 5: itiraz fotoğrafları (ZIP). */
  // ad sunucunun Content-Disposition başlığından; yedek ad sözleşmedeki ad (spec/itiraz.md, mektubun dilinde)
  // KALANLAR 1.12: `sign` imzanın e-posta/telefon başlıkları (`lib/disputeMail.ts` `signatureHeaders`); ZIP'teki mektup metinle aynı
  downloadEvidenceZip: (id: string, no: string, lang: 'tr' | 'en', sign?: Record<string, string>) =>
    download(`/invoices/${id}/dispute/evidence.zip`, `${lang === 'en' ? 'dispute-evidence' : 'itiraz-kanit'}-${no}.zip`, { lang }, sign),
  dispute: (id: string, lang: 'tr' | 'en', sign?: Record<string, string>) =>
    request<DisputeText>(`/invoices/${id}/dispute`, { query: { lang }, ...(sign ? { headers: sign } : {}) }),
};

// ---- itiraz takibi (Deciship/spec/itiraz.md "API sözleşmesi") ----
/** Yanıt çıplak ya da sarılı (`{ dispute }`, `{ data }`) gelebilir: ikisi de okunur. */
function unwrapDispute(r: unknown): InvoiceDispute {
  const o = (r ?? {}) as Record<string, unknown>;
  return (o.dispute ?? o.data ?? r) as InvoiceDispute;
}

export const disputes = {
  list: async (q: { status?: DisputeListStatus | ''; q?: string; carrierId?: string; page?: number; pageSize?: number }) => {
    const r = await request<DisputeListResponse | { data: DisputeListResponse }>('/disputes', { query: { ...q } });
    return ('data' in r && r.data ? r.data : r) as DisputeListResponse;
  },
  /** 400 NO_SENDABLE_LINES · 409 DISPUTE_ACTIVE · 400 SENT_ON_IN_FUTURE */
  send: (invoiceId: string, b: DisputeSendBody) => request<unknown>(`/invoices/${invoiceId}/disputes`, { body: b }).then(unwrapDispute),
  resend: (disputeId: string, b: DisputeSendBody & { version: number }) =>
    request<unknown>(`/disputes/${disputeId}/resend`, { body: b }).then(unwrapDispute),
  /** 409 HAS_RECOVERED_RESULTS: önce dekont geri alınır */
  withdraw: (disputeId: string, b: { version: number; reason: string }) =>
    request<unknown>(`/disputes/${disputeId}/withdraw`, { body: b }).then(unwrapDispute),
  /** 400 LINE_NOT_PENDING · AMOUNT_EXCEEDS_CLAIM · CREDIT_NOTE_REQUIRED · REASON_REQUIRED */
  addResult: (disputeId: string, b: DisputeResultBody) => request<unknown>(`/disputes/${disputeId}/results`, { body: b }).then(unwrapDispute),
  /** `version`: turun sürümü */
  revertResult: (resultId: string, b: { version: number; reason: string }) =>
    request<unknown>(`/dispute-results/${resultId}/revert`, { body: b }).then(unwrapDispute),
};

// ---- 5.9 dashboard ----
export const dashboard = {
  get: (month: string) => request<Dashboard>('/dashboard', { query: { month } }),
};

export const referenceCard = {
  download: () => download('/reference-card.pdf', 'deciship-referans-karti.pdf'),
};
