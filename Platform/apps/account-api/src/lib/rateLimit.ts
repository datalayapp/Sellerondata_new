import { prisma } from '../db.ts';
import { AppError } from '../errors.ts';
import { sha256 } from './crypto.ts';
import { ipBucket } from './identity.ts';

/** Sınır tanımı: `limit` istek, `windowSeconds` pencerede. */
export type RateRule = { limit: number; windowSeconds: number };

const MIN = 60;
const HOUR = 60 * MIN;

/**
 * Kişi + IP ikilisi dar: aynı yerden deneme. Kişi tek başına geniş: dağıtık saldırı. IP tek başına geniş: depoda aynı NAT arkasında
 * çok çalışan olabilir. Kişi anahtarı sınırı kurbanı kilitleyebilir, bu yüzden ikiliden gevşektir.
 */
export const RATE_RULES = {
  // Kullanıcı isteği 2026-11-13: pencere 15 dk → 5 dk (beklemek en çok 5 dk). Günlük kişi tavanı (loginPersonDay) korur.
  loginPair: { limit: 10, windowSeconds: 5 * MIN },
  loginIdentity: { limit: 30, windowSeconds: 5 * MIN },
  loginIp: { limit: 100, windowSeconds: 15 * MIN },
  /** Dolu kimlik/kişi kovasını bilinen cihaz istisnasıyla geçen denemeler: istisnanın da tavanı var. */
  loginKnownDevice: { limit: 30, windowSeconds: 5 * MIN },
  /**
   * Kişi başına günlük tavan (04-B6): birçok IP'den 15 dakikalık kovaları doldurmadan günde binlerce tahmin yapılamasın.
   * Dolu kovada da bilinen cihaz geçer (kişi kendi ağından kilitlenmez); "şifremi unuttum" ile şifreyi yenileyen kişinin
   * kovaları boşalır (`clearPersonLoginBuckets`). Yalnız başarısız denemeler kalır (önce say, başarıda geri ver).
   */
  loginPersonDay: { limit: 100, windowSeconds: 24 * HOUR },
  /** Giriş kilidi bilgi postası: kişi başına günde en çok bir. */
  loginLockMail: { limit: 1, windowSeconds: 24 * HOUR },
  /** Yönetim yazma uçları, yapan yönetici başına (03-B9): üye güncelleme ve çıkarma, firma ayarı, davet iptali. */
  orgAdminWrite: { limit: 120, windowSeconds: 15 * MIN },
  registerIp: { limit: 5, windowSeconds: HOUR },
  forgotIdentity: { limit: 3, windowSeconds: HOUR },
  forgotIp: { limit: 20, windowSeconds: HOUR },
  resetIp: { limit: 20, windowSeconds: 15 * MIN },
  joinPair: { limit: 10, windowSeconds: 5 * MIN },
  joinIp: { limit: 30, windowSeconds: 15 * MIN },
  inviteTokenIp: { limit: 30, windowSeconds: 15 * MIN },
  passwordConfirm: { limit: 10, windowSeconds: 15 * MIN },
  orgInvite: { limit: 100, windowSeconds: HOUR },
  /** `personExists` taraması: davet firma başına sınırlı, yeni firmaya sıkı (§11). */
  phoneInvite: { limit: 20, windowSeconds: HOUR },
  phoneInviteNewOrg: { limit: 10, windowSeconds: HOUR },
  emailInvite: { limit: 30, windowSeconds: HOUR },
  emailInviteNewOrg: { limit: 10, windowSeconds: HOUR },
  /** Alıcı başına: aşınca posta gitmez, davet yine açılır. Kurban başkasını engelleyemez, spam da gitmez. */
  inviteRecipient: { limit: 5, windowSeconds: 24 * HOUR },
  orgCreatePerson: { limit: 5, windowSeconds: HOUR },
  orgCreateIp: { limit: 20, windowSeconds: HOUR },
  /**
   * Tanıtım sitesinin "kimim" yoklaması: her sayfa açılışı, sekmeye dönüş ve geri gelişte bir istek. Cömert, çünkü aynı
   * NAT arkasında çok kişi gezinebilir; amaç yalnız veritabanını taşkından korumak. Aşınca site "giriş yapılmamış" gösterir.
   */
  siteSessionIp: { limit: 600, windowSeconds: 15 * MIN },
  /** Doğrulama postasını yeniden isteme: IP geniş, kimlik dar (aşınca sessiz). */
  verifyResendIp: { limit: 20, windowSeconds: HOUR },
  verifyResendIdentity: { limit: 3, windowSeconds: HOUR },
  /** Kişi başına doğrulama postası. */
  verifyMailPerson: { limit: 5, windowSeconds: HOUR },
  /** Davet eden kişi başına davet postası. */
  inviteMailPerson: { limit: 50, windowSeconds: 24 * HOUR },
} as const satisfies Record<string, RateRule>;

/** Tek SQL deyimi: atomik sayaç. Pencere bitmişse sıfırdan başlar. `count` bu istekle birlikte penceredeki sayıdır. */
export async function hitRateLimit(key: string, rule: RateRule): Promise<{ count: number; retryAfter: number }> {
  const rows = await prisma.$queryRaw<{ count: number; retry_after: number }[]>`
    INSERT INTO "platform"."RateBucket" ("key", "count", "windowEnd")
    VALUES (${key}, 1, now() + make_interval(secs => ${rule.windowSeconds}::double precision))
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateBucket"."windowEnd" <= now() THEN 1 ELSE "RateBucket"."count" + 1 END,
      "windowEnd" = CASE
        WHEN "RateBucket"."windowEnd" <= now() THEN now() + make_interval(secs => ${rule.windowSeconds}::double precision)
        ELSE "RateBucket"."windowEnd"
      END
    RETURNING "count", CEIL(EXTRACT(EPOCH FROM ("windowEnd" - now())))::int AS retry_after`;
  const row = rows[0];
  return { count: Number(row.count), retryAfter: Math.max(1, Number(row.retry_after)) };
}

export function identityKey(identity: string): string {
  return sha256(identity).slice(0, 32);
}

/**
 * Kovaları verilen sırada sayar, ilk dolan kovada 429 ve sonrakilere YAZMAZ. Sıra çağıranın sorumluluğudur: dolu bir kova
 * arkasındaki kovaları doldurmasın diye dar ve saldırganın elindeki kova (IP, kimlik + IP ikilisi) önce gelir; kurbanı
 * kilitleyebilecek geniş kova (kimlik, kişi) en sona kalır. Girişteki kimlik ve kişi kovası bu işlevle değil,
 * `hitRateLimit` + `refundRateLimit` ile sayılır (ARCHITECTURE §11). Bilinmeyen kimlik de aynı kovayı doldurur: yanıt varlığı ele vermez.
 */
export async function enforceRateLimit(buckets: { key: string; rule: RateRule }[]): Promise<void> {
  for (const { key, rule } of buckets) {
    const result = await hitRateLimit(key, rule);
    if (result.count > rule.limit) throw new AppError(429, 'TOO_MANY_ATTEMPTS', undefined, result.retryAfter);
  }
}

/** Sayar, sınırı aştıysa false. Reddetmek yerine işlevi kısmak için (posta). */
export async function consumeRateLimit(key: string, rule: RateRule): Promise<boolean> {
  return (await hitRateLimit(key, rule)).count <= rule.limit;
}

export async function clearRateLimit(keys: string[]): Promise<void> {
  await prisma.rateBucket.deleteMany({ where: { key: { in: keys } } });
}

/**
 * "Önce say, başarıda geri ver": `hitRateLimit` ile sayılan bir denemenin payı geri verilir. Net sayı yalnız başarısız denemelerdir.
 * Önce bakıp sonra saymak paralel isteklerde sınırı delerdi; sayaç atomik artar, geri verme de atomik azaltır. Sıfırın altına inmez.
 */
export async function refundRateLimit(key: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "platform"."RateBucket" SET "count" = GREATEST("count" - 1, 0)
    WHERE "key" = ${key} AND "windowEnd" > now()`;
}

/** Kişinin şifre denemesi kovaları: 15 dakikalık (`login:person`) ve günlük (`login:day`). */
export const personLoginKey = (personId: string) => `login:person:${personId}`;
export const personLoginDayKey = (personId: string) => `login:day:${personId}`;

/**
 * Şifre yenilenince (bağlantıyla ya da yöneticinin koduyla) kişinin giriş kovaları boşalır (04-B6): yenileme posta kutusunu ya da
 * yöneticiyi kanıtlar, eski şifreye yapılan tahminlerin anlamı kalmaz. Kilitlenen meşru kişinin kendi başına çıkış yolu budur.
 * Kişinin bugünkü kimliklerinin (e-posta, telefon) kimlik kovaları da boşalır; kimlik + IP kovaları (saldırganın elindeki dar kova)
 * kalır.
 */
export async function clearPersonLoginBuckets(personId: string, identities: (string | null | undefined)[] = []): Promise<void> {
  const ids = identities.filter((v): v is string => !!v).map((v) => `login:id:${identityKey(v)}`);
  await clearRateLimit([personLoginKey(personId), personLoginDayKey(personId), `login:known:${personId}`, ...ids]);
}

/**
 * Şifre sınamasının kişi kovaları (giriş dışındaki yollar: davet kabulü, ilk doğrulama; bilinen cihaz istisnası yok): 15 dakikalık
 * ve günlük kova önce atomik sayılır, dolu kovada 429. Dönen anahtarlar şifre doğruysa `refundRateLimit` ile geri verilir.
 */
export async function hitPersonPasswordBuckets(personId: string): Promise<string[]> {
  const counted: string[] = [];
  for (const [key, rule] of [
    [personLoginKey(personId), RATE_RULES.loginIdentity],
    [personLoginDayKey(personId), RATE_RULES.loginPersonDay],
  ] as const) {
    const { count, retryAfter } = await hitRateLimit(key, rule);
    counted.push(key);
    if (count > rule.limit) throw new AppError(429, 'TOO_MANY_ATTEMPTS', undefined, retryAfter);
  }
  return counted;
}

/** Bilinen cihaz: son 90 güne ait, iptal edilmemiş en yeni 100 giriş satırından biri aynı IP biriminden (IPv6'da /64) açılmış. */
export const KNOWN_DEVICE_DAYS = 90;
export const KNOWN_DEVICE_ROWS = 100;

/**
 * Kişinin daha önce oturum açtığı ağdan mı geliyor? Dolu kimlik kovası kurbanı kendi ağından kilitlemesin diye.
 * Kişi yoksa da aynı sorgu çalışır (`personId` null): süre farkı varlığı ele vermesin.
 */
export async function isKnownDevice(personId: string | null, ip: string): Promise<boolean> {
  const bucket = ipBucket(ip);
  // Yalnız ailenin ilk satırı (şifreyle ya da kodla açılan oturum; `createSession` iki sütuna aynı değeri yazar) ve iptal edilmemiş
  // aileler: çalınmış yenileme jetonunu başka IP'den döndüren hırsız o IP'yi bilinen cihaz yapamaz, kapatılan oturum da sayılmaz.
  const rows = await prisma.$queryRaw<{ ip: string | null }[]>`
    SELECT "ip" FROM "platform"."Session"
    WHERE "personId" = ${personId ?? ''}
      AND "createdAt" = "familyCreatedAt"
      AND "revokedAt" IS NULL
      AND "createdAt" > now() - make_interval(days => ${KNOWN_DEVICE_DAYS}::int)
    ORDER BY "createdAt" DESC
    LIMIT ${KNOWN_DEVICE_ROWS}`;
  return rows.some((r) => r.ip !== null && ipBucket(r.ip) === bucket);
}
