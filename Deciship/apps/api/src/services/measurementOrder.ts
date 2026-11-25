/**
 * KALANLAR 6.7 (B4.30): ölçüm anı ve aynı takip no'nun sürüm sırası.
 *
 * Telefon internetsizken ölçüm kuyrukta bekler; günler sonra gelen eski ölçüm, bu arada yapılmış daha yeni ölçümün yerine
 * geçmemeli (fatura yanlış ölçüyle karşılaştırılır, itiraz tutarı yanlış çıkar). Sıra ölçüm anıyla (`measuredAt`) belirlenir:
 * karşılaştırmanın ölçüm dizini de aynı alanla sıralar (`compare.ts` `MeasurementIndex`).
 *
 * Ölçüm anı cihaz saatidir; sunucu cihaz saati farkını düzeltir (`correctDeviceClock`) ve düzeltilmiş anı makul aralıkta kabul
 * eder (`measuredAtOutOfRange`); dışındaysa kayıt `400 MEASURED_AT_INVALID` ile reddedilir (telefonda "Hatalı").
 */
import type { Tx } from '../db.ts';

/** Gelecek için saat kayması payı: (düzeltilmiş) ölçüm anı sunucu saatinden en çok bu kadar ileride olabilir. */
export const MEASURED_AT_FUTURE_SKEW_MS = 15 * 60_000;
/** En eski kabul edilen ölçüm anı (şimdiden geriye): sıfırlanmış saat (1970, 2000 …) ayıklanır; uzun çevrimdışı bekleme geçer. */
export const MEASURED_AT_MAX_AGE_MS = 730 * 86_400_000;
/**
 * Bu kadarlık cihaz saati farkı düzeltilmez. Ölçülen fark gönderim süresini de içerir: ağ geçidi gövdeyi (fotoğraflar)
 * tamponlayıp sonra iletir, sunucunun alış anı yüklemeden sonradır (istemcinin isteği en çok 60 sn sürer). Bu süre ölçüm
 * anını ileri kaydırıp doğru yeniden ölçümü eski sürüme düşürmesin diye eşik yüklemeden çok büyük.
 */
export const CLOCK_OFFSET_IGNORE_MS = 10 * 60_000;

/**
 * Cihaz saatinin farkı (KALANLAR 6.7-b). İstemci gönderim anındaki kendi saatini (`sentAt`) yollar; sunucu isteği aldığı anla
 * (`receivedAt`, gövde okunmadan önce) farkı ölçer ve ölçüm anına ekler. Fark gönderim anında ölçüldüğü için kuyrukta günlerce
 * bekleyen kayıtta da doğrudur; saati 1970'e sıfırlanmış telefonun kaydı da gerçek ana taşınır. Ölçümle gönderim arasında
 * saat değiştiyse (ör. telefon saati kendini düzeltti) fark yakalanmaz. `sentAt` yoksa (eski uygulama) ham an kullanılır;
 * aralık dışındaysa alış anına çekilir (`clamped`, aşağıda).
 * Fark `CLOCK_OFFSET_IGNORE_MS`'den küçükse düzeltme yapılmaz. Düzeltildiyse ham an `deviceMeasuredAt` olarak saklanır.
 */
export function correctDeviceClock(measuredAt: Date, sentAt: Date | null, receivedAt: Date) {
  const known = sentAt != null && Number.isFinite(sentAt.getTime());
  if (!known) {
    // Eski uygulama (`sentAt` yok): kabul aralığı dışındaki an reddedilmez, alış anına çekilir (`clamped`). Eski sürüm
    // `MEASURED_AT_INVALID`'i tanımaz, reddi 10 dk'da bir fotoğraflarla yeniden gönderirdi; kayıt (kanıt) hiç yazılmazdı.
    // Alış anı gerçek anın üst sınırıdır; gerçek an bilinmez: çağıran bu kaydı güncel ölçümün yerine koymaz.
    if (measuredAtOutOfRange(measuredAt, receivedAt)) return { measuredAt: receivedAt, deviceMeasuredAt: measuredAt, offsetMs: null, clamped: true };
    return { measuredAt, deviceMeasuredAt: null, offsetMs: null, clamped: false };
  }
  const offsetMs = receivedAt.getTime() - sentAt.getTime();
  if (Math.abs(offsetMs) < CLOCK_OFFSET_IGNORE_MS) return { measuredAt, deviceMeasuredAt: null, offsetMs: null, clamped: false };
  return { measuredAt: new Date(measuredAt.getTime() + offsetMs), deviceMeasuredAt: measuredAt, offsetMs, clamped: false };
}

/**
 * Ölçüm anı kabul aralığının dışında mı? `past: false` yalnız gelecek sınırını uygular (yöneticinin düzeltmesi: gerçek ölçüm
 * anını geçmişe çekebilir, geleceğe alamaz).
 */
export function measuredAtOutOfRange(at: Date, now: Date, opts: { past?: boolean } = {}): boolean {
  const t = at.getTime();
  if (!Number.isFinite(t)) return true;
  if (t > now.getTime() + MEASURED_AT_FUTURE_SKEW_MS) return true;
  return opts.past !== false && t < now.getTime() - MEASURED_AT_MAX_AGE_MS;
}

/**
 * Gelen ölçüm güncel ölçümden eski mi (geç gelen kayıt)? Ölçüm anı hem güncel sürümün ölçüm anından hem sunucuya ulaştığı
 * andan (`createdAt`) önceyse geçtir (KALANLAR 6.7-c). İkinci koşul saati ileride telefonun kaydına güvenmez: ileri tarihli
 * güncel kayıt, ondan sonra yapılmış yeniden ölçümü eski sürüme düşüremez (bilinen ulaşma anı üst sınırdır). Eşit anda yeni
 * gelen kazanır. `replacesId`: istemci kontrol ekranında bu kaydı görüp bilerek yerine koydu; güncel sürümse saate bakılmaz.
 */
export function arrivesLate(at: Date, current: { id: string; measuredAt: Date; createdAt: Date }, replacesId?: string | null): boolean {
  if (replacesId && replacesId === current.id) return false;
  return at.getTime() < Math.min(current.measuredAt.getTime(), current.createdAt.getTime());
}

type ChainRow = { id: string; measuredAt: Date; version: number };

/**
 * Geç gelen ölçümün zincirdeki yeri. Zincir güncel sürümden geriye yürünür; ölçüm anı gelen kayıttan yeni olan sürümler
 * geçilir, ilk eşit ya da eski sürümde durulur. Gelen kayıt `successor`'ın hemen öncesine (ve `predecessor`'ın sonrasına)
 * girer; `newer` sürüm numarası bir artacak sürümler (`successor` dahil, güncel sürüme dek).
 *
 * Çağıran takip no kilidini (`lockTracking`) ve güncel sürümün satır kilidini (`lockCurrent`) tutar; zincirin eski
 * sürümleri de burada satır kilidi alır.
 */
export async function lateVersionPlace(tx: Tx, companyId: string, headId: string, at: Date) {
  const chain = await tx.$queryRaw<(ChainRow & { depth: number })[]>`
    WITH RECURSIVE ch("id", "measuredAt", "version", "depth") AS (
      SELECT m."id", m."measuredAt", m."version", 0 FROM "Measurement" m WHERE m."companyId" = ${companyId} AND m."id" = ${headId}
      UNION ALL
      SELECT v."id", v."measuredAt", v."version", ch."depth" + 1 FROM "Measurement" v JOIN ch ON v."supersededById" = ch."id"
      WHERE v."companyId" = ${companyId} AND ch."depth" < 1000
    )
    SELECT "id", "measuredAt", "version", "depth" FROM ch ORDER BY "depth"`;
  if (!chain.length) throw new Error('lateVersionPlace: current version not found');
  await tx.$queryRaw`SELECT "id" FROM "Measurement" WHERE "companyId" = ${companyId} AND "id" = ANY(${chain.map((c) => c.id)}::text[]) ORDER BY "id" FOR UPDATE`;
  let s = 0;
  while (s + 1 < chain.length && chain[s + 1]!.measuredAt.getTime() > at.getTime()) s++;
  const successor = chain[s]!;
  return {
    successorId: successor.id,
    predecessorId: chain[s + 1]?.id ?? null,
    /** gelen kaydın sürüm numarası: yerine geçtiği sürümünki */
    version: successor.version,
    newerIds: chain.slice(0, s + 1).map((c) => c.id),
  };
}

/**
 * Yeni yazılmış ya da geri yüklemede zincire alınan (silinmiş işaretli, bağsız: kısmi tekil dizine girmez) geç ölçümü
 * zincirdeki yerine bağlar, `arrivedLate` ve sürüm numarasını yazar. Sıra tekil
 * `supersededById` yüzünden önemlidir: önce önceki sürüm yeni kayda bağlanır (böylece `successor`'ı gösteren kalmaz), sonra
 * yeni kayıt `successor`'a bağlanıp işareti kalkar; en son daha yeni sürümlerin numarası bir artar.
 */
export async function linkLateVersion(tx: Tx, companyId: string, place: Awaited<ReturnType<typeof lateVersionPlace>>, newId: string) {
  if (place.predecessorId) await tx.measurement.update({ where: { id: place.predecessorId }, data: { supersededById: newId } });
  await tx.measurement.update({ where: { id: newId }, data: { supersededById: place.successorId, deletedAt: null, arrivedLate: true, version: place.version } });
  await tx.$executeRaw`UPDATE "Measurement" SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "companyId" = ${companyId} AND "id" = ANY(${place.newerIds}::text[])`;
}
