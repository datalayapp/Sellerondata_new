/**
 * Taşıyıcı hizmet kısaltmalarının açık adı ve tek satırlık açıklaması (PDF tarife tablo seçimi).
 * Bilinmeyen hizmetlerde null; ekran yalnızca tablonun kendi başlığını gösterir.
 */
import { i18n } from '../i18n';

export type ServiceInfo = { code: string; name: string; hint: string };

const KNOWN: Record<string, string> = {
  IP: 'International Priority',
  IPE: 'International Priority Express',
  IE: 'International Economy',
  IPF: 'International Priority Freight',
  IEF: 'International Economy Freight',
  ICP: 'International Connect Plus',
};

/** Tablonun hizmet kodu: hizmet adındaki "(IP)" ya da başlığın ilk kelimesi ("IP ihracat · …"). */
export function serviceCode(s: { service: string | null; title: string }): string | null {
  const m = s.service?.match(/\(([A-Z]{2,5})\)/) ?? s.title.match(/\(([A-Z]{2,5})\)/);
  if (m) return m[1]!;
  const first = s.title.trim().split(/\s+/)[0] ?? '';
  return /^[A-Z]{2,5}$/.test(first) ? first : null;
}

export function serviceInfo(s: { service: string | null; title: string }): ServiceInfo | null {
  const code = serviceCode(s);
  const k = code ? KNOWN[code] : undefined;
  return code && k ? { code, name: k, hint: i18n.t(`serviceInfo.${code}`) } : null;
}

/** Tablonun hangi hizmete ait olduğu (aynı tarifede karışmasın diye karşılaştırma anahtarı). */
export function serviceKey(s: { service: string | null; title: string }): string {
  return serviceCode(s) ?? (s.service ?? s.title.split('·')[0] ?? '').trim().toLowerCase();
}
