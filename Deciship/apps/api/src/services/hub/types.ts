import type { FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Locale, Permission } from '@sellerondata/contracts';
import { AppError } from '../../errors.ts';
import { localeOfRequest, translator, type Translate } from './i18n.ts';

/** `req.auth`'un Merkez uçlarının okuduğu kısmı: ARCHITECTURE §5 + `companyId`, `userId`. */
export type HubAuth = { companyId: string; userId: string | null; permissions: readonly string[]; locale?: string | null };

/** İzin kapısı: `guard(izin)` bir onRequest kancası döner (auth-kit `requirePermission`). */
export type HubGuard = (permission: Permission) => onRequestHookHandler;

export const P = {
  reports: 'deciship.reports.view',
  invoices: 'deciship.invoices.view',
  export: 'deciship.data.export',
  measurements: 'deciship.measurements.view_all',
  prices: 'deciship.prices.view',
  settings: 'deciship.settings.manage',
} as const satisfies Record<string, Permission>;

export type HubCtx = {
  companyId: string;
  userId: string | null;
  locale: Locale;
  t: Translate;
  can: (permission: Permission) => boolean;
  now: Date;
};

export function hubContext(req: FastifyRequest): HubCtx {
  const auth = req.auth as unknown as HubAuth;
  const locale = localeOfRequest(req, auth.locale);
  const perms = new Set<string>(auth.permissions);
  return { companyId: auth.companyId, userId: auth.userId ?? null, locale, t: translator(locale), can: (p) => perms.has(p), now: new Date() };
}

export const hubError = (status: number, code: string, message: string) => new AppError(status, code, message);

/** Sayfa parametresi: yalnız pozitif tam sayı. `1e30` ve `Infinity` sessizce kabul edilip veritabanında 500 olmasın. */
export function queryInt(value: unknown, fallback: number, name: string, t: Translate): number {
  if (value === undefined || value === '') return fallback;
  const text = String(value);
  if (!/^[1-9]\d{0,8}$/.test(text)) throw hubError(400, 'VALIDATION', t('err.filter', { name }));
  return Number(text);
}
