// Saf yardımcılar (`test/upload-resume.test.ts` sınar): Y95 açık önizlemenin tazelenmesi, Y124-E4 "Dosyayı bize gönderin".
import { supportMailto } from "@sellerondata/contracts";
import type { ApiError } from "../../api/client";

/** Açık önizlemede kullanıcı bir şey yaptıysa sunucuya en çok bu aralıkla "hâlâ çalışıyorum" denir (sunucu 24 saatte siler). */
export const KEEP_ALIVE_MS = 15 * 60 * 1000;

/**
 * Tazeleme zamanı geldi mi: son tazelemeden beri kullanıcı sayfada bir şey yaptı (tıklama, tuş) ve aralık doldu. Sekmesi
 * açık kalıp dokunulmayan önizleme tazelenmez: gerçekten terk edilmiş sayılır, sunucu 24 saat sonra siler.
 */
export function keepAliveDue(lastActivityAt: number, lastKeptAt: number, now: number): boolean {
  return lastActivityAt > lastKeptAt && now - lastKeptAt >= KEEP_ALIVE_MS;
}

/**
 * Hata dosyanın kendisinden mi geliyor (okunamadı, biçim, boyut, yapay zekâ okuyamadı): "Dosyayı bize gönderin" yalnız
 * bunlarda. Geçici ya da hesaba bağlı hatalarda (meşgul, hız sınırı, alan ya da hak doldu, anahtar yok, oturum, ağ) yok.
 */
const NOT_FILE_PROBLEM = new Set([
  "AI_DISABLED",
  "AI_QUOTA_EXCEEDED",
  "AI_DAILY_BUDGET",
  "STORAGE_QUOTA_EXCEEDED",
  "TOO_MANY_REQUESTS",
  "FILE_BUSY",
  "DEMO_ACTIVE",
  "READ_ONLY",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
]);
/** `ApiError` (istemci) ya da işin hatasından kurulan aynısı; sınıf bağımlılığı yok (tarayıcısız testte yüklenir). */
const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error && e.name === "ApiError" && typeof (e as ApiError).status === "number" && typeof (e as ApiError).code === "string";
/**
 * "Tekrar dene" işe yaramayan hatalar: yapay zekâ kapalı, firmanın dosya alanı ya da aylık hakkı doldu, sistemin günlük
 * yapay zekâ tavanı doldu (429 `AI_DAILY_BUDGET`, kapalı deneme 2026-11-12; ertesi gün açılır). Sunucu metni ne yapılacağını söyler.
 */
const RETRY_USELESS = new Set(["AI_DISABLED", "STORAGE_QUOTA_EXCEEDED", "AI_QUOTA_EXCEEDED", "AI_DAILY_BUDGET"]);
export function retryUseless(error: unknown): boolean {
  return isApiError(error) && RETRY_USELESS.has(error.code);
}
/** Sistemin günlük yapay zekâ tavanı: "Dosya okunamadı" denmez, yalnız sunucu metni ("bugün için durduruldu…"). */
export function isDailyAiBudget(error: unknown): boolean {
  return isApiError(error) && error.code === "AI_DAILY_BUDGET";
}
export function isFileProblem(error: unknown): error is ApiError {
  if (!isApiError(error)) return false;
  if (NOT_FILE_PROBLEM.has(error.code)) return false;
  return error.status === 400 || error.status === 413 || error.status === 415 || error.status === 422 || error.status === 500;
}

/**
 * Destek e-postası (`supportMailto` deseni): konu, gövdede ekleme ricası ve hata kodu. Dosya `mailto` ile eklenemez;
 * kullanıcı e-postaya kendisi ekler. Hiçbir şey otomatik gönderilmez.
 */
export function sendFileHref(subjectParts: readonly (string | null | undefined)[], body: string): string {
  const base = supportMailto(subjectParts);
  return `${base}${base.includes("?") ? "&" : "?"}body=${encodeURIComponent(body)}`;
}

// ---------------- Çoklu sekme: başka sekmede açık önizleme (veri kaybı koruması) ----------------
// Bir sekme önizlemede (adım 2–3) çalışırken dosya kimliğini kalp atışıyla `localStorage`'a yazar; başka sekmenin sürdürme
// bandı o dosyayı göstermez ("Kaldır" ya da "Devam et" sonrası çıkış çalışılan dosyayı silerdi). Sekme çökerse kaydı
// `OPEN_PREVIEW_STALE_MS` içinde bayatlar ve bant dosyayı yine gösterir (sekme çöktü durumu kurtarılır).

export const OPEN_PREVIEW_KEY = "sod_open_previews";
/** Açık sekme kaydını bu aralıkla tazeler. */
export const OPEN_PREVIEW_BEAT_MS = 15 * 1000;
/** Bundan eski kayıt sahibi sekme kapanmış ya da çökmüş sayılır. */
export const OPEN_PREVIEW_STALE_MS = 60 * 1000;

export type OpenPreviews = Record<string, { tab: string; at: number }>;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Bozuk ya da beklenmeyen biçimdeki kayıt yok sayılır. */
export function parseOpenPreviews(raw: string | null): OpenPreviews {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: OpenPreviews = {};
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      const o = e as { tab?: unknown; at?: unknown } | null;
      if (o && typeof o.tab === "string" && typeof o.at === "number" && Number.isFinite(o.at)) out[id] = { tab: o.tab, at: o.at };
    }
    return out;
  } catch {
    return {};
  }
}

const fresh = (m: OpenPreviews, now: number): OpenPreviews =>
  Object.fromEntries(Object.entries(m).filter(([, e]) => now - e.at < OPEN_PREVIEW_STALE_MS && e.at <= now + OPEN_PREVIEW_STALE_MS));

/** Bu sekme dosyayı açık tutuyor (bayat kayıtlar da temizlenir). */
export function markOpen(m: OpenPreviews, fileId: string, tab: string, now: number): OpenPreviews {
  return { ...fresh(m, now), [fileId]: { tab, at: now } };
}

/** Bu sekme dosyayı bıraktı; başka sekmenin kaydına dokunulmaz. */
export function markClosed(m: OpenPreviews, fileId: string, tab: string, now: number): OpenPreviews {
  const next = fresh(m, now);
  if (next[fileId]?.tab === tab) delete next[fileId];
  return next;
}

/** Dosya başka bir (canlı) sekmede açık mı. */
export function openElsewhere(m: OpenPreviews | null, fileId: string, tab: string, now: number): boolean {
  const e = m?.[fileId];
  return Boolean(e && e.tab !== tab && now - e.at < OPEN_PREVIEW_STALE_MS && e.at <= now + OPEN_PREVIEW_STALE_MS);
}

/** Bantta gösterilecekler: başka sekmede açık olanlar çıkar. Kayıt okunamadıysa (`null`) bugünkü gibi hepsi. */
export function visibleResumables<T extends { fileId: string }>(items: readonly T[], m: OpenPreviews | null, tab: string, now: number): T[] {
  return items.filter((i) => !openElsewhere(m, i.fileId, tab, now));
}

/** Kaydı okur; depolama erişilemezse (gizli pencere, engelli site verisi) `null`: koruma yok, bugünkü davranış. */
export function readOpenPreviews(storage: StorageLike | null | undefined): OpenPreviews | null {
  try {
    if (!storage) return null;
    return parseOpenPreviews(storage.getItem(OPEN_PREVIEW_KEY));
  } catch {
    return null;
  }
}

/** Kaydı günceller (oku → değiştir → yaz); depolama erişilemezse sessizce hiçbir şey yapmaz. */
export function updateOpenPreviews(storage: StorageLike | null | undefined, change: (m: OpenPreviews) => OpenPreviews): void {
  try {
    if (!storage) return;
    storage.setItem(OPEN_PREVIEW_KEY, JSON.stringify(change(parseOpenPreviews(storage.getItem(OPEN_PREVIEW_KEY)))));
  } catch {
    /* depolama yok ya da dolu: koruma yok */
  }
}

/** `window.localStorage` erişimi bile atabilir (engelli site verisi). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
