import { initI18n, type Locale } from "./index.ts";

/**
 * Test yardımcısı: i18next'i gerçek sözlükle başlatır. İçe aktarmak yeter (TR yüklenir), böylece metni sözlüğe
 * taşınan saf dosyaların testleri bugünkü Türkçe beklentilerle aynen koşar:
 *
 *   import "../../i18n/test.ts";
 *
 * Başka dilde denemek için `setTestLocale("en")`; testin sonunda `setTestLocale("tr")` ile geri dönülür.
 */
export function setTestLocale(locale: Locale = "tr") {
  return initI18n({ forceLocale: locale });
}

setTestLocale("tr");
