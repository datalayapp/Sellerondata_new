/**
 * Düzenleme formunu yalnız bir kez (ya da kayıt değişince) doldurma kapısı (G4).
 *
 * Yükleme efekti çeviri işlevine (`t`) ve bağlam işlevlerine bağlıdır. Uygulama 60 sn'den uzun arka planda kalıp öne
 * gelince profil yenilenir; `setLocale` dil aynı olsa da `languageChanged` yayar, `t` yenilenir, efekt yeniden çalışır ve
 * form kayıttaki değerlerle yeniden doldurulurdu: kişinin yazdığı silinirdi. Kapı aynı kayıt için ikinci doldurmayı engeller.
 * Elle "Yeniden dene" kapıdan geçmez.
 */
export type FormLoadGate = {
  /** Bu kayıt için doldurma yapılmalı mı? `true` dönerse kayıt alınmış sayılır; aynı anahtar bir daha `true` almaz. */
  claim: (key: string) => boolean;
};

export function createFormLoadGate(): FormLoadGate {
  let loaded: string | null = null;
  return {
    claim(key) {
      if (loaded === key) return false;
      loaded = key;
      return true;
    },
  };
}

/** Düzenlenen kaydın kimliği: yerel kuyruk satırı ile sunucu kaydı ayrı. */
export const editFormKey = (id: string, isLocal: boolean): string => `${isLocal ? 'local' : 'server'}:${id}`;
