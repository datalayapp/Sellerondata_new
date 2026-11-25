import { parseMeasureNumber } from '@deciship/core/measure';

/**
 * "4,02" | "4.02" | "1.234,5" → number. Ağırlık/ölçü girişi içindir; web ölçüm formuyla tek kural: core `parseMeasureNumber`.
 * Core `parseTrNumber`dan bilerek farklı: virgülsüz "1.234" burada 1,234 (core'da fatura bağlamında 1234).
 * Ağırlık tuş takımında yalnız virgül var; ölçü alanının ondalık klavyesi ise cihaz diline göre nokta gösterir
 * ve nokta orada ondalık ayırıcıdır ("12.5" cm). Binlik okumak "1.250"yi (1,25) 1250 yapardı; ölçü ≤ 400 cm, ağırlık < 1000 kg, binlik gerekmez.
 * K36 (kullanıcı kararı 2026-11-14): "1.500" koli ağırlığında sorulmadan 1,5 kg okunur (koli 1500 kg olamaz).
 * Dil almaz: tuş takımı metni her dilde virgüllüdür ("4,5"), EN binlik kuralı burada uygulanmaz.
 */
export function parseNum(s: string): number | null {
  return parseMeasureNumber(s);
}
