import { m, currentLocale } from '../i18n/index.ts';
import { invoiceHasMixedServices, isPakNote, tariffHealth, type HealthLineInput } from '@deciship/core';
import { prisma } from '../db.ts';
import { notFound } from '../errors.ts';
import { readSettings } from '../lib/settings.ts';
import { loadPricingTariff, readCompareSettings, readLinePricing } from './compare.ts';

/**
 * SPEC §3.9: faturanın tarife uyumu raporu. Satırlarda saklanan fiyat karşılaştırmasından (`InvoiceLine.pricing`)
 * kurulur; mükerrer ve pak/zarf satırları sayılmaz. Hiçbir satırda fiyat bilgisi yoksa (bu özellikten önce
 * karşılaştırılmış fatura) `stale: true` — "Yeniden karşılaştır" gerekir.
 *
 * Tarife bilgisi (yakıt oranı, değişken yakıt, hizmet, para birimi, ülke istisnaları) canlı tarifeden değil faturanın
 * hesaplandığı SÜRÜMDEN okunur: tarife sonradan değişse ya da silinse de rapor satırlardaki rakamlarla tutarlı kalır.
 * `tariff.id` sürümün tarifesidir; tarife silindiyse null (`removed: true`), ad sürümden gelir. Kur toleransı da faturanın
 * kayıtlı ayarındandır.
 */
export async function invoiceTariffHealth(invoiceId: string, companyId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId, deletedAt: null },
    select: {
      id: true,
      currency: true,
      tariffId: true,
      tariffRevisionId: true,
      compareSettings: true,
      carrier: { select: { name: true } },
      company: { select: { settings: true } },
    },
  });
  if (!inv) throw notFound(m('invoice.notFound'));
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId },
    select: { destCountry: true, service: true, pricing: true, diffTypes: true, note: true, currency: true, tariffId: true, tariffRevisionId: true },
  });
  // Faturanın sürümü. Dayanağı henüz yazılmamış faturada (dayanak yazmayan eski yolla açılmış): satırlarda en çok
  // kullanılan sürüm, o da yoksa satırların / faturanın tarifesinin bugünkü sürümü.
  const mostUsed = (ids: (string | null)[]) => {
    const counts = new Map<string, number>();
    for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  let revisionId: string | null = inv.tariffRevisionId ?? mostUsed(lines.map((l) => l.tariffRevisionId));
  if (!revisionId && inv.compareSettings == null) {
    const tariffId = mostUsed(lines.map((l) => l.tariffId)) ?? inv.tariffId;
    if (tariffId) revisionId = (await prisma.tariff.findFirst({ where: { id: tariffId, companyId }, select: { currentRevisionId: true } }))?.currentRevisionId ?? null;
  }
  const pricing = await loadPricingTariff(companyId, revisionId);
  const tariff = pricing
    ? {
        id: pricing.tariffId,
        name: pricing.name,
        currency: pricing.currency,
        fuelPct: pricing.input.fuelPct,
        fuelVariable: pricing.input.fuelVariable === true,
        service: pricing.input.service ?? null,
        countryAdjustments: pricing.input.countryAdjustments ?? [],
      }
    : null;

  const relevant = lines.filter((l) => !l.diffTypes.includes('DUPLICATE') && !isPakNote(l.note));
  const tariffCur = tariff?.currency.toUpperCase();
  const inputs: HealthLineInput[] = relevant.map((l) => {
    const p = readLinePricing(l.pricing);
    const cur = (l.currency ?? inv.currency ?? '').toUpperCase();
    return {
      destCountry: l.destCountry,
      service: l.service,
      zone: p?.zone ?? null,
      rateDeviationPct: p?.rateDeviationPct ?? null,
      adjustmentPct: p?.adjustmentPct ?? 0,
      fx: Boolean(tariffCur && cur && cur !== tariffCur),
      fuelPct: p?.fuelPct ?? null,
    };
  });
  const fxTolerancePct = readCompareSettings(inv.compareSettings)?.fxTolerancePct ?? readSettings(inv.company.settings).fxTolerancePct;
  const report = tariffHealth(inputs, {
    locale: currentLocale(),
    fxTolerancePct,
    carrierName: inv.carrier.name,
    tariffFuelPct: tariff ? tariff.fuelPct : null,
    tariffFuelVariable: tariff?.fuelVariable ?? false,
    tariffService: tariff?.service ?? null,
    // DENETIM-2 B1: karşılaştırmadaki kuralla aynı (faturanın tüm satırları)
    mixedServices: invoiceHasMixedServices(lines.map((l) => l.service)),
  });
  return {
    invoiceId: inv.id,
    carrierName: inv.carrier.name,
    tariff: tariff
      ? { id: tariff.id, name: tariff.name, currency: tariff.currency, countryAdjustments: tariff.countryAdjustments, removed: tariff.id == null, revisionId: pricing!.revisionId }
      : null,
    stale: relevant.length > 0 && relevant.every((l) => l.pricing == null),
    ...report,
  };
}

export type InvoiceTariffHealth = Awaited<ReturnType<typeof invoiceTariffHealth>>;
