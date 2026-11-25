import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { prisma } from '../src/db.ts';
import { createWorker, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

export function tariffPayload(carrierId: string, over: Record<string, unknown> = {}) {
  return {
    carrierId,
    name: uniq('Tarife '),
    currency: 'TRY',
    divisor: 3000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 1 }],
    discountPct: 0,
    fuelPct: 0,
    active: true,
    isDefault: true,
    zones: [{ country: '*', zone: 'TR' }],
    rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * 10 })),
    overflow: [{ zone: 'TR', perUnit: 10 }],
    surcharges: [{ code: 'FUEL', name: 'Yakıt', kind: 'PCT', amount: 10 }],
    ...over,
  };
}

/** Bir şirketin tüm kayıt türlerinden birer tane. */
export async function companyFixture(app: FastifyInstance) {
  const admin = await registerCompany(app, uniq('Şirket '));
  const worker = await createWorker(app, admin.auth);
  const carrier = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'aras', name: 'Aras' } });
  const carrierId = carrier.json().carrier.id as string;
  const tariff = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: admin.auth, payload: tariffPayload(carrierId) });
  expect(tariff.statusCode, tariff.body).toBe(201);
  const tariffId = tariff.json().tariff.id as string;
  // PUT bir sürüm (TariffVersion) bırakır
  const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${tariffId}`, headers: admin.auth, payload: tariffPayload(carrierId, { name: 'Değişti' }) });
  expect(put.statusCode, put.body).toBe(200);
  const versions = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: admin.auth });
  const versionId = versions.json().items[0].id as string;

  // çalışanın ölçümü (fotoğraflı) — 30×20×15 / 3000 = 3 desi
  const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const m = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload });
  expect(m.statusCode, m.body).toBe(201);
  const measurement = m.json().measurement as { id: string; trackingNo: string; clientId: string };
  const photo = await inCompany(admin.auth, () => prisma.file.findFirstOrThrow({ where: { measurementId: measurement.id } }));

  // fatura: ölçülen takip no + ölçülmemiş bir satır
  const csv = ['Takip No;Desi;Tutar', `${measurement.trackingNo};5;50`, `${uniq('9')};3;30`].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const fileId = preview.json().fileId as string;
  const inv = await app.inject({
    method: 'POST',
    url: '/api/deciship/invoices',
    headers: admin.auth,
    payload: {
      fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const invoiceId = inv.json().invoice.id as string;
  const lines = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: admin.auth });
  const lineId = lines.json().items[0].id as string;

  const presets = await app.inject({ method: 'GET', url: '/api/deciship/box-presets', headers: admin.auth });
  const presetId = presets.json().items[0].id as string;

  const draft = await inCompany(admin.auth, () =>
    prisma.tariffImportDraft.create({
      data: { companyId: admin.companyId, carrierId, tariffId, userId: admin.userId, fileName: 'x.csv', data: { raw: { rows: [] } } },
    }),
  );
  const doc = await inCompany(admin.auth, () =>
    prisma.tariffDocument.create({
      data: {
        companyId: admin.companyId,
        carrierId,
        tariffId,
        userId: admin.userId,
        fileName: 'x.pdf',
        path: 'yok/yok.pdf',
        size: 1,
        sha256: 'x',
        pages: 1,
        textLayer: true,
        pageTexts: ['metin'],
        discovery: {},
      },
    }),
  );

  // Geri çekilmiş bir itiraz turu, reddedilmiş sonucuyla: dört itiraz tablosunda satır olur (RLS, izolasyon), etkin tur
  // olmadığı için satır kararı ve fatura silme kilitlenmez, diğer testlerin akışı değişmez.
  const dispute = await inCompany(admin.auth, async () => {
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { id: lineId } });
    const d = await prisma.dispute.create({
      data: {
        companyId: admin.companyId,
        invoiceId,
        round: 1,
        sentOn: new Date('2026-10-16T00:00:00.000Z'),
        channel: 'EMAIL',
        sentById: admin.userId,
        currency: 'TRY',
        claimedTotal: 1,
        withdrawnAt: new Date(),
        withdrawnById: admin.userId,
        withdrawReason: 'fikstür',
        lines: { create: [{ companyId: admin.companyId, invoiceLineId: line.id, trackingNo: line.trackingNo, claimedAmount: 1 }] },
      },
      include: { lines: true },
    });
    const r = await prisma.disputeResult.create({
      data: {
        companyId: admin.companyId,
        disputeId: d.id,
        kind: 'REJECTED',
        resultOn: new Date('2026-10-17T00:00:00.000Z'),
        reason: 'fikstür',
        enteredById: admin.userId,
        lines: { create: [{ companyId: admin.companyId, disputeLineId: d.lines[0]!.id, amount: 1 }] },
      },
    });
    await prisma.disputeLine.update({ where: { id: d.lines[0]!.id }, data: { outcome: 'REJECTED', resultId: r.id } });
    return { disputeId: d.id, disputeResultId: r.id };
  });

  return {
    admin,
    worker,
    ...dispute,
    companyId: admin.companyId,
    carrierId,
    tariffId,
    versionId,
    measurement,
    photoId: photo.id,
    invoiceId,
    invoiceFileId: fileId,
    lineId,
    presetId,
    draftId: draft.id,
    documentId: doc.id,
  };
}

export type Fixture = Awaited<ReturnType<typeof companyFixture>>;
