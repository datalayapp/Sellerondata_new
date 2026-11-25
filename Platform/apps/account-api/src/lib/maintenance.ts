import { prisma } from '../db.ts';
import { purgeDueOrgs } from './orgClosure.ts';
import { LIFECYCLE_EVENT_TYPES } from './outbox.ts';

const DAY = 24 * 60 * 60_000;

/** Teslim edilmemiş (bekleyen ya da DEAD) teslimi olan firma yaşam döngüsü olayı. */
const undeliveredLifecycle = { type: { in: [...LIFECYCLE_EVENT_TYPES] }, deliveries: { some: { status: { not: 'DELIVERED' as const } } } };

/** Süresi geçmiş kayıtları temizler. Saatte bir çalışır, birden çok kopyada da zararsızdır. */
type MaintenanceLog = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export async function runMaintenance(now = new Date(), log?: MaintenanceLog) {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  await prisma.rateBucket.deleteMany({ where: { windowEnd: { lt: now } } });
  await prisma.session.deleteMany({ where: { expiresAt: { lt: ago(7) } } });
  await prisma.oneTimeToken.deleteMany({ where: { expiresAt: { lt: ago(7) } } });
  await prisma.invitation.deleteMany({ where: { expiresAt: { lt: ago(30) } } });
  // Firma yaşam döngüsü olayı bırakılmaz (dağıtıcı onu DEAD yapmaz). Eski sürümün ya da elle DEAD yapılmış olanı yeniden kuyruğa
  // girer: kaçan `org.purged` araçta silinmiş firmanın verisini, kaçan `org.reopened` firmayı kapalı bırakır.
  const revived = await prisma.outboxDelivery.updateMany({
    where: { status: 'DEAD', outbox: { type: { in: [...LIFECYCLE_EVENT_TYPES] } } },
    data: { status: 'PENDING', nextAttemptAt: new Date() },
  });
  if (revived.count > 0) log?.warn({ count: revived.count }, 'DEAD org lifecycle deliveries requeued');
  const dead = await prisma.outboxDelivery.count({ where: { status: 'DEAD' } });
  if (dead > 0) {
    // Üyelik olayı (Y146): araç kaydı geride. Askıdan dönen çalışanı araç bir sonraki jetonuyla kendisi açar (DeciShip ve product-kit
    // `syncMember`, KALANLAR 6.10; çıkarılan üye açılmaz); ürün projeksiyonu (ad, rol listesi) o girişe dek eski kalır.
    const deadMembers = await prisma.outboxDelivery.count({ where: { status: 'DEAD', outbox: { type: { startsWith: 'member.' } } } });
    log?.warn(
      { dead, deadMembers },
      `${dead} olay teslim edilemedi (DEAD), ${deadMembers} tanesi üyelik olayı (araç kaydı çalışanın bir sonraki girişinde jetondan eşitlenir; DeciShip ve product-kit araçları, çıkarılan üye hariç). Ürün projeksiyonu geride. Kurtarma: node dist/outbox-requeue.js (geliştirmede npm run outbox:requeue)`,
    );
  }

  // Silinmeden önce iz bırakılır: düşen olay sessizce kaybolmasın.
  const purgedDead = await prisma.outbox.findMany({
    where: { createdAt: { lt: ago(30) }, deliveries: { some: { status: 'DEAD' }, none: { status: 'PENDING' } }, NOT: undeliveredLifecycle },
    select: { id: true, type: true },
  });
  if (purgedDead.length > 0) {
    await prisma.auditLog.create({
      data: { action: 'outbox.dead_purged', meta: { count: purgedDead.length, sample: purgedDead.slice(0, 50) } },
    });
    log?.error({ count: purgedDead.length }, 'teslim edilemeyen olaylar saklama süresi dolduğu için silindi');
  }
  // Bekleyen teslimi olan olay silinmez; teslim edilmemiş yaşam döngüsü olayı hiç silinmez.
  await prisma.outbox.deleteMany({
    where: { createdAt: { lt: ago(30) }, deliveries: { none: { status: 'PENDING' } }, NOT: undeliveredLifecycle },
  });
  await prisma.mailLog.deleteMany({ where: { createdAt: { lt: ago(30) } } });
  // Araç bildirimi izi (Mesaj 14): tekrar anahtarı ve 24 saat tavanı yalnız yakın geçmişe bakar; 30 günden eskisi gereksiz.
  await prisma.productNotice.deleteMany({ where: { createdAt: { lt: ago(30) } } });
  // Kapatılmış ve saklama süresi (`ORG_PURGE_DAYS`) dolmuş firmalar kalıcı silinir. Firma başına ayrı
  // işlem; hata veren firma sonraki turda yeniden denenir, öbürleri durmaz.
  // Süre veritabanı saatiyle karşılaştırılır (`now` değil): kapatma anı da veritabanı saatinden yazıldı.
  const orgs = await purgeDueOrgs(log);
  if (orgs.purged.length) log?.warn({ count: orgs.purged.length, orgIds: orgs.purged }, 'saklama süresi dolan kapalı firmalar kalıcı silindi');
}

export function startMaintenance(log?: MaintenanceLog) {
  const run = () => {
    runMaintenance(new Date(), log).catch((err) => log?.error({ err }, 'bakım turu başarısız'));
  };
  // Açılışta da: sık yeniden başlayan süreçte saatlik tur hiç gelmeyebilir.
  run();
  const timer = setInterval(run, 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
