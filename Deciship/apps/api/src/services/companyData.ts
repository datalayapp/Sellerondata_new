/**
 * Şirketin verisini sıfırlama ve örnek veri yükleme. Uç yalnız ENABLE_DATA_RESET=true iken açıktır
 * (ARCHITECTURE §11); seed betiği de kullanır.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeTracking } from '@deciship/core';
import { REPO_ROOT, env } from '../env.ts';
import { prisma } from '../db.ts';
import { loadMemberAccess, memberPermissions } from '../lib/access.ts';
import { absolutePath } from '../lib/storage.ts';
import { packagingOf } from '../lib/packaging.ts';
import { lockCurrent, lockTracking } from './measurementLocks.ts';
import { createTariff, tariffBody } from './tariffs.ts';

type SeedCarrier = { code: string; name: string; tariffs: Record<string, unknown>[] };
type SeedMeasurement = {
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  dimMethod: 'LIDAR' | 'AR' | 'REFERENCE' | 'MANUAL' | 'PRESET';
  weightMethod: 'OCR' | 'MANUAL';
  measuredAt: string;
  boxPreset?: string;
  ocrWeightKg?: number;
  dimConfidence?: number;
  note?: string;
  /** Ambalaj; eski örnek dosyasında yok: kendi ambalajı (OWN). */
  packaging?: 'OWN' | 'PAK' | 'ENVELOPE';
};

function readJson<T>(rel: string): T | null {
  const p = path.join(REPO_ROOT, 'samples', rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

/** Built-in fallback used only when samples/seed-tariffs.json is missing (SPEC §5.10). */
function fallbackCarriers(): SeedCarrier[] {
  const fedexA = [
    650, 724.53, 799.06, 873.59, 948.12, 1022.65, 1097.18, 1171.71, 1246.24, 1320.77, 1395.3, 1469.83, 1527.75,
  ];
  const rates: { zone: string; weightUpto: number; price: number }[] = [];
  for (let i = 1; i <= 60; i++) {
    const w = i * 0.5;
    const a = fedexA[i - 1] ?? Math.round((1527.75 + (w - 6) * 120) * 100) / 100;
    rates.push({ zone: 'A', weightUpto: w, price: a });
    rates.push({ zone: 'B', weightUpto: w, price: Math.round(a * 1.18 * 100) / 100 });
    rates.push({ zone: 'D', weightUpto: w, price: Math.round(a * 1.55 * 100) / 100 });
  }
  return [
    {
      code: 'fedex',
      name: 'FedEx',
      tariffs: [
        {
          name: 'FedEx International Economy 2026',
          service: 'International Economy',
          currency: 'TRY',
          divisor: 5000,
          edgeRounding: 'CEIL_CM',
          weightSteps: [
            { upto: 20, step: 0.5 },
            { upto: null, step: 1 },
          ],
          discountPct: 38,
          fuelPct: 25,
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
          active: true,
          isDefault: true,
          zones: ['FR', 'DE', 'NL'].map((c) => ({ country: c, zone: 'A' })).concat(
            [{ country: 'GB', zone: 'B' }],
            ['US', 'CA'].map((c) => ({ country: c, zone: 'D' })),
          ),
          rates,
          overflow: [],
          surcharges: [],
        },
      ],
    },
    {
      code: 'aras',
      name: 'Aras Kargo',
      tariffs: [
        {
          name: 'Aras Desi 2026',
          currency: 'TRY',
          divisor: 3000,
          edgeRounding: 'CEIL_CM',
          weightSteps: [{ upto: null, step: 1 }],
          discountPct: 0,
          fuelPct: 0,
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
          active: true,
          isDefault: true,
          zones: [{ country: '*', zone: 'TR' }],
          rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: 90 + i * 12.5 })),
          overflow: [{ zone: 'TR', perUnit: 12.5 }],
          surcharges: [],
        },
      ],
    },
  ];
}

/**
 * Şirketin tüm iş verisini siler: faturalar, ölçümler (fotoğraflarıyla), taşıyıcılar, tarifeler ve tarife
 * içe aktarma artıkları, yapay zekâ sonuç önbelleği, arka plan işleri. Hesaplar, şirket adı, ayarlar ve hazır koli ölçüleri korunur.
 * Yapay zekâ kullanımı (`AiUsage`) ve kredi defteri (`AiCreditEntry`) bilerek silinmez: veri sıfırlama kotayı sıfırlamaz.
 */
export async function clearCompanyData(companyId: string): Promise<{ invoices: number; measurements: number; carriers: number }> {
  const files = await prisma.file.findMany({ where: { companyId }, select: { path: true } });
  const counts = await prisma.$transaction(async (tx) => {
    // Arka plan işleri önce: dosyaya ve tarifeye bağlı iş kalmasın. Süren işin bitiş yazımı satırı bulamaz (kira kaybı sayılır).
    await tx.job.deleteMany({ where: { companyId } });
    const invoices = await tx.invoice.deleteMany({ where: { companyId } }); // satırlar cascade
    await tx.file.deleteMany({ where: { companyId } });
    const measurements = await tx.measurement.deleteMany({ where: { companyId } });
    await tx.tariffDocument.deleteMany({ where: { companyId } });
    await tx.tariffImportDraft.deleteMany({ where: { companyId } });
    await tx.aiResultCache.deleteMany({ where: { companyId } });
    await tx.tariffVersion.deleteMany({ where: { companyId } });
    await tx.tariff.deleteMany({ where: { companyId } }); // bölge, fiyat, ek ücret cascade
    // Fiyat sürümleri en son: onları gösteren faturalar ve tarifeler (currentRevisionId) önce silinmiş olmalı (NO ACTION, 23503).
    await tx.tariffRevision.deleteMany({ where: { companyId } });
    const carriers = await tx.carrier.deleteMany({ where: { companyId } });
    return { invoices: invoices.count, measurements: measurements.count, carriers: carriers.count };
  });
  // Diskteki dosyalar (fotoğraf, fatura, tarife PDF'i) veritabanı silindikten sonra; hata sıfırlamayı bozmaz.
  for (const f of files) await fsp.rm(absolutePath(f.path), { force: true }).catch(() => {});
  await fsp.rm(path.join(path.resolve(env.storageDir), companyId), { recursive: true, force: true }).catch(() => {});
  return counts;
}

const sampleCarriers = () => readJson<SeedCarrier[]>('seed-tariffs.json') ?? fallbackCarriers();

/** Örnek taşıyıcıların kodları, `loadSampleData`'nın yükleme sırasıyla (deneme turu kimlikleri bu sırayla önceden üretir). */
export function sampleCarrierCodes(): string[] {
  return sampleCarriers().map((c) => c.code);
}

/**
 * Örnek taşıyıcılar, tarifeler ve ölçümler (samples/seed-*.json). Şirkette taşıyıcı yokken çağrılır
 * (önce `clearCompanyData`). Ölçümler firmanın ilk ölçüm çalışanına, yoksa `fallbackUserId`'ye, o da yoksa ilk üyeye yazılır.
 * `clientIdPrefix` (deneme turu, `services/demoTour.ts`): örnek ölçümün `clientId`'si bu önekle başlar; deneme bitince yalnız
 * bu önekli ölçümler silinir. Önek verilince gerçek (öneksiz) güncel ölçümü olan takip numarasına örnek yazılmaz (`createSampleMeasurement`).
 * `carrierIds` (deneme turu): taşıyıcılar bu kimliklerle, `sampleCarrierCodes()` sırasıyla açılır; deneme bitince yalnız
 * bunlar silinir. Sayı tutmazsa hiçbir şey yazılmadan hata.
 */
export async function loadSampleData(
  companyId: string,
  opts: { fallbackUserId?: string; log?: (s: string) => void; clientIdPrefix?: string; carrierIds?: readonly string[] } = {},
): Promise<{ carriers: number; tariffs: number; measurements: number }> {
  const log = opts.log ?? (() => {});
  const carriersData = sampleCarriers();
  if (opts.carrierIds && opts.carrierIds.length !== carriersData.length) throw new Error('Örnek taşıyıcı kimlikleri örnek taşıyıcılarla eşleşmiyor');
  const measurementsData = readJson<SeedMeasurement[]>('seed-measurements.json') ?? [];
  if (!readJson('seed-tariffs.json')) log('samples/seed-tariffs.json bulunamadı, yerleşik tarifeler kullanılıyor');

  // Rol adına değil üyenin geçerli izinlerine bakılır (özel roller): ölçüm yapan ama ölçümleri yönetmeyen ilk üye.
  const members = await loadMemberAccess(companyId);
  const measurer = members.find((m) => {
    const held = memberPermissions(m);
    return held.includes('deciship.measurements.capture') && !held.includes('deciship.measurements.manage');
  });
  const measuredById = measurer?.id ?? opts.fallbackUserId ?? members[0]?.id;
  if (!measuredById) throw new Error('Şirkette üye yok');
  const presets = await prisma.boxPreset.findMany({ where: { companyId } });

  let tariffs = 0;
  for (const [i, c] of carriersData.entries()) {
    const id = opts.carrierIds?.[i];
    const carrier = await prisma.carrier.create({ data: { ...(id ? { id } : {}), companyId, code: c.code, name: c.name } });
    for (const t of c.tariffs) {
      await createTariff(companyId, tariffBody.parse({ ...t, carrierId: carrier.id }));
      tariffs++;
    }
    log(`Taşıyıcı ${c.name}: ${c.tariffs.length} tarife`);
  }

  // Oldest first so re-measured tracking numbers become versions.
  const sorted = [...measurementsData].sort((a, b) => +new Date(a.measuredAt) - +new Date(b.measuredAt));
  let measurements = 0;
  for (const m of sorted) if (await createSampleMeasurement(companyId, measuredById, m, presets, opts.clientIdPrefix)) measurements++;
  log(`${measurements} ölçüm eklendi`);
  return { carriers: carriersData.length, tariffs, measurements };
}

/**
 * Örnek ölçüm; aynı takip numarasının güncel ölçümü varsa yeni sürümü olur. `clientIdPrefix` verilince (deneme turu) güncel
 * ölçüm öneksizse (gerçek ölçüm) hiçbir şey yazılmaz ve false döner: gerçek ölçüm örneğin eski sürümü olup deneme bitince
 * zincirden kopmasın.
 */
export async function createSampleMeasurement(
  companyId: string,
  measuredById: string,
  m: SeedMeasurement,
  presets: { id: string; name: string }[],
  clientIdPrefix?: string,
): Promise<boolean> {
  const trackingNo = normalizeTracking(m.trackingRaw);
  return prisma.$transaction(async (tx) => {
  // Ölçüm ucuyla aynı sıra (`services/measurementLocks.ts`): araya gelen gerçek ölçüm ya da düzeltme beklenir, zincir bölünmez.
  await lockTracking(tx, companyId, [trackingNo]);
  await lockCurrent(tx, companyId, trackingNo);
  const prev = await tx.measurement.findFirst({ where: { companyId, trackingNo, supersededById: null, deletedAt: null } });
  if (clientIdPrefix && prev && !prev.clientId.startsWith(clientIdPrefix)) return false;
  const created = await tx.measurement.create({
    data: {
      companyId,
      clientId: `${clientIdPrefix ?? ''}${crypto.randomUUID()}`,
      trackingRaw: m.trackingRaw,
      trackingNo,
      lengthCm: m.lengthCm,
      widthCm: m.widthCm,
      heightCm: m.heightCm,
      weightKg: m.weightKg,
      dimMethod: m.dimMethod,
      weightMethod: m.weightMethod,
      ocrWeightKg: m.ocrWeightKg ?? (m.weightMethod === 'OCR' ? m.weightKg : null),
      dimConfidence: m.dimConfidence ?? null,
      boxPresetId: m.boxPreset ? (presets.find((p) => p.name === m.boxPreset)?.id ?? null) : null,
      packaging: packagingOf(m.packaging),
      measuredById,
      measuredAt: new Date(m.measuredAt),
      note: m.note ?? null,
      version: prev ? prev.version + 1 : 1,
      // Kısmi tekil dizin: eski sürüm bağlanana kadar yeni satır dizine girmez (routes/measurements.ts).
      deletedAt: prev ? new Date() : null,
    },
  });
  if (prev) {
    await tx.measurement.update({ where: { id: prev.id }, data: { supersededById: created.id } });
    await tx.measurement.update({ where: { id: created.id }, data: { deletedAt: null } });
  }
  return true;
  });
}
