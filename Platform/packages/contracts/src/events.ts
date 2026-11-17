import type { OrgRole, ProductKey } from './catalog.ts';

/**
 * Hesap → ürün olayları. Ed25519 imzalı JWT (aud: EVENT_AUDIENCE), gövde `{ token }`.
 * Ürün `POST /api/<ürün>/internal/events` ile alır, `eventId` ile idempotenttir.
 * Sıra garantisi yoktur: alıcı `epoch` küçükse yok sayar.
 */
export type PlatformEvent =
  | {
      eventId: string;
      type: 'member.upserted';
      orgId: string;
      product: ProductKey;
      membershipId: string;
      personId: string;
      name: string;
      orgRole: OrgRole;
      /** Üründeki rol, null ise erişim yok. Hazır rol anahtarı ya da `custom:<uuid>`. */
      role: string | null;
      /**
       * Rolün firmadaki geçerli izinleri (özel ya da düzenlenmiş hazır rol). Alıcı katalogla kesişimini saklar.
       * Yoksa eski biçim olaydır: alıcı izinleri `role`'den katalogla türetir (DeciShip `Member.permissions` null).
       */
      permissions?: string[];
      active: boolean;
      epoch: number;
    }
  | {
      eventId: string;
      type: 'member.removed';
      orgId: string;
      product: ProductKey;
      membershipId: string;
      epoch: number;
      /** Tanınmayan üye için pasif kayıt açılabilsin diye (sıra garantisi yok). */
      personId?: string;
      name?: string;
    }
  | {
      eventId: string;
      type: 'org.updated';
      orgId: string;
      product: ProductKey;
      name: string;
      /**
       * Firmanın para birimi (`Organization.currency`). Her `org.updated` o anki değeri taşır, firma açılışındaki ilk olay dahil.
       * Yoksa eski biçim olaydır: alıcı kendi değerine dokunmaz. Adla aynı sürüm koşuluyla yazılır.
       */
      currency?: OrgCurrency;
      /**
       * Firmanın ülkesi (`Organization.country`, ISO-2). Para birimiyle aynı kural: her olay o anki değeri taşır, yoksa eski biçim
       * olaydır, alıcı kendi değerine dokunmaz. Ürün ülkeye bağlı kuralı (Türk Ticaret Kanunu süresi) buna göre uygular.
       */
      country?: string;
      /**
       * Firmanın saat dilimi (`Organization.timeZone`, `TIME_ZONES`'tan). Olay o anki değeri taşır; tek istisna varsayılan
       * (`DEFAULT_ORG_TIME_ZONE`): göçten kalan firmada seçilmiş değil, yalnız firma açılışında ve saat dilimini değiştiren PATCH'te
       * söylenir, yeniden duyurularda ve başka alanın değişiminde gönderilmez. Alan yoksa alıcı kendi değerine dokunmaz.
       * Hesap dayanağına girmez (günlük sayı, son gün, hatırlatma saati).
       */
      timeZone?: string;
      /**
       * Firma bilgileri Merkez'de onaylandı mı (`Organization.companyConfirmedAt !== null`; Merkez kurulumunun zorunlu adımı). Her olay o
       * anki değeri taşır, firma açılışındaki ilk olay (`false`) ve yeniden duyurular dahil. Yoksa eski biçim olaydır: alıcı kendi değerine
       * dokunmaz. Onay sürümü artırır. Araç kendi kurulumunun firma koşulunu buna bağlar (DeciShip `settings.companyConfirmed`).
       */
      companyConfirmed?: boolean;
      /** Firmanın sürümü, ad, para birimi, ülke, saat dilimi, firma onayı, kapatma veya geri açma her değiştiğinde artar. Küçük sürüm uygulanmaz: eski değer yenisini ezmesin. */
      version?: number;
    }
  | {
      /**
       * Sahip firmayı kapattı (`POST /org/close`). Ekip (sahip dahil) firmaya ve araçlara giremez; açık
       * oturumlar epoch artışıyla zaten düşer (`member.upserted`). Araç firmayı kapalı işaretler, uçlarını `ORG_CLOSED` ile kapatır, arka
       * plan işlerini durdurur. Veri `purgeAfter`a kadar durur; sahip bu sürede geri açabilir (`org.reopened`), süre dolunca `org.purged`.
       */
      eventId: string;
      type: 'org.closed';
      orgId: string;
      product: ProductKey;
      /** ISO an. */
      closedAt: string;
      /** ISO an: bu andan sonra firma kalıcı silinir (`org.purged` gelir). */
      purgeAfter: string;
      /**
       * Firmanın sürümü (`org.updated.version` ile aynı sayaç): kapatma ve geri açma da artırır. Sıra garantisi yok: alıcı kapalılık
       * durumunu bu sürümle saklar, saklı sürümden küçük ya da eşit sürümlü `org.closed`/`org.reopened` uygulanmaz.
       */
      version: number;
    }
  | {
      /** Sahip kapalı firmayı saklama süresi içinde geri açtı: her şey kapanıştan önceki gibi. Sürüm kuralı `org.closed` ile aynı. */
      eventId: string;
      type: 'org.reopened';
      orgId: string;
      product: ProductKey;
      version: number;
    }
  | {
      /**
       * Saklama süresi doldu, firma Hesap'ta silindi (geri dönmez). Araç firmanın bütün verisini ve dosyalarını kalıcı siler. Sürümü yok:
       * son olaydır, her durumda uygulanır; tekrar gelirse zararsızdır. Sonra gelen (gecikmiş) başka olay firmayı yeniden kurmamalıdır.
       */
      eventId: string;
      type: 'org.purged';
      orgId: string;
      product: ProductKey;
    }
  | {
      eventId: string;
      type: 'subscription.updated';
      orgId: string;
      product: ProductKey;
      status: 'ACTIVE' | 'READ_ONLY' | 'CANCELED';
      plan: string;
      /** Aboneliğin sürümü, her değişimde artar. Eski CANCELED yeni ACTIVE'i ezmesin. */
      version?: number;
    };

export type PlatformEventType = PlatformEvent['type'];

/** Olay jetonunun gövdesi. `jti == event.eventId`. `occurredAt`: olayın yazıldığı an (imza anı değil). */
export type EventClaims = {
  iss: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  occurredAt: string;
  event: PlatformEvent;
};

/** Firma para birimleri (Hesap > Şirket'te seçilebilenler). */
export const ORG_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;
export type OrgCurrency = (typeof ORG_CURRENCIES)[number];

/** Firma açılışında ülkeden gelen para birimi: TR→TRY, DE/NL/FR→EUR, GB→GBP, diğerleri→USD. */
export function currencyForCountry(country: string): OrgCurrency {
  switch (country.toUpperCase()) {
    case 'TR':
      return 'TRY';
    case 'DE':
    case 'NL':
    case 'FR':
      return 'EUR';
    case 'GB':
      return 'GBP';
    default:
      return 'USD';
  }
}
