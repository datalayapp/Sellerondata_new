import { type FontEntry, type Profile, ProfileSchema } from "./profile.ts";

/**
 * Ürünle gelen varsayılan içerik (SUNUCU-PLANI §2.8): yeni bir firma boş ama kullanılabilir başlasın diye.
 *
 * Kurallar:
 * - Varsayılan profil ŞEMA VARSAYILANLARIDIR, artı ürünle gelen açık lisanslı fontların listesi. Uydurma ölçüm yok;
 *   hiçbir firmanın (sahibin dahil) tarzından değer taşınmaz. Arayüz bunu "varsayılan ayarlar" diye gösterir.
 * - Font dosyaları ve şablonlar `assets/varsayilan/` altındadır (lisansları ve kaynakları orada). Bu liste oradaki
 *   `fontlar/fontlar.json` ile aynı olmalı (sunucunun `org/seed.test.ts`'i denetler).
 * - Roller ve tür (el yazısı/serif/sans) fontun kendisini anlatır, tarz değildir. Sıra AI'sız denemenin ilk fontunu
 *   belirler (okunur bir serif önce).
 */

/** Yeni firmanın varsayılan tasarım dilinin adı (kullanıcı değiştirebilir). */
export const DEFAULT_LANGUAGE_NAME = "Varsayılan";

/** Ürünle gelen fontlar (`assets/varsayilan/fontlar`). Kimlik = "Aile/Stil" (değişken fontta adlı örnek). */
export const DEFAULT_FONTS: readonly FontEntry[] = [
  {
    id: "Lora/Regular",
    family: "Lora",
    style: "Regular",
    file: "Lora[wght].ttf",
    kind: "serif",
    roles: ["primary", "secondary"],
    enabled: true,
    maxUppercaseRun: null,
    lockTracking: false,
    note: "Serif; her tür metinde okunur.",
  },
  {
    id: "Parisienne/Regular",
    family: "Parisienne",
    style: "Regular",
    file: "Parisienne-Regular.ttf",
    kind: "script",
    roles: ["primary", "secondary"],
    enabled: true,
    maxUppercaseRun: null,
    // Bitişik el yazısı: harf aralığı açılırsa bağlar kopar (fontun özelliği, tarz değil).
    lockTracking: true,
    note: "El yazısı; isimler ve kısa teşekkür metinleri için.",
  },
  {
    id: "Montserrat/Regular",
    family: "Montserrat",
    style: "Regular",
    file: "Montserrat[wght].ttf",
    kind: "sans",
    roles: ["primary", "secondary"],
    enabled: true,
    maxUppercaseRun: null,
    lockTracking: false,
    note: "Sans; ürün adı, gramaj ve küçük bilgiler için.",
  },
];

/**
 * Varsayılan profil: şema varsayılanları + ürünle gelen font listesi. Her çağrıda yeni nesne (değiştirilebilir).
 * `name` verilmezse `DEFAULT_LANGUAGE_NAME`.
 */
export function defaultProfile(name: string = DEFAULT_LANGUAGE_NAME): Profile {
  return ProfileSchema.parse({
    name,
    description: "Ürünle gelen varsayılan ayarlar; tarzınıza göre değiştirin.",
    fonts: { list: DEFAULT_FONTS.map((f) => ({ ...f, roles: [...f.roles] })) },
  });
}
