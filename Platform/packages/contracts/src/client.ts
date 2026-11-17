/**
 * Mobil istemci sürümü: başlık biçimi, sürüm karşılaştırma ve "en düşük sürüm" politikası.
 * Saf TypeScript, bağımlılıksız. Başlık yoksa ya da bozuksa sunucu denetim yapmaz (web, curl, eski APK etkilenmez).
 */
export const CLIENT_HEADER = 'X-SOD-Client';

export type ClientInfo = { kind: 'mobile'; version: string; build: number | null; platform: string | null };

/** "mobile/1.1.0+2 (android)". `build` ve `platform` yoksa o parça yazılmaz. */
export function formatClientHeader(c: ClientInfo): string {
  let out = `mobile/${c.version}`;
  if (c.build !== null) out += `+${c.build}`;
  if (c.platform) out += ` (${c.platform})`;
  return out;
}

const HEADER_RE = /^mobile\/(\d+(?:\.\d+){0,2})(?:\+(\d+))?(?: \(([A-Za-z0-9._-]{1,32})\))?$/;

/** Bozuk ya da `mobile/` olmayan başlık için null. */
export function parseClientHeader(h: string | undefined | null): ClientInfo | null {
  if (typeof h !== 'string' || h.length > 100) return null;
  const m = HEADER_RE.exec(h.trim());
  if (!m) return null;
  return { kind: 'mobile', version: m[1]!, build: m[2] !== undefined ? Number(m[2]) : null, platform: m[3] ?? null };
}

function parts(v: string): number[] | null {
  if (!/^\d+(\.\d+){0,2}$/.test(v.trim())) return null;
  const nums = v.trim().split('.').map(Number);
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** Yalnız sayısal x.y.z karşılaştırır ("1.10.0" > "1.9.3", "1.1" = "1.1.0"). Bozuk girdi 0 sayılır (hiçbir şeyden büyük/küçük değil). */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `min` yoksa, bozuksa ya da sürüm bozuksa false: şüphede engellenmez. */
export function isBelowMinimum(version: string, min: string | null | undefined): boolean {
  if (!min || !parts(min) || !parts(version)) return false;
  return compareVersions(version, min) < 0;
}

/**
 * Sunucu ayarı (`MIN_MOBILE_VERSION`, `MOBILE_LATEST_VERSION`) için katı biçim: yalnız tam `x.y.z`. Değilse null.
 * Hesap servisi ve DeciShip API aynı kuralı kullanır: biri denetlerken öteki yok saymasın.
 */
export function strictVersion(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d+\.\d+\.\d+$/.test(s) ? s : null;
}

export type ClientPolicy = { mobile: { minVersion: string | null; latestVersion: string | null; updateUrl: string | null } };
