# Kod haritası — Mobil ve görüntü servisi

Yollar depo köküne göredir.

## Mobil

Kök `Deciship/apps/mobile` (Expo Router, tek SellerOnData uygulaması; Android'de dev client APK, Expo Go çalışmaz).

| Dosya | Ne işe yarar |
|---|---|
| `Deciship/apps/mobile/app/` | Ekranlar (ayrıntı aşağıda "Ekran ağacı"). |
| `Deciship/apps/mobile/src/api/endpoints.ts` | Mobilin API tipleri ve çağrıları (web'den ayrı, elle tutulur). |
| `Deciship/apps/mobile/src/queue/` | Çevrimdışı ölçüm kuyruğu: `schema.ts` (yerel SQLite şeması, `SCHEMA_VERSION`; `kv` tablosu taslağı da tutar), `store.ts`, `flush.ts` (gönderme; hata sınıfları ve `REJECT_CODES`, `serverTrouble`: turu durduran sunucu/ağ hatası, SPEC §6.2), `schedule.ts` (zamanlama: `nextFlushPlan`, `createFlushGate`, üstel genel bekleme ve `retry-after`), `QueueContext.tsx` (`serverIssue`; tetikler `run(trigger)`), `db.ts` (açılış hatasında yeniden dener). |
| `Deciship/apps/mobile/src/draft/` | Yarım ölçüm: `DraftContext.tsx` (bellek + `ready` kapısı), `persist.ts` (disk biçimi, `DRAFT_TTL_MS`, `restoreDraft`, `saveDraftToQueue`, `createDraftSync`, `draftFileRefs`), `photoFiles.ts` (fotoğrafın kalıcı kopyası `drafts/<clientId>/`, silme, sahipsiz klasör süpürmesi), `expiredNotice.ts` + `ExpiredDraftNotice.tsx` (süresi dolan taslak bildirimi), `owner.ts`. |
| `Deciship/apps/mobile/src/api/client.ts` (yenileme) | `refreshTokens` + `postRefresh`: tek uçuş, hesap servisinin 10 sn hoşgörüsüyle uyumlu tekrar (`REFRESH_TIMEOUT_MS`, `REFRESH_RETRY_WINDOW_MS`), "yenilenebilir" 403'te bir kez yenileme (`ACCESS_REFRESH_INTERVAL_MS`), `retry-after` okuma (`parseRetryAfter`). Test `tests/refresh-grace`, `tests/client`. |
| `Deciship/apps/mobile/src/lib/numKey.ts`, `dimStep.ts`, `formLoadGate.ts`, `cameraPermission.ts`, `scaleCapture.ts`, `liveCalc.ts`; `src/ui/CameraPermission.tsx` | Ölçüm akışı saf mantığı: tuş takımı (işlevsel güncelleme), ölçü − / +, düzeltme formunu bir kez doldurma, kamera izni istemi ve ayarlar düğmesi, çevrimdışı tartı fotoğrafı ve tartı okuması firma ayarı (`scaleAiRead`, varsayılan kapalı: `scaleAfterCapture` → `keep`, alt satır `scaleHintKey`; ayar `AuthContext` `normalizeSettings`), canlı hesap (desi firma böleniyle, ücretli ağırlık 5000 ile). Testler `tests/num-key`, `dim-step`, `form-load-gate`, `camera-permission`, `scale-capture`, `live-calc`, `measure-flow`. |
| `Deciship/apps/mobile/src/lib/format.ts`, `src/lib/todayCount.ts` | Biçimleme ve "bugün" (firma saat dilimi `setFormatTimeZone`, oturum `AuthContext` verir; yoksa telefon saati); Bugün sayacı (`stats/today` + bekleyenler). Test `tests/format-timezone`, `tests/today-count`, `tests/formatGolden`. |
| `Deciship/apps/mobile/src/lib/supportMail.ts` | Destek e-postası (konu + gövdede sürüm ve cihaz), `versionLabel`, `deviceLabel`. Test `tests/support-mail`. |
| `Deciship/apps/mobile/src/hub/links.ts` `webOriginFor`, `WEB_ROUTES` | Web bağlantı kökü: `EXPO_PUBLIC_WEB_ORIGIN` > geliştirmede sunucu adresi > `WEB_ORIGIN`. Merkez ekranları `HubContext.tsx` `currentWebOrigin` / `webUrl` / `openWeb` ile kullanır (analiz kartı, Etkinlik ve Ekip'teki web bağlantısı, davet mesajındaki `/join`); ayrıca `src/ui/AppDock.tsx` (mobil ekranı olmayan aracı web'de açar) ve `src/ui/components.tsx`. Web yolları `WEB_ROUTES` (analiz, etkinlik, ekip, katılma). Test `tests/web-origin`, `src/hub/__tests__/hub.test.mts`. |
| `Deciship/apps/mobile/src/lib/plausibility.ts`, `src/ui/DimField.tsx` | Akla aykırı ölçü eşikleri (150 cm, 70 kg, oran 20); ölçü alanı sınırı (400 cm, kırpmaz). |
| `Deciship/apps/mobile/src/auth/`, `src/hub/` | Oturum, gezinme kuralları ve mobil Merkez (ayrıntı aşağıda "auth ve hub"). |
| `Deciship/apps/mobile/src/lib/photoKind.ts`, `src/ui/PhotoCapture.tsx` | Galeriden seçilen fotoğraf `PHOTO_OTHER` (`photoKindFor`); `onCapture` kaynağı (`camera`/`gallery`) taşır. Test `tests/photo-kind.test.ts`. |
| `Deciship/apps/mobile/src/screens/AccountScreen.tsx` | Hesap ekranı (profil düğmesinden; her zaman geri düğmeli); "Yardım ve destek" (`supportMailto`). |
| `Deciship/apps/mobile/src/ui/`, `src/locales/{tr,en}/` | Bileşenler (`theme.ts` D05 dili); `components.tsx` `Header` bantta sekmeler (`tabs`) ve profil düğmesi (`profile`); `AppDock.tsx` alttaki uygulama çubuğu (A3: üstte 3 dp renk çizgisi, solan açık ton; hazır olmayan soluk, dokunulmaz); `DeciShipTabs.ts` DeciShip üst sekmeleri ve `goToDeciShipTab` (Bugün kökte, Geçmiş üstünde tek ekran). Araçlar sekmesi ve `ToolsSheet` kaldırıldı (yerini çubuk aldı). Sözlükler `auth`, `common`, `hub`, `measure`. |
| `Deciship/apps/mobile/modules/box-measure/` | Kamera ile koli ölçen yerel modül (Kotlin/Swift). |
| `Deciship/apps/mobile/src/version/` | `client.ts` (sürüm, derleme profili `APP_ENV`, `X-SOD-Client` başlığı), `policy.ts` (güncelleme durumu `sod_upgrade_required`, `client-policy` denetimi); ekran `src/ui/UpdateRequired.tsx`. Kural SPEC §6.3. |
| `Deciship/apps/mobile/src/tools/registry.ts` | Mobil araç kaydı: ekranı olan araçlar tek listede; erişim sunucudan. Yeni araç tek satır. |
| `Deciship/apps/mobile/app.config.js`, `eas.json`, `src/api/serverUrl.ts` | Derleme profilleri (development, preview, production); üretimde https adresi zorunlu, adres alanı yalnız geliştirmede (`SERVER_EDITABLE`). Derleme betiği `Deciship/scripts/android-build.ps1` (`-Profile`), yükleme `apk-yayinla.ps1`. Android izinleri ve mimari `app.json` (`android.blockedPermissions`, `expo-build-properties.android.buildArchs` yalnız arm64; release APK x86_64 emülatöre kurulmaz); doğrulama `npx expo config --type introspect`. |

Ekran ağacı (`Deciship/apps/mobile/app/`):

- `(auth)/`: giriş, katılma, firma seçimi.
- `(tabs)/deciship/`: ölçüm akışı Barkod → Ağırlık → Ölçü → Fotoğraf → Özet (`scan` → `weight` → `dims` → `photos` → `summary`); `today` (yarım ölçüm kartı), `history`, `measurement/[id]`, `reference`.
- `(tabs)/hub/`: hafif Merkez; bölümler bantta sekme (`hub/_layout.tsx`).
  - Genel Bakış `index.tsx`: baş rakamın altında "Web'de aç" analiz kartı `WebAnalyticsCard` (seçili aracın web `/analytics/<araç>`'ı; yalnız rapor izni olana).
  - Etkinlik `activity.tsx`: Merkez'i gören herkese; hesap olayları yalnız yöneticiye.
  - Ekip `team.tsx`: yalnız sahip/yönetici; "Çalışan ekle" alt sayfası, telefon + kod daveti.
  - Analiz telefonda yok (web'de).
- `account.tsx` ve `deciship/account.tsx`: Hesap (sağ üstteki profil düğmesinden, geri ile döner).
- `app/(tabs)/_layout.tsx`: uygulama katmanı, alttaki uygulama çubuğu (`tabBar` = `AppDock`, görünürlük `showsDock`, geri tuşu `backBehavior="history"`) ve `ErrorBoundary`; son çare hata ekranı `app/_layout.tsx`.

auth ve hub (`src/auth/`, `src/hub/`):

- Oturum ve dil eşitleme.
- Gezinme kuralları `access.ts`: `dockApps` çubuk sırası ve hücre durumu, `showsDock`, `isMainRoute`, `appOf`, `DECISHIP_TABS` = Bugün · Geçmiş; `tabsFor().dock`: Merkez yetkisi olana her zaman, olmayana en az iki kullanılabilir uygulama varsa; test `tests/access`.
- Merkez: `contracts.ts` (sözleşme dikişi), `api.ts` (bütün uçlar), `views.ts` (araç seçimi `overviewTool`, Tümü yok; ekip görünümü), `activity.ts` (Etkinlik birleştirme ve gün grupları, web `Activity.tsx` kuralı), `useActivity.ts` (kaynak başına sayfalı akış), `invite.ts` (çalışan ekleme: roller katalogdan, yönetici rolü yok, hata anlamları web gibi), `ui.tsx` (`WebLink`, `InkButton`, `BottomSheet`); vurgu rengi `hubColors.ink`.
- Testler `src/hub/__tests__/{hub,activity,invite}.test.mts` (`npm run test:hub`), `tests/hub-overview-tool`.
- Kopyalama modülü yok (yerel modül yeni APK ister): kod uzun basışla seçilir, mesaj `Share` ile.

| İş | Bakılacak dosyalar | Koşulacak testler |
|---|---|---|
| Ölçüme yeni alan | API şema `Measurement` + göç, `routes/measurements.ts` (`createData`, `patchData`, `serializeMeasurement`); mobil `src/api/endpoints.ts`, `src/queue/schema.ts` (cihazdaki tablo: göç yaz, `SCHEMA_VERSION` artır), `flush.ts`; web `src/api/types.ts`, `pages/measurements/`, sahte sunucu; Merkez `services/hub/datasets.ts` | API `measurements`, `flex`; mobil `tests/queue-store`, `tests/flush` |
| Mobil metin | `src/locales/tr/*.json` + `en/*.json` | `node scripts/check-i18n.mjs --strict` (ortak betiği çağırır) |
| Mobil gezinme (alt uygulama çubuğu, üst sekmeler, profil) | `src/auth/access.ts` (`dockApps`, `showsDock`, `isMainRoute`), `app/(tabs)/_layout.tsx`, `src/ui/AppDock.tsx`, `src/ui/components.tsx` `Header`, `src/ui/DeciShipTabs.ts`, `app/(tabs)/hub/_layout.tsx` | `tests/access`, `tests/error-screens` |
| Yarım ölçüm (taslak) | `src/draft/persist.ts`, `DraftContext.tsx`, `photoFiles.ts`, `expiredNotice.ts`, `app/(tabs)/deciship/today.tsx`, `summary.tsx` | `tests/draft-persist`, `tests/draft-photos`, `tests/draft-expired`, `tests/queue-store` |
| Kuyruk hata sınıfı / API yeni hata kodu | `src/queue/flush.ts` (`classifySendError`, `REJECT_CODES`, `serverTrouble`), `QueueContext.tsx`; API kaynağı `apps/api/src/routes/measurements.ts`, `errors.ts` | `tests/flush`, `tests/flush-schedule` |
| "Çevrimiçi" durumu | `src/queue/reach.ts` (sunucu sağlık ucu yoklaması, 30 sn önbellek; `src/api/client.ts` `pingServer`) | `tests/server-reach.test.ts` |
| Okutulan kod denetimi | `src/lib/scanCheck.ts` (devam / sor / reddet), kural core `trackingFormat.ts` | `tests/scan-check.test.ts` |
| Firma değişince gezinme | `src/lib/navigation.ts` `goAfterOrgSwitch` (dismissTo / replace) | `tests/org-switch-nav.test.ts` |
| Oturum yenileme tekrar anahtarı | `src/api/client.ts` `retryKeyFor` (`<jeton özeti>:<anahtar>`, güvenli depo `sod_refresh_retry`), gönderim saati `X-SOD-Sent-At` (`stampSentAt`) | `tests/refresh-retry-key.test.ts`, `tests/client.test.ts` |
| Kuyruk zamanlaması, geri çekilme | `src/queue/schedule.ts`, `QueueContext.tsx` (tetikler), `flush.ts` (`onTrouble`) | `tests/flush-schedule`, `tests/flush`, `tests/db-open` |
| Oturum yenileme | `src/api/client.ts` (`refreshTokens`, `postRefresh`, `authedFetchOnce`); sunucu `Platform/apps/account-api/src/lib/sessions.ts` `refreshSession` | `tests/refresh-grace`, `tests/client` |
| Ölçüm adımı ekranı (tuş takımı, kamera izni, ekran açık) | `app/(tabs)/deciship/*.tsx`, `_layout.tsx` (`KeepScreenOn`), `src/ui/NumPad.tsx`, `CameraPermission.tsx`, `PhotoCapture.tsx` | `tests/measure-flow`, `num-key`, `camera-permission` |
| Ölçü sınırı ve uyarısı | `src/lib/plausibility.ts`, `src/ui/DimField.tsx`, `weight.tsx`, `summary.tsx` | `tests/plausibility` |
| Sürüm denetimi, 426, güncelleme ekranı | `src/version/*`, `src/api/client.ts`, `src/queue/flush.ts` (`upgrade` sınıfı), `src/ui/UpdateRequired.tsx`; sözleşme `Platform/packages/contracts/src/client.ts` | `tests/version`, `tests/client`, `tests/flush`, `tests/app-config` |
| Tema ya da biçimleme | "Önce" kayıtları: `tests/theme-baseline.test.ts` (`__golden__/theme-baseline.json`), `tests/formatGolden.test.ts` (`__golden__/formatGolden.mobile-*.txt`) | `tests/theme-baseline`, `tests/formatGolden`, `tests/format-timezone` |

## Görüntü servisi

Kök `Deciship/services/vision` (Python, OpenCV): `app/main.py` (uçlar ve `MSG_*` metinleri), `detect.py`, `geometry.py`. Test: `pytest` (`tests/`). `MSG_*` metinleri API `src/i18n/messages.ts` `vision.*` ile birebir aynı olmalı (API `test/i18n.test.ts` denetler).
