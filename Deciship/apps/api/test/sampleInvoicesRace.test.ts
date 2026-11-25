/**
 * Bağımsız inceleme (Mesaj 4, 02-B1): deneme turu ve demo tohumunun faturası (`importDemoInvoice`) da gerçek içe aktarma
 * gibi ölçümleri kilitten önce okur. Bu arada kaydedilen ölçüm faturaya yansımalı: yazım işlemi içe aktarma kilidini alır,
 * ölçüm kümesini yeniden okur ve fatura yazıldıktan sonra yeniden karşılaştırır.
 *
 * Kanca: dosya saklama (`storeBuffer`), karşılaştırma ile yazım işlemi arasında çağrılır.
 */
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { importDemoInvoice, sampleInvoice } from '../src/services/sampleInvoices.ts';
import { createWorker, getApp, inCompany, measurementPayload, registerCompany, uniq } from './helpers.ts';

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, reached: null as (() => void) | null }));
vi.mock('../src/lib/storage.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/storage.ts')>();
  return {
    ...orig,
    storeBuffer: async (...args: Parameters<typeof orig.storeBuffer>) => {
      if (gate.hold) {
        const h = gate.hold;
        gate.hold = null;
        gate.reached?.();
        await h;
      }
      return orig.storeBuffer(...args);
    },
  };
});

const API = '/api/deciship';
/** `samples/invoices/fedex-9-482-11735.csv` içindeki ilk gönderi */
const TRACKING = '794812345305';

describe('deneme faturası yüklenirken kaydedilen ölçüm', () => {
  it('karşılaştırma ile yazım arasında kaydedilen ölçüm satıra yansır; ölçümün işareti boşalır', async () => {
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Deneme yarışı '));
    const worker = await createWorker(app, admin.auth);
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx') } });
    expect(c.statusCode, c.body).toBe(201);
    const companyId = admin.companyId as string;
    const ownerId = await inCompany(companyId, async () => (await prisma.member.findFirstOrThrow({ where: { companyId }, select: { id: true }, orderBy: { createdAt: 'asc' } })).id);

    let release!: () => void;
    const reached = new Promise<void>((r) => (gate.reached = r));
    gate.hold = new Promise<void>((r) => (release = r));
    let pending: ReturnType<typeof importDemoInvoice> | undefined;
    let id = '';
    try {
      pending = inCompany(companyId, () => importDemoInvoice(companyId, sampleInvoice('fedex-9-482-11735'), '2026-10-27', ownerId));
      await reached; // ölçümler okundu ve karşılaştırıldı, fatura henüz yazılmadı
      const p = measurementPayload({ trackingRaw: TRACKING, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, r.body).toBe(201);
      id = r.json().measurement.id as string;
    } finally {
      gate.hold = null;
      gate.reached = null;
      release();
    }
    const imported = await pending!;
    const line = await inCompany(companyId, () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: imported.id, trackingNo: TRACKING }, select: { measurementId: true } }));
    expect(line.measurementId).toBe(id);
    const flag = await inCompany(companyId, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);
    expect(flag).toBeNull();
  });
});
