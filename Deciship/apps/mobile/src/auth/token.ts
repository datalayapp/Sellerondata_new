/**
 * Erişim jetonundan oturum kapsamını okur. İmza burada doğrulanmaz (sunucunun işi): amaç, elimizdeki jetonun
 * hangi kişi + firma adına istek yapacağını kesin bilmek. Kuyruk bu kapsama göre gönderir.
 */
export type SessionScope = { personId: string; orgId: string };

export type TokenClaims = {
  sub: string;
  org: string | null;
  ep: number;
  prod: unknown;
  /** Veriliş ve son geçerlilik anı (sn, sunucu saati). Yalnız gönderimden önce yenileme için; yoksa yok sayılır. */
  iat?: number;
  exp?: number;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url → tek bayt dizgi. UTF-8 çözülmez: JSON yapısı ASCII'dir, ad gibi alanların baytları dizgi içinde kalır
 * ve geçerli JSON'u bozmaz. Yalnız ASCII alanlar (sub, org, ep) okunur.
 */
function decodeSegment(segment: string): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const ch of segment) {
    if (ch === '=') break;
    const index = B64.indexOf(ch);
    if (index < 0) throw new Error('invalid base64url');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return out;
}

export function decodeClaims(token: string | null | undefined): TokenClaims | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(decodeSegment(payload)) as { sub?: unknown; org?: unknown; ep?: unknown; prod?: unknown; iat?: unknown; exp?: unknown };
    if (typeof parsed.sub !== 'string' || !parsed.sub) return null;
    const claims: TokenClaims = {
      sub: parsed.sub,
      org: typeof parsed.org === 'string' && parsed.org ? parsed.org : null,
      ep: typeof parsed.ep === 'number' ? parsed.ep : 0,
      prod: parsed.prod ?? null,
    };
    if (typeof parsed.iat === 'number' && Number.isFinite(parsed.iat)) claims.iat = parsed.iat;
    if (typeof parsed.exp === 'number' && Number.isFinite(parsed.exp)) claims.exp = parsed.exp;
    return claims;
  } catch {
    return null;
  }
}

export function scopeFromClaims(claims: TokenClaims | null): SessionScope | null {
  return claims?.org ? { personId: claims.sub, orgId: claims.org } : null;
}

export function sameScope(a: SessionScope | null | undefined, b: SessionScope | null | undefined): boolean {
  return !!a && !!b && a.personId === b.personId && a.orgId === b.orgId;
}

/** Önbellek anahtarı ve React bağımlılığı için. */
export function scopeKey(scope: SessionScope | null | undefined): string | null {
  return scope ? `${scope.personId}:${scope.orgId}` : null;
}

/** Yetki değişti mi? Değiştiyse profil yeniden okunur. */
export function claimsSignature(claims: TokenClaims | null): string {
  return claims ? JSON.stringify([claims.sub, claims.org, claims.ep, claims.prod]) : '';
}
