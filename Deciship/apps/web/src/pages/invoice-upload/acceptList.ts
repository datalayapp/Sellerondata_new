// Dosya seçicinin kabul listesi: .xls hiçbir durumda yok (sunucu okuyamıyor), .pdf yalnız yapay zekâ okuma açıkken.
export function acceptList(aiAvailable: boolean): string {
  const parts = [".csv", ".xlsx", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  if (aiAvailable) parts.push(".pdf", "application/pdf");
  return parts.join(",");
}

/** PDF okuma kapalıyken (`me.aiAvailable === false`) PDF seçilemez; bilgi yoksa (undefined) engellenmez. */
export function isBlockedPdf(file: { name: string }, aiAvailable: boolean | undefined): boolean {
  return aiAvailable === false && file.name.toLowerCase().endsWith(".pdf");
}

/**
 * PDF fatura okumanın durumu (`GET /me`): `off` anahtar yok, `quota` bu ayki yapay zekâ hakkı doldu (Y62-E3), `on` açık.
 * Bilgi yoksa (eski sunucu, `me` henüz gelmedi) açık sayılır: sunucu yine 429 ile durdurur.
 */
export type PdfReadState = "on" | "off" | "quota";
export function pdfReadState(me: { aiAvailable?: boolean; ai?: { quotaExhausted?: boolean } } | null | undefined): PdfReadState {
  if (me?.aiAvailable === false) return "off";
  if (me?.ai?.quotaExhausted === true) return "quota";
  return "on";
}

/**
 * "Tekrar dene" `fresh` ile mi gitsin. "Yeniden oku" sunucuda iş olarak başladıysa hayır: işin okuyup ücretlediği parçalar
 * önbellekte en yeni kayıttır, ama yeni `fresh` iş kendi başlangıcından eski kaydı kullanmaz (`cacheNotBefore`) ve aynı
 * parçaları yeniden ücretlerdi (gruplu PDF'te bir parça düşünce öncekiler). İş hiç başlamadıysa (istek reddedildi) hiçbir şey
 * okunmadı ve ücretlenmedi: yeniden okuma isteği sürer.
 */
export function retryFresh(fresh: boolean, jobStarted: boolean): boolean {
  return fresh && !jobStarted;
}
