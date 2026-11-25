/**
 * Kullanıcı seçmediğinde tek kural: yeni fatura ve yeni tarife firmanın para biriminde açılır.
 * Dosyada para birimi varsa o önerilir. Kaydın tutarı kendi para biriminde kalır, çevrilmez.
 */
import crypto from 'node:crypto';
import type { PlatformEvent } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { loadSampleData } from '../src/services/companyData.ts';
import { translator } from '../src/services/hub/i18n.ts';
import { MESSAGES } from '../src/i18n/messages.ts';
import { tariffPayload } from './fixtures.ts';
import { getApp, inCompany, multipart, registerCompany, sendEvent, uniq } from './helpers.ts';

const API = '/api/deciship';
let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

type Firm = Awaited<ReturnType<typeof registerCompany>> & { carrierId: string };

async function firm(currency: 'USD' | 'TRY' = 'USD', code = 'fedex'): Promise<Firm> {
  const a = await registerCompany(app, uniq('Para '));
  const ev = { eventId: crypto.randomUUID(), type: 'org.updated', orgId: a.companyId, product: 'deciship', name: 'Firma', orgVersion: 2, currency };
  await sendEvent(app, ev as unknown as PlatformEvent);
  const carrier = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: a.auth, payload: { code } });
  expect(carrier.statusCode, carrier.body).toBeLessThan(300);
  return { ...a, carrierId: carrier.json().carrier.id as string };
}

async function previewInvoice(f: Firm, csv: string) {
  const form = multipart([{ name: 'carrierId', value: f.carrierId }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from(csv) }]);
  const r = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

const tracking = () => String(crypto.randomInt(10 ** 11, 10 ** 12));

describe('fatura adımı', () => {
  it('USD firmada para birimi sütunu olmayan dosya USD önerilir', async () => {
    const f = await firm();
    const p = await previewInvoice(f, `Takip No;Desi;Tutar\n${tracking()};5;100,00\n`);
    expect(p.guessedMeta.currency).toBe('USD');
  });

  it('dosyadaki sütun firma para biriminden önce gelir: Curr=USD TRY firmada, Curr=EUR USD firmada', async () => {
    const tl = await firm('TRY');
    const a = await previewInvoice(tl, `Tracking;Weight;Amount;Curr\n${tracking()};5;100.00;USD\n${tracking()};6;110.00;USD\n`);
    expect(a.guessedMeta.currency).toBe('USD');
    expect(a.suggestedMapping.currency).toBe('Curr');

    const us = await firm('USD');
    const b = await previewInvoice(us, `Tracking;Weight;Amount;Curr\n${tracking()};5;100.00;EUR\n`);
    expect(b.guessedMeta.currency).toBe('EUR');
  });

  it('TRY firma aynı kalır', async () => {
    const f = await firm('TRY');
    const p = await previewInvoice(f, `Takip No;Desi;Tutar\n${tracking()};5;100,00\n`);
    expect(p.guessedMeta.currency).toBe('TRY');
  });
});

describe('elle tarife', () => {
  const post = (f: Firm, over: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${API}/tariffs`, headers: f.auth, payload: tariffPayload(f.carrierId, over) });

  it('para birimi verilmezse firmanın para birimi', async () => {
    const f = await firm();
    const r = await post(f, { currency: undefined });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().tariff.currency).toBe('USD');
  });

  it('kullanıcının seçimi korunur', async () => {
    const f = await firm();
    const r = await post(f, { currency: 'EUR' });
    expect(r.json().tariff.currency).toBe('EUR');
    const tl = await post(f, { currency: 'TRY', isDefault: false });
    expect(tl.json().tariff.currency).toBe('TRY');
  });

  it('düzenlemede para birimi verilmezse tarifeninki kalır, TRY olmaz', async () => {
    const f = await firm();
    const t = (await post(f, { currency: 'EUR' })).json().tariff;
    const put = await app.inject({ method: 'PUT', url: `${API}/tariffs/${t.id}`, headers: f.auth, payload: tariffPayload(f.carrierId, { currency: undefined, name: t.name }) });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().tariff.currency).toBe('EUR');
  });

  it('kopya kaynağın para biriminde kalır', async () => {
    const f = await firm();
    const t = (await post(f, { currency: 'EUR' })).json().tariff;
    const dup = await app.inject({ method: 'POST', url: `${API}/tariffs/${t.id}/duplicate`, headers: f.auth });
    expect(dup.json().tariff.currency).toBe('EUR');
  });
});

describe('tarife içe aktarma', () => {
  const CSV = 'Ağırlık;A;B\n1;10,50;12,50\n2;20,50;22,50\n3;30,50;32,50\n';

  async function upload(f: Firm, filename: string, contentType: string, data: Buffer) {
    const form = multipart([{ name: 'carrierId', value: f.carrierId }, { name: 'name', value: uniq('Yeni ') }, { name: 'file', filename, contentType, data }]);
    const r = await app.inject({ method: 'POST', url: `${API}/tariff-imports`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json();
  }

  it('dosyada para birimi yoksa öneri firmanın; kullanıcı değiştirebilir; uygulayınca o yazılır', async () => {
    const f = await firm();
    const d = await upload(f, 't.csv', 'text/csv', Buffer.from(CSV));
    expect(d.suggestedDefaults.currency).toBe('USD');

    const chosen = await app.inject({ method: 'POST', url: `${API}/tariff-imports/${d.draftId}/recheck`, headers: f.auth, payload: { options: { currency: 'EUR' } } });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json().suggestedDefaults.currency).toBe('EUR');

    const applied = await app.inject({ method: 'POST', url: `${API}/tariff-imports/${d.draftId}/apply`, headers: f.auth, payload: { options: {}, acknowledged: true, meta: { name: uniq('T ') } } });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().tariff.currency).toBe('USD');
  });

  it('dosyanın para birimi firma varsayılanından önce gelir', async () => {
    const f = await firm();
    const d = await upload(f, 't.csv', 'text/csv', Buffer.from('Ağırlık;A (TL);B (TL)\n1;10,50;12,50\n2;20,50;22,50\n'));
    expect(d.suggestedDefaults.currency).toBe('TRY');
  });

  it('para birimi yazmayan PDF: öneri firmanın', async () => {
    const f = await firm();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText('Service price list 2026', { x: 50, y: 700, size: 12, font });
    const up = await upload(f, 'liste.pdf', 'application/pdf', Buffer.from(await doc.save()));
    expect(up).toMatchObject({ kind: 'pdf', suggestedDefaults: { currency: 'USD' } });
    // belge yeniden açıldığında aynı öneri
    const again = await app.inject({ method: 'GET', url: `${API}/tariff-documents/${up.documentId}`, headers: f.auth });
    expect(again.json().suggestedDefaults.currency).toBe('USD');
  });
});

describe('örnek veri', () => {
  it('USD firmada örnek tarifeler TRY kalır, firma USD kalır; tutar iddia edilen para birimine çevrilmez', async () => {
    const f = await firm('USD', 'ups');
    const member = await inCompany(f.companyId, () => prisma.member.findFirstOrThrow({ where: { companyId: f.companyId } }));
    await inCompany(f.companyId, () => loadSampleData(f.companyId, { fallbackUserId: member.id }));

    const list = (await app.inject({ method: 'GET', url: `${API}/tariffs`, headers: f.auth })).json();
    const samples = (list.items ?? list.tariffs ?? list) as { currency: string; rateCount?: number }[];
    expect(samples.length).toBeGreaterThan(0);
    expect([...new Set(samples.map((t) => t.currency))]).toEqual(['TRY']);
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: f.auth })).json().company.settings.currency).toBe('USD');
  });
});

describe('yapay zekâ durumu', () => {
  it('fatura yüklemeden önce /me söyler', async () => {
    const f = await firm();
    try {
      delete process.env.ANTHROPIC_API_KEY;
      expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: f.auth })).json().aiAvailable).toBe(false);
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: f.auth })).json().aiAvailable).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('bekleyen karar terimi', () => {
  it('PDF, Excel ve Merkez aynı terimi yazar', () => {
    expect(MESSAGES['report.decision.OPEN']).toEqual({ tr: 'Karar bekliyor', en: 'Awaiting decision' });
    const tr = translator('tr');
    const en = translator('en');
    expect(tr('decision.OPEN')).toBe('Karar bekliyor');
    expect(en('decision.OPEN')).toBe('Awaiting decision');
    for (const k of ['widget.decisionTable.desc', 'kpi.diffs.hint'] as const) {
      expect(tr(k), k).not.toMatch(/açık/i);
      expect(en(k), k).not.toMatch(/\bopen\b/i);
    }
    expect(tr('widget.decisionTable.desc')).toContain('Karar bekliyor');
    expect(en('widget.decisionTable.desc')).toContain('Awaiting decision');
  });
});
