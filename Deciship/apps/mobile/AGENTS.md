# SellerOnData mobil uygulaması (Expo / React Native): ajan notları

Tek SellerOnData mobil uygulaması (kimlik `com.sellerondata.app`); bugün DeciShip ölçümünü taşır. Davranış kuralları `Deciship/spec/mobil.md` (SPEC §6), tasarım D05 `Platform/docs/DESIGN.md`, telefonda deneme `Deciship/TELEFON-KURULUM.md`.

## Expo değişti: eğitim bilgisine güvenme

Expo her SDK sürümünde kırıcı değişiklik yapar. Expo, EAS ya da React Native API'sine dokunan kod yazmadan önce:
1. `package.json`'daki `expo` ana sürümüne bak (bugün 58).
2. O sürümün belgesini aç: `https://docs.expo.dev/versions/v<ana sürüm>.0.0/`.
3. Diğer konular için `https://docs.expo.dev/llms.txt` dizininden ilgili sayfaya git; ezberden cevap verme.

## Yerleşim
- Yönlendirme **Expo Router**; ekranlar klasör kökündeki `app/` içinde (`_layout.tsx` gezgini tanımlar, `(auth)`, `(tabs)` grupları). Ekran olmayan kod `src/` altında (`api`, `auth`, `queue`, `measure`, `ui`, `i18n` ...).
- Yerel ölçüm modülü `modules/box-measure`; Expo eklentileri `plugins/`.
- `android/` üretilir ve git'te yoktur (`.gitignore`); elle düzenlenmez. Yerel davranış `app.json`, `app.config.js` ve eklentilerle ayarlanır.

## Komutlar (`Deciship/apps/mobile` içinde)
- Paket ekleme: `npx expo install <paket>` (npm/yarn add değil; SDK'ya uyumlu sürümü seçer). Uyum denetimi: `npx expo-doctor`, `npx expo install --fix`.
- Test: `npm test`; tip denetimi: `npm run typecheck`; metin anahtarları: `npm run check:i18n`. İş bitmeden bunlar koşulur.
- Derleme bulutta EAS ile değil, yerelde betikle yapılır: `Deciship\scripts\android-build.ps1` (profiller `eas.json`). Ayrıntı `Deciship/scripts/README.md`.
- Expo Go çalışmaz (yerel modül var); geliştirmede dev client APK kullanılır. Ajanlar Metro/`expo start` başlatmaz.
- Arayüz metni koda yazılmaz; TR ve EN sözlüğe girer (`src/locales`).
