import { supportMailto as baseMailto } from '@sellerondata/contracts';

/**
 * Destek e-postası (11-B16): ortak `supportMailto` konusu + gövdede uygulama sürümü ve cihaz. Gövde iki boş satırla başlar,
 * kullanıcı sorununu üste yazar. Saf: sürüm ve cihaz bilgisi çağırandan gelir (React Native'e bağlı değil, test edilir).
 */
export function supportMailto(subjectParts: readonly (string | null | undefined)[] = [], bodyLines: readonly (string | null | undefined)[] = []): string {
  const base = baseMailto(subjectParts);
  const lines = bodyLines.map((l) => l?.trim()).filter(Boolean);
  if (!lines.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}body=${encodeURIComponent(`\n\n${lines.join('\n')}`)}`;
}

/** "1.1.0 (2)"; derleme numarası yoksa yalnız sürüm. */
export function versionLabel(version: string, build: number | null): string {
  return build === null ? version : `${version} (${build})`;
}

/** React Native `Platform` nesnesinin kullanılan kısmı. */
export type DeviceInfo = { OS: string; Version?: string | number; constants?: Record<string, unknown> };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "samsung SM-A515F · Android 13", "iPhone · iOS 18.1"; bilgi yoksa null. Kullanıcının verdiği cihaz adı bilerek alınmaz. */
export function deviceLabel(p: DeviceInfo): string | null {
  const c = p.constants ?? {};
  if (p.OS === 'android') {
    const maker = str(c.Manufacturer) || str(c.Brand);
    const model = str(c.Model);
    const name = model && maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model || maker;
    const release = str(c.Release);
    const os = release ? `Android ${release}` : p.Version !== undefined && p.Version !== '' ? `Android API ${p.Version}` : 'Android';
    return name ? `${name} · ${os}` : os;
  }
  if (p.OS === 'ios') {
    const idiom = str(c.interfaceIdiom);
    const name = idiom === 'pad' ? 'iPad' : idiom === 'phone' ? 'iPhone' : '';
    const os = `${str(c.systemName) || 'iOS'}${p.Version !== undefined && p.Version !== '' ? ` ${p.Version}` : ''}`;
    return name ? `${name} · ${os}` : os;
  }
  return null;
}
