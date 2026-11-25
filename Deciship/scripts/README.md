# Betikler

Hepsi PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\<ad>.ps1`. Sistemin kendisi `Platform\BASLAT.bat` ile açılır; burada yalnız mobil geliştirme yardımcıları vardır.

- `android-build.ps1` - `apps\mobile` için Android derler ve cihaza kurar. `-Profile development|preview|production` (profil ortamı `eas.json`'dan), `-Variant debug|release`, `-Device` (varsayılan `emulator-5554`), `-Clean`. Yapılandırma değişince `android\` yeniden üretilir; APK kimliği `app.json` ile denetlenir; `sod-build.json` yazılır. Gerekirse SDK'ya CMake 3.31.6 kurar, derleme sonrası Gradle'ı durdurur. Metro'yu başlatmaz.
- `apk-yayinla.ps1` - derlenmiş release APK'yı GitHub Releases'a (`android` etiketi, "DeciShip Android") yükler; `gh` gerekir. `sod-build.json` yoksa, kimlik tutmuyorsa ya da profil `production` değilse durur (`-AllowNonProduction` ile geçilir); sürüm notuna profil, API adresi, sürüm ve `versionCode` yazar.
- `emulator.ps1` - `DeciShip_Pixel` emülatörünü açar (açık değilse), açılışı bekler, `adb reverse tcp:8088 tcp:8088` kurar (`-Port` ile değişir, `-ColdBoot` anlık görüntüyü atlar).
- `phone.ps1` - USB/kablosuz bağlı fiziksel telefonu bulur, release APK'yı kurar/günceller, `adb reverse tcp:8088 tcp:8088` açar. `-NoInstall` kurulumu atlar; `-Watch` bağlantıyı ~3 sn'de bir tüm cihazlarda denetleyip yeniler.
- `screenshot.ps1 -Path dosya.png` - bağlı cihazın ekran görüntüsünü adb ile kaydeder.

Metro için ayrıca `adb reverse tcp:8081 tcp:8081` gerekir; adımlar `TELEFON-KURULUM.md` içinde.

Emülatör notları:
- SDK: `%LOCALAPPDATA%\Android\Sdk` (WHPX hızlandırma açık).
- ARCore: emülatöre Google Play Services for AR (`com.google.ar.core`), google-ar/arcore-android-sdk sürümlerindeki x86 emülatör APK'sından kurulur. Güncellemek için en yeni `Google_Play_Services_for_AR_*_x86_for_emulator.apk` indirilip `adb install -r` ile kurulur.
- Emülatörde sanal sahne Alt + WASD/fare ile gezilir (Extended controls > Camera).
