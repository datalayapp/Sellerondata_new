import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

const API = '/api/deciship';
type Auth = { authorization: string };

export type RecalcSide = { status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null };
export type RecalcPreview = {
  token: string;
  basis: {
    from: { tariffId: string | null; tariffName: string | null; revisionId: string | null; revisionAt: string | null };
    to: { tariffId: string | null; tariffName: string | null; revisionId: string | null; revisionAt: string | null };
    rulesChanged: boolean;
  };
  totals: { before: { overchargeTotal: number; pendingLines: number }; after: { overchargeTotal: number; pendingLines: number } };
  changedLines: number;
  /** uygulanınca dokunulacak satır (görünür değişiklik olmasa da) */
  writeLines: number;
  frozenChanged: number;
  skippedInDispute: number;
  lines: { id: string; rowIndex: number; trackingNo: string; decision: string; before: RecalcSide; after: RecalcSide }[];
};
export type RecalcBody = { basis: 'pinned' | 'tariff' | 'rules'; lineIds?: string[]; patch?: Record<string, unknown> };

export const previewRecalc = (app: FastifyInstance, auth: Auth, invoiceId: string, body: RecalcBody) =>
  app.inject({ method: 'POST', url: `${API}/invoices/${invoiceId}/recalculate/preview`, headers: auth, payload: body });

export const applyRecalc = (app: FastifyInstance, auth: Auth, invoiceId: string, body: { basis: 'pinned' | 'tariff' | 'rules'; lineIds?: string[]; token: string }) =>
  app.inject({ method: 'POST', url: `${API}/invoices/${invoiceId}/recalculate`, headers: auth, payload: body });

/** Kullanıcının yaptığı gibi: önce/sonra önizlemesi, ardından onun `token`'ıyla onay. Faturayı ve önizlemeyi döndürür. */
export async function recalculate(app: FastifyInstance, auth: Auth, invoiceId: string, body: { basis: 'pinned' | 'tariff' | 'rules'; lineIds?: string[] }) {
  const p = await previewRecalc(app, auth, invoiceId, body);
  expect(p.statusCode, p.body).toBe(200);
  const preview = p.json() as RecalcPreview;
  const r = await applyRecalc(app, auth, invoiceId, { ...body, token: preview.token });
  expect(r.statusCode, r.body).toBe(200);
  return { preview, invoice: r.json().invoice };
}

/** `PATCH /invoices/:id` alanlarından hesabı değiştiren dördü (önizlemenin `patch`'i). */
const RECALC_FIELDS = ['carrierId', 'tariffId', 'invoiceDate', 'currency'] as const;

/**
 * Web düzenleme penceresinin yaptığı gibi: hesabı değiştiren alan varsa önce aynı değişikliğin önizlemesi
 * (`basis: 'pinned'` + `patch`), sonra onun `token`'ıyla `PATCH /invoices/:id`. PATCH yanıtını döndürür.
 */
export async function patchInvoice(app: FastifyInstance, auth: Auth, invoiceId: string, payload: Record<string, unknown>) {
  const patch = Object.fromEntries(RECALC_FIELDS.filter((k) => k in payload).map((k) => [k, payload[k]]));
  let token: string | undefined;
  if (Object.keys(patch).length) {
    const p = await previewRecalc(app, auth, invoiceId, { basis: 'pinned', patch });
    // önizlemeyi reddeden değişikliği (yabancı tarife, itiraz kilidi) PATCH de aynı nedenle reddeder
    if (p.statusCode !== 200) return p;
    token = (p.json() as RecalcPreview).token;
  }
  return app.inject({ method: 'PATCH', url: `${API}/invoices/${invoiceId}`, headers: auth, payload: { ...payload, ...(token ? { token } : {}) } });
}
