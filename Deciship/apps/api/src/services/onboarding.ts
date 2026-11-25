/**
 * İlk kurulum sihirbazı (web: /kurulum). İlerleme şirket ayarlarında (`settings.onboarding`) saklanır;
 * kontrol listesi (taşıyıcı, tarife, hazır koli, örnek faturalar = `Invoice.isSample`) her istekte veritabanından türetilir.
 */
import { prisma, Prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import {
  companyConfirmedOf,
  DEFAULT_BOX_PRESETS,
  DEFAULT_SETTINGS,
  firmCountry,
  LEGACY_EDGE_TOL_CM,
  ONBOARDING_REQUIRED,
  readOnboarding,
  readSettings,
  type CompanySettings,
  type OnboardingState,
  type OnboardingStep,
} from '../lib/settings.ts';

export type OnboardingPatch = {
  step?: OnboardingStep;
  done?: OnboardingStep;
  skipped?: OnboardingStep;
  complete?: boolean;
  dismissBanner?: boolean;
};

const MEASURE_RULES = ['edgeTolCm', 'weightTolKg', 'desiDivisor', 'requiredBoxPhotos'] as const satisfies readonly (keyof CompanySettings)[];

/**
 * Ölçüm kuralı varsayılandan değişmiş mi. Kenar toleransında iki varsayılan var: yeni firmanınki (`DEFAULT_SETTINGS`, 0,5)
 * ve kayıtlı değeri olmayan ya da 2026-11-14'ten önce açılmış firmanınki (`LEGACY_EDGE_TOL_CM`, 1). İkisi de "dokunulmadı":
 * yoksa her eski firma hiçbir şey yapmadan "Ölçüm kuralları hazır" görünür.
 */
function ruleChanged(settings: CompanySettings, k: (typeof MEASURE_RULES)[number]): boolean {
  if (k === 'edgeTolCm') return settings.edgeTolCm !== DEFAULT_SETTINGS.edgeTolCm && settings.edgeTolCm !== LEGACY_EDGE_TOL_CM;
  return settings[k] !== DEFAULT_SETTINGS[k];
}

export type SetupFacts = {
  activeCarriers: number;
  activeTariffs: number;
  measurements: number;
  invoices: number;
  presetsReady: boolean;
  rulesReady: boolean;
  /** Firma bilgileri Merkez'de onaylı mı (`companyConfirmedOf`). Merkez overview'da adım değildir: Merkez kendi panelinde gösterir. */
  companyConfirmed: boolean;
};

type PresetRow = { name: string; lengthCm: unknown; widthCm: unknown; heightCm: unknown; active: boolean };

/** Firmanın kolileri hâlâ açılışta verilen K1-K3 mü: ad, ölçü ve durum aynı, eksik ya da fazla yok. */
function presetsUntouched(rows: PresetRow[]): boolean {
  return (
    rows.length === DEFAULT_BOX_PRESETS.length &&
    rows.every((r) =>
      r.active &&
      DEFAULT_BOX_PRESETS.some((d) => d.name === r.name && d.lengthCm === Number(r.lengthCm) && d.widthCm === Number(r.widthCm) && d.heightCm === Number(r.heightCm)),
    )
  );
}

/** Kurulum adımlarının dayandığı veri. Sayılar "var mı" içindir: en çok 1. */
export async function setupFacts(companyId: string, settings: CompanySettings): Promise<SetupFacts> {
  const [activeCarriers, activeTariffs, invoices, measurements, presets] = await Promise.all([
    prisma.carrier.count({ where: { companyId, active: true }, take: 1 }),
    prisma.tariff.count({ where: { companyId, active: true }, take: 1 }),
    prisma.invoice.count({ where: { companyId, deletedAt: null, isSample: false }, take: 1 }),
    prisma.measurement.count({ where: { companyId, deletedAt: null }, take: 1 }),
    prisma.boxPreset.findMany({ where: { companyId }, select: { name: true, lengthCm: true, widthCm: true, heightCm: true, active: true } }),
  ]);
  // Varsayılan kurallarla çalışan firma da hazırdır: sihirbazda onayladıysa ya da ölçüm yapmaya başladıysa.
  const rulesReady = Boolean(readOnboarding(settings.onboarding).done?.includes('olcum')) || measurements > 0 || MEASURE_RULES.some((k) => ruleChanged(settings, k));
  // Yeni firmaya K1-K3 örnek açılır: kendiliğinden tamamlamaz. Onay, kullanım ya da değişiklik gerekir; etkin koli de olmalı.
  const confirmed = Boolean(readOnboarding(settings.onboarding).done?.includes('koliler'));
  // Kullanım sorgusu dizinsizdir, firmanın ölçümlerini tarayabilir: yalnız sonucu belirleyecekse çalışır (/me her istekte buradan geçer).
  const decidedWithoutUse = confirmed || !presetsUntouched(presets);
  const presetUse = decidedWithoutUse ? 0 : await prisma.measurement.count({ where: { companyId, deletedAt: null, boxPresetId: { not: null } }, take: 1 });
  const presetsReady = presets.some((p) => p.active) && (decidedWithoutUse || presetUse > 0);
  return { activeCarriers, activeTariffs, measurements, invoices, presetsReady, rulesReady, companyConfirmed: companyConfirmedOf(settings) };
}

/**
 * Tek tanım. Kurulum tamam: firma bilgileri Merkez'de onaylı VE (sihirbaz tamamlandı ya da zorunlu adımların hepsi veride:
 * taşıyıcı, tarife, ölçüm kuralları, ilk ölçüm, ilk fatura). Onay yoksa sihirbaz "tamamlandı" denmiş olsa da tamam değildir.
 * `/me`, `/settings/onboarding`, Merkez `setup` ve web menü etiketi bunu okur.
 */
export function onboardingFlags(state: OnboardingState, facts: SetupFacts) {
  const allRequired = facts.activeCarriers > 0 && facts.activeTariffs > 0 && facts.rulesReady && facts.measurements > 0 && facts.invoices > 0;
  const completed = facts.companyConfirmed && (Boolean(state.completedAt) || allRequired);
  return {
    completed,
    /** Tamamlanmamış ve hiç taşıyıcı yok: giriş sonrası /kurulum'a yönlendirilir. */
    required: !completed && facts.activeCarriers === 0,
    /** Pano'daki "Kurulumu tamamlayın" bandı. Taşıyıcısı olan eski şirketlere, sihirbazı hiç açmadılarsa gösterilmez. */
    showBanner: !completed && !state.bannerDismissedAt && (facts.activeCarriers === 0 || Boolean(state.startedAt)),
  };
}

/**
 * Firmada iş verisi var mı: taşıyıcı ya da tarife (etkin ya da pasif), fatura (örnek ve silinmiş dahil) ya da silinmemiş ölçüm.
 * Örnek veriyle deneme yalnız `false` iken açılır (`services/demoTour.ts`): deneme bitince bütün taşıyıcılar, tarifeler ve
 * faturalar silinir, bu yüzden başlarken hiçbiri olmamalı. `db`: açık işlem (kilit altında) ya da `prisma`.
 */
export async function companyHasData(companyId: string, db: Pick<Tx, 'carrier' | 'tariff' | 'invoice' | 'measurement'> = prisma): Promise<boolean> {
  if ((await db.carrier.count({ where: { companyId }, take: 1 })) > 0) return true;
  if ((await db.tariff.count({ where: { companyId }, take: 1 })) > 0) return true;
  if ((await db.invoice.count({ where: { companyId }, take: 1 })) > 0) return true;
  return (await db.measurement.count({ where: { companyId, deletedAt: null }, take: 1 })) > 0;
}

export async function onboardingStatus(companyId: string) {
  const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
  const settings = readSettings(company.settings);
  const state = readOnboarding(settings.onboarding);
  const facts = await setupFacts(companyId, settings);
  // Mesaj 14 §4.3: deneme açık mı, açılabilir mi (sunucuda kapalı değil, açık değil, firma boş).
  const demoActive = Boolean(settings.demo);
  const demoAvailable = env.demoTourEnabled && !demoActive && !(await companyHasData(companyId));
  const [carriers, boxPresets, invoices] = await Promise.all([
    prisma.carrier.findMany({
      where: { companyId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { tariffs: { select: { id: true, name: true, active: true, isDefault: true }, orderBy: { name: 'asc' } } },
    }),
    prisma.boxPreset.count({ where: { companyId, active: true } }),
    // örnek faturalar (kurulumda yüklenen, listede görünmeyen)
    prisma.invoice.findMany({
      where: { companyId, isSample: true, deletedAt: null },
      include: { carrier: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
  ]);
  // tarifeden önce yüklenen örnek faturalar: hiçbir tarifeyle hesaplanmamış satır sayısı (tarife eklenince sihirbaz yeniden karşılaştırır)
  const untariffed = invoices.length
    ? await prisma.invoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoices.map((i) => i.id) }, tariffId: null }, _count: { _all: true } })
    : [];
  const untariffedBy = new Map(untariffed.map((g) => [g.invoiceId, g._count._all]));
  return {
    state,
    ...onboardingFlags(state, facts),
    demo: { active: demoActive, available: demoAvailable },
    boxPresetsReady: facts.presetsReady,
    requiredSteps: ONBOARDING_REQUIRED,
    // DeciShip'teki kopya (tek kaynak Merkez): panel Merkez `/me` yoksa bunu gösterir. `confirmed` kurulumun ön şartı.
    company: { name: company.name, currency: settings.currency, country: firmCountry(company), timeZone: settings.timeZone, confirmed: companyConfirmedOf(settings) },
    carriers: carriers.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      active: c.active,
      tariffs: c.tariffs,
      activeTariffCount: c.tariffs.filter((t) => t.active).length,
    })),
    boxPresets,
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
      currency: i.currency,
      carrier: i.carrier,
      totals: i.totals,
      createdAt: i.createdAt,
      linesWithoutTariff: untariffedBy.get(i.id) ?? 0,
    })),
  };
}

const uniq = <T>(a: T[]) => [...new Set(a)];

export async function patchOnboarding(companyId: string, p: OnboardingPatch): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // satır kilidi: aynı anda gelen iki güncelleme birbirinin ilerlemesini ezmesin
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
    const company = await tx.company.findFirstOrThrow({ where: { id: companyId } });
    const settings = readSettings(company.settings);
    const s = readOnboarding(settings.onboarding);
    const now = new Date().toISOString();
    const next: OnboardingState = { ...s, startedAt: s.startedAt ?? now };
    if (p.step) next.step = p.step;
    if (p.done) {
      next.done = uniq([...(s.done ?? []), p.done]);
      next.skipped = (s.skipped ?? []).filter((x) => x !== p.done);
    }
    if (p.skipped) {
      next.skipped = uniq([...(next.skipped ?? s.skipped ?? []), p.skipped]);
      next.done = (next.done ?? s.done ?? []).filter((x) => x !== p.skipped);
    }
    if (p.complete === true) next.completedAt = now;
    if (p.complete === false) next.completedAt = null;
    if (p.dismissBanner) next.bannerDismissedAt = now;
    await tx.company.update({
      where: { id: companyId },
      data: { settings: { ...settings, onboarding: next } as unknown as Prisma.InputJsonValue },
    });
  });
}

/** Veri sıfırlama ya da örnek veriden sonra kurulumun yeni hâli: örnek veri tamamlanmış sayar, sıfırlama baştan açar. */
export function onboardingAfterDataReset(settings: CompanySettings, samples: boolean): OnboardingState {
  return samples ? { ...readOnboarding(settings.onboarding), completedAt: new Date().toISOString() } : {};
}

/**
 * GEÇİCİ (deneme dönemi) veri işlemleriyle ve örnek veriyle deneme turuyla birlikte çağrılır: "Sistemi sıfırla" ve
 * "Denemeyi bitir" kurulumu baştan başlatır, "Örnek verileri yükle" ve deneme başlangıcı kurulumu tamamlanmış sayar.
 * Deneme turu aynı kuralı kendi kilitli işleminde `onboardingAfterDataReset` ile uygular.
 */
export async function setOnboardingAfterDataReset(companyId: string, samples: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
    const company = await tx.company.findFirstOrThrow({ where: { id: companyId } });
    const settings = readSettings(company.settings);
    const onboarding = onboardingAfterDataReset(settings, samples);
    await tx.company.update({
      where: { id: companyId },
      data: { settings: { ...settings, onboarding } as unknown as Prisma.InputJsonValue },
    });
  });
}
