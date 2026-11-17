import { useSearchParams } from 'react-router';

/**
 * `?donus=/setup?adim=…` dönüş adresi: kurulum sihirbazı tarife ve fatura sayfalarını açar, kayıttan sonra
 * kullanıcı sihirbaza geri gelir. Yalnız uygulama içi yol kabul edilir (açık yönlendirme olmasın).
 */
export const RETURN_PARAM = 'donus';

export function safeReturnPath(v: string | null | undefined): string | null {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return null;
  return v;
}

/** `path`'e dönüş parametresini ekler (`to` yoksa `path` aynen döner). */
export function withReturn(path: string, to: string | null): string {
  if (!to) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${RETURN_PARAM}=${encodeURIComponent(to)}`;
}

/** Adrese sorgu parametresi ekler (ör. yüklenen faturanın kimliği). */
export function addQuery(path: string, extra: Record<string, string>): string {
  const [p, q = ''] = path.split('?');
  const sp = new URLSearchParams(q);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const s = sp.toString();
  return s ? `${p}?${s}` : p;
}

export function useReturnTo() {
  const [sp] = useSearchParams();
  const to = safeReturnPath(sp.get(RETURN_PARAM));
  return {
    /** geçerli dönüş adresi; yoksa null */
    to,
    /** başka bir sayfaya giderken dönüş adresini taşı */
    keep: (path: string) => withReturn(path, to),
    /** dönüş adresi (+ ek parametreler); dönüş yoksa `fallback` */
    back: (fallback: string, extra: Record<string, string> = {}) => (to ? addQuery(to, extra) : fallback),
  };
}
