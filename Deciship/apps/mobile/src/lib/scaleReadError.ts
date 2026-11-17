/**
 * Tartı fotoğrafı okunamadığında gösterilecek metnin anahtarı (`measure` sözlüğü, `weight.*`). Ölçüm hiçbir durumda
 * durmaz; kullanıcı ağırlığı elle girer. Y62-E4: bu ayki yapay zekâ hakkı dolunca (429 `AI_QUOTA_EXCEEDED`) "okunamadı"
 * denmez, nedeni söylenir. 05-B14: firmanın tartı okuma yuvası ya da dakika sınırı dolu (429 `TOO_MANY_REQUESTS`) ya da
 * yapay zekâ servisi yoğun (503 `AI_BUSY`): "okunamadı" değil, "yoğun, birkaç saniye sonra yeniden çekin". Girdi `ApiError`
 * ya da başka bir hata (o durumda `null`).
 */
export type ScaleReadErrorKey = 'weight.aiDisabled' | 'weight.aiQuota' | 'weight.aiDailyBudget' | 'weight.aiBusy' | 'weight.unreachable' | 'weight.unreadable';

export function scaleReadErrorKey(e: { code?: string; isNetwork?: boolean } | null | undefined): ScaleReadErrorKey {
  // AI_DISABLED: anahtar yok ya da firma tartı okumasını kapattı (409, `details.reason: 'scale_ai_off'`; kullanıcı kararı
  // 2026-11-12, eski sürümler de aynı kodu tanır).
  if (e?.code === 'AI_DISABLED') return 'weight.aiDisabled';
  if (e?.code === 'AI_QUOTA_EXCEEDED') return 'weight.aiQuota';
  // Sistemin günlük yapay zekâ tavanı doldu (429 `AI_DAILY_BUDGET`, kapalı deneme 2026-11-12): firmanın kotası değil, bugünlük.
  if (e?.code === 'AI_DAILY_BUDGET') return 'weight.aiDailyBudget';
  if (e?.code === 'TOO_MANY_REQUESTS' || e?.code === 'AI_BUSY') return 'weight.aiBusy';
  if (e?.isNetwork || e?.code === 'TIMEOUT') return 'weight.unreachable';
  return 'weight.unreadable';
}
