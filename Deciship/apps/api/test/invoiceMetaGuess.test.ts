import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { getApp, multipart, registerCompany, SAMPLES, uniq } from './helpers.ts';

type Auth = { authorization: string };
const API = '/api/deciship';

async function preview(app: FastifyInstance, auth: Auth, code: string, file: string) {
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code, name: uniq(code) } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = (c.json().carrier?.id ?? c.json().id) as string;
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: file, contentType: 'text/csv', data: fs.readFileSync(path.join(SAMPLES, 'invoices', file)) },
  ]);
  const r = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return { carrierId, body: r.json() };
}

describe('B3: dosyada olmayan fatura tarihi uydurulmaz', () => {
  it('MNG örneği: tarih tahmini boş döner, bugün yazılmaz, gönderi tarihi alınmaz', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const { body } = await preview(app, auth, 'mng', 'mng-MNG-2026-77120.csv');
    expect(body.guessedMeta.invoiceDate).toBeUndefined();
    expect(body.suggestedMapping.invoiceDate).toBeUndefined();
    expect(body.guessedMeta.invoiceNo).toBe('MNG-2026-77120');
  });

  it('ABD örneği: Inv # ve Bill Date okunur', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const { body } = await preview(app, auth, 'generic', 'generic-en-invoice-sample.csv');
    expect(body.guessedMeta).toMatchObject({ invoiceNo: 'INV-0091-77', invoiceDate: '2026-10-31', currency: 'USD' });
    expect(body.suggestedMapping).toMatchObject({ invoiceNo: 'Inv #', invoiceDate: 'Bill Date' });
  });

  it('tarihsiz içe aktarma reddedilir: boş ve eksik alan 400, fatura oluşmaz', async () => {
    const app = await getApp();
    const { auth } = await registerCompany(app);
    const { carrierId, body } = await preview(app, auth, 'mng', 'mng-MNG-2026-77120.csv');
    const payload = { fileId: body.fileId, carrierId, invoiceNo: 'MNG-1', mapping: body.suggestedMapping, acknowledgeIssues: true };
    for (const extra of [{}, { invoiceDate: '' }]) {
      const r = await app.inject({ method: 'POST', url: `${API}/invoices`, headers: auth, payload: { ...payload, ...extra } });
      expect(r.statusCode, r.body).toBe(400);
    }
    const list = await app.inject({ method: 'GET', url: `${API}/invoices`, headers: auth });
    expect(list.json().items).toEqual([]);
  });
});
