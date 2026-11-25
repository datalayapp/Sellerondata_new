import { createSessionClient, currentLocale } from '@sellerondata/shell';
import { loginHref, TOOL } from '../lib/base';

/**
 * Tek oturum istemcisi (kabuktan): HttpOnly çerez, CSRF başlığı, `Accept-Language`, 401'de tek seferlik yenileme + tekrar
 * (ARCHITECTURE §5). Yenileme de başarısızsa kalınan yeri hatırlayarak Merkez girişine gidilir.
 * Karşılığı: Deciship/apps/web/src/api/session.ts. DeciShip kaydedilmemiş yazıyı sormadan gitmez (`lib/sessionLost.ts`);
 * araç form içerince o dosya da alınır.
 */
export const sessionClient = createSessionClient({
  getLocale: currentLocale,
  onSessionLost: () => window.location.assign(loginHref(window.location.pathname, window.location.search)),
});

/** Aracın API'si. Hata gövdesi `{ error: { code, message } }`; kabuğun `ApiError`'ı olarak fırlar. */
export const api = {
  get: <T>(path: string) => sessionClient.get<T>(`/api/${TOOL}${path}`),
};
