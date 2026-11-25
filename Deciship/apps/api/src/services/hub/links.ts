import type { Period } from './period.ts';
import { P, type HubCtx } from './types.ts';

/** Araçtaki kayıtlara derin bağlantılar (ARCHITECTURE §3). İş araçta yapılır. Sorgu adları DeciShip web'in okuduklarıdır. */
export const deciship = {
  invoice: (id: string, tab = 'DIFF') => `/deciship/invoices/${id}?tab=${tab}`,
  invoiceLine: (invoiceId: string, lineId: string, status: string) => `/deciship/invoices/${invoiceId}?tab=${status}&line=${lineId}`,
  measurement: (id: string) => `/deciship/measurements?id=${id}`,
  measurementsBy: (userId: string, p?: Period) => `/deciship/measurements?userId=${userId}${p ? `&from=${p.from}&to=${p.to}` : ''}`,
  tariff: (id: string) => `/deciship/tariffs/${id}`,
  tariffs: (carrierId?: string) => `/deciship/tariffs${carrierId ? `?carrier=${carrierId}` : ''}`,
  setup: '/deciship/setup',
  settings: '/deciship/settings',
  invoices: '/deciship/invoices',
  disputes: '/deciship/disputes',
  invoiceUpload: '/deciship/invoices/upload',
  measurements: '/deciship/measurements',
};

/** Merkez'in kendi veri sayfaları: tıklayınca aynı dönem ve süzgeçle satırlar açılır, sayı tutar. */
export function dataLink(ctx: HubCtx, dataset: string, filters: Record<string, string | readonly string[] | undefined | null>, p?: Period): string | undefined {
  if (!ctx.can(P.invoices)) return undefined;
  if (dataset === 'measurements' && !ctx.can(P.measurements)) return undefined;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (Array.isArray(v)) for (const one of v) q.append(`filter.${k}`, one);
    else if (v) q.append(`filter.${k}`, v as string);
  }
  if (p) {
    q.append('filter.from', p.from);
    q.append('filter.to', p.to);
  }
  const s = q.toString();
  return `/data/deciship/${dataset}${s ? `?${s}` : ''}`;
}
