import { importJWK, type JWK } from 'jose';

/**
 * Hesap'ın açık anahtarları için önbellek.
 *
 * jose'nin `createRemoteJWKSet`i kullanılmadı: önbellek süresi dolunca getirme başarısızsa doğrulamayı da düşürüyor.
 * Burada kural şudur:
 * - Bilinen `kid`: önbellekten yanıt ver, süresi geçtiyse arkada tazele. Hesap kısa süre kesilirse açık oturumlar çalışır (ARCHITECTURE §5).
 * - Azami yaş (`maxStaleMs`, varsayılan 1 saat): son başarılı getirmenin üstünden bu kadar geçtiyse önbellek güvenilmez,
 *   tazelenemezse 503. Hesap kesikken yeni jeton basılamadığı için (ömür 10 dk) bu pencere açık oturumları düşürmez;
 *   iptal edilmiş anahtarın süresiz geçerli kalmasını önler.
 * - Bilinmeyen `kid`: hemen tazele (anahtar döndürme). Sahte `kid` yağmuru `cooldownMs` ile saniyede en fazla bir getirmeye iner.
 *   Bu kısa aralıkta bilinmeyen `kid` 401 alır: istemci yeniler, 5xx alarmı üretmez, yeni anahtarın önü kapanmaz.
 * - Getirme başarısızsa `failureBackoffMs` boyunca yeniden denenmez, bilinmeyen `kid` 503 alır: oturum kapanmaz, kesik servis yorulmaz.
 * - Başarılı tazelemede listeden çıkan anahtar önbellekten de çıkar (anahtar iptali). Başarısız tazeleme önbelleği bozmaz.
 * - Ürün Hesap kesikken yeniden başlarsa önbellek boştur: Hesap dönene kadar tüm istekler 503 alır.
 */

/** Anahtar şu an doğrulanamıyor. Oturum kusuru değil: 503 döner, istemci oturumu kapatmaz. */
export class JwksUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JwksUnavailableError';
  }
}

/** Taze listede bu `kid` yok: jeton bizim imzamız değil. `kid` saldırgan girdisi: metne çevrilmez. */
export class UnknownKeyError extends Error {
  constructor() {
    super('bilinmeyen anahtar');
    this.name = 'UnknownKeyError';
  }
}

export type JwksClient = {
  getKey: (protectedHeader: { kid?: unknown; alg?: string }) => Promise<CryptoKey>;
  /** Şimdi tazele. Başarısızsa fırlatır, önbellek korunur. */
  refresh: () => Promise<void>;
  /** Önbellekteki `kid` listesi (izleme ve test). */
  knownKids: () => string[];
};

export type JwksClientOptions = {
  url: string;
  /** Sınama için. Varsayılan genel `fetch`. */
  fetch?: typeof fetch;
  /** Bu süreden eski önbellek arkada tazelenir. Varsayılan 10 dk. */
  refreshAfterMs?: number;
  /** Başarılı getirmeden sonra bilinmeyen `kid` için en az bekleme. Varsayılan 1 sn. */
  cooldownMs?: number;
  /** Başarısız getirmeden sonra yeniden deneme beklemesi. Varsayılan 5 sn. */
  failureBackoffMs?: number;
  /** Önbelleğin azami yaşı. Aşılırsa tazelenemeyen anahtar kullanılmaz. Varsayılan 1 saat. */
  maxStaleMs?: number;
  /** Tek getirme için zaman aşımı. Varsayılan 3 sn. */
  timeoutMs?: number;
  onRefreshError?: (err: unknown) => void;
};

export function createJwksClient(opts: JwksClientOptions): JwksClient {
  const refreshAfterMs = opts.refreshAfterMs ?? 10 * 60_000;
  const cooldownMs = opts.cooldownMs ?? 1_000;
  const failureBackoffMs = opts.failureBackoffMs ?? 5_000;
  const maxStaleMs = opts.maxStaleMs ?? 60 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const doFetch = opts.fetch ?? fetch;

  let keys = new Map<string, CryptoKey>();
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastSuccessAt = Number.NEGATIVE_INFINITY;
  let lastFailed = false;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<void> {
    // Yönlendirme izlenmez: bir sızma veya yanlış ayar anahtar kaynağını başka adrese taşıyamasın.
    const res = await doFetch(opts.url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new JwksUnavailableError(`JWKS getirilemedi: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: JWK[] };
    if (!Array.isArray(body.keys)) throw new JwksUnavailableError('JWKS yanıtı geçersiz');

    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys) {
      // Yalnız beklenen tür. Listeye başka algoritma karışsa bile doğrulamaya girmez.
      if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
      if (jwk.use && jwk.use !== 'sig') continue;
      const { d: _private, ...publicJwk } = jwk;
      try {
        next.set(jwk.kid, (await importJWK(publicJwk, 'EdDSA')) as CryptoKey);
      } catch (err) {
        // Tek bozuk anahtar diğerlerini düşürmez.
        opts.onRefreshError?.(err);
      }
    }
    // Boş liste arıza sayılır: bir yanlış yanıt tüm oturumları düşürmesin.
    if (next.size === 0) throw new JwksUnavailableError('JWKS boş');
    keys = next;
    lastSuccessAt = Date.now();
  }

  function refresh(): Promise<void> {
    if (!inFlight) {
      lastAttemptAt = Date.now();
      inFlight = load()
        .then(
          () => {
            lastFailed = false;
          },
          (err) => {
            lastFailed = true;
            throw err;
          },
        )
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  function inWaitPeriod(now: number): boolean {
    return now - lastAttemptAt < (lastFailed ? failureBackoffMs : cooldownMs);
  }

  function backgroundRefresh() {
    const now = Date.now();
    if (now - lastSuccessAt < refreshAfterMs || inWaitPeriod(now)) return;
    refresh().catch((err) => opts.onRefreshError?.(err));
  }

  return {
    refresh,
    knownKids: () => [...keys.keys()],
    async getKey(header) {
      const kid = header.kid;
      if (typeof kid !== 'string' || !kid) throw new UnknownKeyError();
      const known = keys.get(kid);
      const now = Date.now();
      if (known && now - lastSuccessAt <= maxStaleMs) {
        backgroundRefresh();
        return known;
      }
      if (!inFlight && inWaitPeriod(now)) {
        if (lastFailed || known) throw new JwksUnavailableError('anahtar tazeleme bekleme süresinde');
        throw new UnknownKeyError();
      }
      try {
        await refresh();
      } catch (err) {
        opts.onRefreshError?.(err);
        throw new JwksUnavailableError('JWKS getirilemedi', { cause: err });
      }
      const fresh = keys.get(kid);
      if (!fresh) throw new UnknownKeyError();
      return fresh;
    },
  };
}
