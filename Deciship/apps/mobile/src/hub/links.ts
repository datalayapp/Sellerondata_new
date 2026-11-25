/**
 * Derin bağlantı: `HubRow.href`, `HubAlert.href` ve benzerleri ürün API'sinden gelir, güvenilmez.
 * Mobilde karşılığı olan adres uygulama ekranını açar, gerisi web'e gider.
 * Ekran yolları yalnız `APP_ROUTES`ta.
 */
export const WEB_ORIGIN = 'https://app.sellerondata.com';

const HTTP_ORIGIN = /^(https?:\/\/[^/?#\s\\]+)/i;

/**
 * Web uygulamasının kökü (G6). Elle verilen `EXPO_PUBLIC_WEB_ORIGIN` önce gelir. Geliştirme derlemesinde sunucu adresinin
 * kökü: yerel gateway (8088) Merkez'i de sunar, bağlantı yereldeki hesaba gider. Üretim ve önizlemede `WEB_ORIGIN`.
 * Saf: derleme profili ve sunucu adresi çağırandan gelir.
 */
export function webOriginFor(o: { envOrigin?: string | null; development: boolean; serverUrl?: string | null }): string {
  const env = HTTP_ORIGIN.exec(o.envOrigin?.trim() ?? '');
  if (env) return env[1]!;
  const server = o.development ? HTTP_ORIGIN.exec(o.serverUrl?.trim() ?? '') : null;
  return server ? server[1]! : WEB_ORIGIN;
}

export const APP_ROUTES = {
  overview: '/hub',
  activity: '/hub/activity',
  team: '/hub/team',
  measurements: '/deciship/history',
  measurement: (id: string) => `/deciship/measurement/${encodeURIComponent(id)}`,
} as const;

/**
 * Telefonda karşılığı olmayan ya da web'de daha rahat olan Merkez sayfaları (hub-web `App.tsx` yolları).
 * Analiz telefonda yok: hep web'de açılır.
 */
export const WEB_ROUTES = {
  analytics: (product: string) => `/analytics/${encodeURIComponent(product)}`,
  activity: '/activity',
  team: '/account/team',
  join: '/join',
} as const;

export type HubLinkAccess = { team: boolean; measurements: boolean };
export type HubLink = { kind: 'app'; path: string } | { kind: 'web'; url: string } | { kind: 'none' };

/** Yalnız aynı kökene giden kök göreli yol ya da bizim web adresimiz kabul edilir. */
function normalize(href: string | null | undefined, webOrigin: string): string | null {
  if (typeof href !== 'string') return null;
  const raw = href.trim();
  // eslint-disable-next-line no-control-regex -- kontrol karakteri taşıyan bağlantı bilerek reddedilir.
  if (!raw || /[\\\s\u0000-\u001f]/.test(raw)) return null;
  if (raw.startsWith('/')) return raw.startsWith('//') ? null : raw;
  for (const origin of [webOrigin, WEB_ORIGIN]) {
    if (raw === origin) return '/';
    if (raw.startsWith(`${origin}/`) || raw.startsWith(`${origin}?`)) return raw.slice(origin.length).replace(/^\?/, '/?');
  }
  return null;
}

/** Süzgeçli liste uygulamada aynı süzgeçle açılamaz: yanlış veri göstermektense web'e gider. */
function toAppPath(path: string, query: string, access: HubLinkAccess): string | null {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '/home') return APP_ROUTES.overview;
  // Etkinlik telefonda süzgeçsiz: süzgeçli adres web'e gider. Analiz satırı yok: web'e gider.
  if (clean === '/activity') return query ? null : APP_ROUTES.activity;
  if (clean === '/account/team') return access.team ? APP_ROUTES.team : null;
  if (!access.measurements) return null;
  // Ürün API'si ayrıntıyı `/deciship/measurements?id=<id>` biçiminde verir.
  const byId = clean === '/deciship/measurements' ? /^\?id=([^&#]+)$/.exec(query) : null;
  if (byId) {
    try {
      return APP_ROUTES.measurement(decodeURIComponent(byId[1]!));
    } catch {
      return null;
    }
  }
  if (query) return null;
  if (clean === '/deciship/measurements' || clean === '/data/deciship/measurements') return APP_ROUTES.measurements;
  const detail = /^\/deciship\/measurements\/([^/]+)$/.exec(clean);
  if (detail) {
    try {
      return APP_ROUTES.measurement(decodeURIComponent(detail[1]!));
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveHubLink(href: string | null | undefined, access: HubLinkAccess, webOrigin: string = WEB_ORIGIN): HubLink {
  const target = normalize(href, webOrigin);
  if (!target) return { kind: 'none' };
  const cut = target.search(/[?#]/);
  const path = cut < 0 ? target : target.slice(0, cut);
  const query = cut < 0 ? '' : target.slice(cut);
  const app = toAppPath(path, query, access);
  return app ? { kind: 'app', path: app } : { kind: 'web', url: `${webOrigin}${target}` };
}
