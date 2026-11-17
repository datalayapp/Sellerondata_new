# DeciShip — tasarım kuralları

Tasarım kuralları `Platform/docs/DESIGN.md` içindedir (renk, yazı, ölçü, D09 web kabuğu, D05 mobil, sadelik). Bu dosya yalnız DeciShip'e özgü kuralları tutar. Belge ile kod ayrışırsa kod doğrudur.

- **Satır durumu** (`apps/web/src/lib/labels.ts` `STATUS_TONE`): Uyumlu `green` · Fark var `red` · Eşleşmedi `gray` · Tarife yok `yellow`.
- **Fark türleri** (`DiffTags`): Mükerrer, Ölçü farkı, Ağırlık farkı, Ek ücret, Fiyat farkı. Küçük rozet; ilk tür `red`, diğerleri `gray`.
- **Karar** (`DECISION_TONE`): Karar bekliyor rozet çizilmez · İtiraz listesinde `blue` · Uyumlu sayıldı `outline` (beyaz zemin, yeşil kenar ve yazı).
- **Mobil ölçüm durumu** (`apps/mobile/src/ui/MeasurementRow.tsx`): Gönderildi `success` · Kuyrukta `warning` · Hata `danger`.
- **Ölçüm yöntemi grafiği** (`pages/Dashboard.tsx` `METHOD_COLORS`): LiDAR `#1d5bd8` · AR `#7a5af8` · Referans kartı `#0e9384` · Hazır koli `#dc6803` · Manuel `#98a2b3`.
- **Pano:** solda tek baş rakam (`.dash-hero`), sağda cetvelli satırlar (`.dash-row`); eş boy kart ızgarası yok. Kırmızı yalnız ana tutarda. Tutarlar para birimleri arasında toplanmaz; diğer para birimi ayrı satırda.
- **İzne göre arayüz:** görünürlük `usePermission('deciship.x')` ile, rol adına bakılmaz. İzin yoksa düğme ve menü gizlenir; bölüm görünmeli ama değişmemeliyse `<fieldset className="ds-ro" disabled>`. Fiyat izni yoksa tutar sütunu çizilmez.
- **Sayfaya özel CSS** `apps/web/src/styles/pages/<sayfa>.css` içinde (`main.tsx`'te yüklenir); sayfa işi `app.css`'e dokunmaz.
- **Marka dosyaları:** `Deciship/brand` (ayrıntı `brand/README.md`); `Platform/brand` buradan kopyalar.
