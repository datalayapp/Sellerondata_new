import { type ComponentType, lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useAccess } from "../lib/access.ts";
import { useOrg } from "../lib/features.ts";
import { useLiveSync } from "../lib/liveSync.ts";
import { type AppRoute, type EkranProps, type Go, phoneNote, screenKind, TABS, useAppRoute } from "../lib/route.ts";
import { NarrowNote } from "./cerceve/cerceve.tsx";
import { PHONE_QUERY, type ScreenLayout, ScreenLayoutContext, useMediaQuery } from "./cerceve/duzen.ts";
// Gezinme bekçisi hashchange'i rota kancasından önce dinlemeli: modülü ilk yüklenenlerden biri yap.
import "./katman/leaveGuard.ts";
import { NAV_COMMAND } from "./kisayol/genel.ts";
import { setShortcutsOpen, useCommands } from "./kisayol/kayit.ts";
import { ShortcutsPanel } from "./kisayol/ShortcutsPanel.tsx";

/**
 * Rotalar (ARAYUZ-PLANI §6). Her rota tembel yüklenen `src/ekranlar/<ekran>/index.tsx`'e bağlı; ekran paketi yalnız
 * kendi `index.tsx`'ini değiştirir. Bu dosya paylaşılan dosyadır: değişikliği orkestratör yapar.
 *
 *   #/uretim?parti=&is=          Üretim (eski #/uretim/karsilastir?is= buraya düşer)
 *   #/uretim/ice-aktar           İçe aktarma masası
 *   #/duzelt/<varyantId>?don=    Düzelt (etkin menü `don` adresinin sekmesi)
 *   #/tasarim-dili/<bölüm>[/<grup>]
 *   #/tasarim-dili/olustur[/<oturum>]  Oluştur (tasarım dili oluşturucu; maket 5)
 *   #/sablonlar[/<anahtar>]
 *   #/baski, #/baski/masa/<oturum>, #/baski/sablonlar[/<id>], #/baski/arsiv
 *   #/ayarlar/<bölüm>
 *   #/kurulum[/<adım>]
 *   #/vitrin                     yalnız geliştirmede: bütün temel bileşenler
 */
type Screen = ComponentType<EkranProps>;

const Uretim = lazy(() => import("../ekranlar/uretim/index.tsx"));
const IceAktar = lazy(() => import("../ekranlar/ice-aktar/index.tsx"));
const Duzelt = lazy(() => import("../ekranlar/duzelt/index.tsx"));
const TasarimDili = lazy(() => import("../ekranlar/tasarim-dili/index.tsx"));
const Olustur = lazy(() => import("../ekranlar/olustur/index.tsx"));
const Sablonlar = lazy(() => import("../ekranlar/sablonlar/index.tsx"));
const Baski = lazy(() => import("../ekranlar/baski/index.tsx"));
const BaskiSablonlar = lazy(() => import("../ekranlar/baski/sablonlar/index.tsx"));
const BaskiArsiv = lazy(() => import("../ekranlar/baski/arsiv/index.tsx"));
const Ayarlar = lazy(() => import("../ekranlar/ayarlar/index.tsx"));
const Kurulum = lazy(() => import("../ekranlar/kurulum/index.tsx"));
const Vitrin: Screen | null = import.meta.env.DEV ? lazy(() => import("./vitrin/index.tsx")) : null;

export function pickScreen(route: AppRoute): Screen {
  switch (route.id) {
    case "uretim":
      return route.rest[0] === "ice-aktar" ? IceAktar : Uretim;
    case "duzelt":
      return Duzelt;
    case "tasarim-dili":
      return route.rest[0] === "olustur" ? Olustur : TasarimDili;
    case "sablonlar":
      return Sablonlar;
    case "baski":
      return route.rest[0] === "sablonlar" ? BaskiSablonlar : route.rest[0] === "arsiv" ? BaskiArsiv : Baski;
    case "ayarlar":
      return Ayarlar;
    case "kurulum":
      return Kurulum;
    case "vitrin":
      return Vitrin ?? Uretim;
  }
}

/**
 * Açılışta bir kez `GET /api/org`: kurulum tamamlanmamışsa (`pending` ya da `in-progress`) Kurulum'a gider (geçmişe
 * yazmadan). Kurulum ve vitrin adresleri yönlendirilmez; yanıt gelmezse (sunucu yok, hata) hiçbir şey yapılmaz.
 * Kullanıcı sonra başka ekrana geçerse yeniden yönlendirilmez. Kurulumu yalnız yönetebilen (`access.manage`) yapar:
 * platformda yönetici olmayan kişi Kurulum'a gönderilmez (adımları kaydedemez).
 */
function useSetupRedirect(route: AppRoute, go: Go) {
  const org = useOrg();
  const { manage } = useAccess();
  const done = useRef(false);
  const status = org.data?.setup.status;
  useEffect(() => {
    if (done.current || (!status && !org.error)) return;
    done.current = true;
    if (status && manage && status !== "completed" && route.id !== "kurulum" && route.id !== "vitrin") go("kurulum", [], undefined, true);
  }, [status, manage, org.error, route.id, go]);
}

/**
 * Ekranın çizilecek bileşeni: telefonda (≤ 760 px) çalışma ekranı yerine not (tuval ve iki panel sığmaz); form ve
 * liste ekranları telefonda da açılır.
 */
export function screenFor(route: AppRoute, phone: boolean): Screen {
  return phone && phoneNote(route) ? NarrowNote : pickScreen(route);
}

/**
 * Tezgâh uygulaması: rota, canlı eşitleme, genel kısayollar (Alt 1–5 menü, `?` listesi). Ekran türü (`screenKind`)
 * çerçeveye bağlamla gider (`cerceve/duzen.ts`).
 */
export function TezgahApp() {
  const [route, go] = useAppRoute();
  useLiveSync();
  useSetupRedirect(route, go);
  useCommands("genel", {
    ...Object.fromEntries(TABS.map((t) => [NAV_COMMAND[t.id], () => go(t.id)])),
    help: () => setShortcutsOpen(true),
  });
  const phone = useMediaQuery(PHONE_QUERY);
  const kind = screenKind(route);
  const layout = useMemo<ScreenLayout>(() => ({ kind, routeId: route.id }), [kind, route.id]);
  const Screen = screenFor(route, phone);
  return (
    <ScreenLayoutContext.Provider value={layout}>
      <Suspense fallback={<div className="tz-boot" aria-busy="true" />}>
        <Screen route={route} go={go} />
      </Suspense>
      <ShortcutsPanel />
    </ScreenLayoutContext.Provider>
  );
}
