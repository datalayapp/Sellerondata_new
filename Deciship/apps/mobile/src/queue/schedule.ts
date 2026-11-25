/**
 * Kuyruk gönderiminin zamanlaması (11-B1, 11-B17). Saf mantık: `QueueContext` yalnız bunu çağırır, testler aynısını sınar.
 *
 * Sorun: sunucu 503 dönerken zamanlayıcı her 15 sn'de bütün bekleyen kayıtları fotoğraflarıyla yeniden yüklüyordu (G1).
 * Kural:
 * - Sunucu ya da ağ sorunu turu durdurur (`runFlush`) ve burada genel bir bekleme kurar. Bekleme üstel büyür, üst sınırlıdır;
 *   başarılı ilk gönderimde sıfırlanır.
 * - Zamanlayıcı, kayıt, Bugün'e dönüş ve arka plana geçiş beklemeye uyar.
 * - Uygulama öne gelince bekleme atlanır, bir kez hemen denenir (tur ilk sunucu hatasında durduğu için en çok bir yükleme).
 * - Elle "Gönder" ve ağın geri gelmesi beklemeyi atlar, hatalıları da dener (bugünkü kural).
 * - Sunucunun açık "şu kadar bekle" isteği (`retry-after`, ör. 429) hiçbir tetikle atlanmaz; en çok `RETRY_AFTER_CAP_MS`.
 * - Güncelleme gerekiyorsa (426) hiçbir gönderim yok; yetki engelinde (`pausedUntil`) yalnız elle ve ağ dönüşünde denenir.
 */

/** Gönderimi başlatan olay. */
export type FlushTrigger =
  /** Kayıt, düzeltme, Geri al, oturum değişimi, Bugün'e dönüş, arka plana geçiş. */
  | 'auto'
  /** 15 sn'lik zamanlayıcı (uygulama öndeyken). */
  | 'timer'
  /** Uygulama öne geldi: bekleme atlanır, bir kez denenir. */
  | 'foreground'
  /** Ağ geri geldi. */
  | 'online'
  /** Elle "Gönder" ya da aşağı çekip yenileme. */
  | 'manual';

export type ServerBackoff = {
  /** Arka arkaya başarısız tur sayısı (sunucu ya da ağ). */
  failures: number;
  /** Bu ana dek otomatik gönderim yok. */
  until: number;
  /** Sunucunun açıkça istediği bekleme (`retry-after`): hiçbir tetik atlamaz. */
  hardUntil: number;
};

export const NO_BACKOFF: ServerBackoff = { failures: 0, until: 0, hardUntil: 0 };

/** Sunucu hatasında ilk bekleme; her başarısız turda iki katı. */
export const SERVER_BASE_MS = 15_000;
/** Sunucu hatasında en uzun bekleme. */
export const SERVER_MAX_MS = 10 * 60_000;
/** Ağ hatasında ilk bekleme ve üst sınır: ağ dönünce zaten hemen denenir, kısa tutulur. */
export const NETWORK_BASE_MS = 5_000;
export const NETWORK_MAX_MS = 60_000;
/** `retry-after` en çok bu kadar uyulur: bozuk ya da çok uzun başlık kuyruğu saatlerce kilitlemesin. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** ±%15 dağılım: sunucu toparlanırken bütün telefonlar aynı saniyede gelmesin. `random` 0..1. */
export function backoffMs(failures: number, kind: 'server' | 'network', random: () => number = Math.random): number {
  const base = kind === 'server' ? SERVER_BASE_MS : NETWORK_BASE_MS;
  const max = kind === 'server' ? SERVER_MAX_MS : NETWORK_MAX_MS;
  const exp = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (0.85 + random() * 0.3));
}

export type FlushPlan =
  | { run: false; why: 'blocked' | 'retryAfter' | 'paused' | 'backoff' }
  | {
      run: true;
      /** Hatalı (ERROR) kayıtlar da denensin. */
      includeErrors: boolean;
      /** Kayıt başına bekleme süresi (`nextAttemptAt`) atlansın. */
      ignoreRowBackoff: boolean;
    };

export type GateState = {
  /** Güncelleme gerekiyor (426). */
  blocked: boolean;
  /** Yetki ya da sunucu ayarı engeli (`PAUSE_MS`). */
  pausedUntil: number;
  backoff: ServerBackoff;
};

/** Yetki engelinin en uzun süresi (`flush.ts` `PAUSE_MS` ile aynı; döngüsel içe aktarma olmasın diye burada). */
const MAX_PAUSE_MS = 5 * 60_000;
/** Dağılımla birlikte en uzun genel bekleme. */
const MAX_UNTIL_MS = Math.ceil(SERVER_MAX_MS * 1.15);

/**
 * Bekleme anı `now`dan en uzun süresinden daha ileride ise telefon saati geri alınmıştır: bekleme yok sayılır, kuyruk saat
 * yetişene dek takılı kalmaz.
 */
function active(until: number, now: number, max: number): boolean {
  return now < until && until - now <= max;
}

export function nextFlushPlan(trigger: FlushTrigger, now: number, s: GateState): FlushPlan {
  if (s.blocked) return { run: false, why: 'blocked' };
  if (active(s.backoff.hardUntil, now, RETRY_AFTER_CAP_MS)) return { run: false, why: 'retryAfter' };
  if (trigger === 'manual' || trigger === 'online') return { run: true, includeErrors: true, ignoreRowBackoff: true };
  if (active(s.pausedUntil, now, MAX_PAUSE_MS)) return { run: false, why: 'paused' };
  if (trigger === 'foreground') return { run: true, includeErrors: false, ignoreRowBackoff: true };
  if (active(s.backoff.until, now, MAX_UNTIL_MS)) return { run: false, why: 'backoff' };
  return { run: true, includeErrors: false, ignoreRowBackoff: false };
}

/**
 * Turu durduran sorun. `server`: 5xx, ağ geçidi, hesap servisine ulaşılamadı. `rateLimit`: 429 (hız sınırı; sunucu ne zaman
 * geleceğimizi `retry-after` ile söyler). `network`: bağlantı yok ya da zaman aşımı.
 */
export type Trouble = { kind: 'server' | 'rateLimit' | 'network'; retryAfterMs: number | null };

/** Tur bir sorunla durdu: yeni bekleme. Sorun ancak gönderime izin verilmişken olur, yani önceki `hardUntil` geçmiştir. */
export function afterTrouble(prev: ServerBackoff, now: number, t: Trouble, random: () => number = Math.random): ServerBackoff {
  const hard = t.retryAfterMs != null && t.retryAfterMs > 0 ? now + Math.min(t.retryAfterMs, RETRY_AFTER_CAP_MS) : 0;
  // Hız sınırı süresini söyledi: büyük kuyruk boşalırken olağan durum, üstel büyütme gerekmez.
  if (t.kind === 'rateLimit' && hard) return { failures: prev.failures, until: hard, hardUntil: hard };
  const kind = t.kind === 'network' ? 'network' : 'server';
  const failures = prev.failures + 1;
  // `retry-after` kısa olsa da (ör. veritabanı kesintisinde 3 sn) bekleme üstel büyür: kesinti sürdükçe yükleme seyrekleşir.
  return { failures, until: Math.max(hard, now + backoffMs(failures, kind, random)), hardUntil: hard };
}

/** Bir kayıt gönderildi: sunucu ayakta, bekleme kalkar. */
export function afterSuccess(): ServerBackoff {
  return NO_BACKOFF;
}

/**
 * `QueueContext`in tuttuğu durum. Saf işlevlerin üstünde ince bir kabuk: sağlayıcı ve testler aynı nesneyi kullanır.
 */
export function createFlushGate(random: () => number = Math.random) {
  let backoff: ServerBackoff = NO_BACKOFF;
  let pausedUntil = 0;
  return {
    plan(trigger: FlushTrigger, now: number, blocked: boolean): FlushPlan {
      return nextFlushPlan(trigger, now, { blocked, pausedUntil, backoff });
    },
    trouble(now: number, t: Trouble): void {
      backoff = afterTrouble(backoff, now, t, random);
    },
    success(): void {
      backoff = afterSuccess();
    },
    pause(until: number): void {
      pausedUntil = until;
    },
    /** Oturum ya da yazma hakkı değişti, güncelleme kalktı: engel kalkar. Sunucu beklemesi de sıfırlanır (bir deneme). */
    reset(): void {
      pausedUntil = 0;
      backoff = NO_BACKOFF;
    },
    get state(): { backoff: ServerBackoff; pausedUntil: number } {
      return { backoff, pausedUntil };
    },
  };
}

export type FlushGate = ReturnType<typeof createFlushGate>;
