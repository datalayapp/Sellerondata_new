import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

// Uygulama girişi (index.html → src/main.tsx). Yapı bayrağı derlemede sabittir: kullanılmayan kip pakete girmez.
// - Yerel (`pnpm build`): `yerel.tsx`, bugünkü üst satır, girişsiz.
// - Platform (`pnpm build:platform`): `oturum/giris.tsx`, ortak kabuk ve oturum.
// Üst düzey await: modül bitene kadar çizim bekler, ilk kare doğru kiple gelir.
// Bayrak doğrudan okunur (işlev çağrısı değil): derleyici kullanılmayan dalı ve onun parçasını atar.
if (import.meta.env.VITE_TAGPRESS_PLATFORM === "1") {
  const { startPlatform } = await import("./oturum/giris.tsx");
  startPlatform();
} else {
  const { startLocal } = await import("./yerel.tsx");
  startLocal();
}
