/**
 * R2 başarım girdisi: 16 MB metin + 5.000 satır (`checkPdfLines`). Doğruluk `pdfCheckLarge.test.ts`'te (kapı), süre
 * `pdfCheck.perf.test.ts`'te (`npm run test:perf`, kapı değil).
 * Her 10. satırın tutarı yanlış, her 50. satırın takip no'su metinde yok, 7. satırın takip no'su kısa ("5678").
 */
export function largePdfCheckInput(n = 5000) {
  const tracking = (i: number) => `7948${String(10_000_000 + i).padStart(8, '0')}`;
  const rows = Array.from({ length: n }, (_, i) => `${tracking(i)}  20.10.2026  Express  ${(100 + i).toLocaleString('tr-TR')},50`);
  const filler = 'Açıklama satırı: taşıma koşulları ve genel hükümler 1234 5678 sayfa 9\n';
  const target = 16 * 1024 * 1024;
  const body = rows.join('\n');
  const pad = filler.repeat(Math.ceil((target - body.length) / filler.length));
  const text = `${pad}${body}\n${pad}`;
  const lines = Array.from({ length: n }, (_, i) => ({
    rowIndex: i,
    trackingNo: i % 50 === 49 ? `9999${i}0000000` : i === 7 ? '5678' : tracking(i),
    netAmount: i % 10 === 3 ? 1 : 100 + i + 0.5,
  }));
  return { n, target, text, lines };
}
