import type { HubActivityItem, HubActivityPage, Permission } from '@sellerondata/contracts';
import { prisma, Prisma } from '../../db.ts';
import type { HubKey } from './i18n.ts';
import { dataLink, deciship } from './links.ts';
import { memberIdsByName, memberNames } from './members.ts';
import { P, queryInt, type HubCtx } from './types.ts';

type Group = 'invoice' | 'measurement' | 'tariff' | 'carrier' | 'settings' | 'export';

/**
 * Akışta görünen işlemler ve kimin göreceği. Listede olmayan iz gösterilmez: oturum açma, kullanıcı işlemleri (artık
 * Hesap'ta), yapay zekâ önizlemeleri, örnek fatura yüklemesi. `data` alanı hiç dönmez; içinde tutar olabilir.
 */
const ACTIONS: Record<string, { group: Group; perm?: Permission }> = {
  'invoice.import': { group: 'invoice', perm: P.invoices },
  'invoice.importUnverified': { group: 'invoice', perm: P.invoices },
  'invoice.update': { group: 'invoice', perm: P.invoices },
  'invoice.recompare': { group: 'invoice', perm: P.invoices },
  'invoice.recalculate': { group: 'invoice', perm: P.invoices },
  'invoice.delete': { group: 'invoice', perm: P.invoices },
  // Mesaj 14: toplu karar, fatura başına tek satır (satır başına `invoiceLine.bulkDecision` izi akışta görünmez)
  'invoice.linesDecided': { group: 'invoice', perm: P.invoices },
  'invoiceLine.decision': { group: 'invoice', perm: P.invoices },
  'invoiceLine.pin': { group: 'invoice', perm: P.invoices },
  'invoiceLine.unpin': { group: 'invoice', perm: P.invoices },
  'invoiceLine.trackingFix': { group: 'invoice', perm: P.invoices },
  'invoiceLine.parseChecked': { group: 'invoice', perm: P.invoices },
  'invoiceLine.update': { group: 'invoice', perm: P.invoices },
  'dispute.send': { group: 'invoice', perm: P.invoices },
  'dispute.resend': { group: 'invoice', perm: P.invoices },
  'dispute.withdraw': { group: 'invoice', perm: P.invoices },
  'dispute.recovered': { group: 'invoice', perm: P.invoices },
  'dispute.rejected': { group: 'invoice', perm: P.invoices },
  'dispute.revert': { group: 'invoice', perm: P.invoices },
  'measurement.create': { group: 'measurement', perm: P.measurements },
  'measurement.remeasure': { group: 'measurement', perm: P.measurements },
  'measurement.correct': { group: 'measurement', perm: P.measurements },
  'measurement.delete': { group: 'measurement', perm: P.measurements },
  'measurement.restore': { group: 'measurement', perm: P.measurements },
  'measurement.purge': { group: 'measurement', perm: P.measurements },
  'tariff.create': { group: 'tariff' },
  'tariff.update': { group: 'tariff' },
  'tariff.delete': { group: 'tariff' },
  'tariff.setDefault': { group: 'tariff' },
  'tariff.duplicate': { group: 'tariff' },
  'tariff.import': { group: 'tariff' },
  'tariff.import.create': { group: 'tariff' },
  'tariff.restore': { group: 'tariff' },
  'tariff.recompare': { group: 'tariff' },
  'tariff.countryAdjustment': { group: 'tariff' },
  'carrier.create': { group: 'carrier' },
  'carrier.deactivate': { group: 'carrier' },
  'carrier.delete': { group: 'carrier' },
  'settings.update': { group: 'settings', perm: P.settings },
  'settings.recompare': { group: 'settings', perm: P.settings },
  'onboarding.complete': { group: 'settings', perm: P.settings },
  'onboarding.reopen': { group: 'settings', perm: P.settings },
  'company.reset': { group: 'settings', perm: P.settings },
  'company.samples': { group: 'settings', perm: P.settings },
  'data.export': { group: 'export', perm: P.export },
};

export const ACTIVITY_GROUPS: Group[] = ['invoice', 'measurement', 'tariff', 'carrier', 'settings', 'export'];

export function visibleActions(ctx: HubCtx, group?: string): string[] {
  return Object.entries(ACTIONS)
    .filter(([, a]) => (!a.perm || ctx.can(a.perm)) && (!group || a.group === group))
    .map(([k]) => k);
}

const decisionOf = (data: unknown) => {
  const d = (data as { decision?: string } | null)?.decision;
  return d === 'VERIFIED' || d === 'ACCEPTED' ? d : 'OPEN';
};

function actionKey(action: string, data: unknown): HubKey {
  if (action === 'invoiceLine.decision') return `activity.invoiceLine.decision.${decisionOf(data)}` as HubKey;
  if (action === 'invoice.linesDecided') return `activity.invoice.linesDecided.${decisionOf(data)}` as HubKey;
  // KALANLAR 6.7: kuyrukta bekleyip geç gelen eski ölçüm (`data.late`) güncel ölçümü değiştirmez; "yeniden ölçtü" denmez.
  if (action === 'measurement.remeasure' && (data as { late?: unknown } | null)?.late === true) return 'activity.measurement.remeasure.late';
  // Y14: toplu geçişte (tarife ya da ayar) yazılan fatura kaydı: `via: { kind: 'tariff' | 'settings' }` (services/bulkRecalc.ts)
  if (action === 'invoice.recalculate') {
    const via = (data as { via?: unknown } | null)?.via;
    if (via && typeof via === 'object' && !Array.isArray(via)) return 'activity.invoice.recalculate.bulk';
  }
  return `activity.${action}` as HubKey;
}

/** Etiketin sayısı: toplu kararda karar verilen satır (`count`). Kayıtta tutar yok; yalnız sayı okunur. */
function actionLabel(ctx: HubCtx, action: string, data: unknown): string {
  const key = actionKey(action, data);
  if (action !== 'invoice.linesDecided') return ctx.t(key);
  const raw = (data as { count?: unknown } | null)?.count;
  const n = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return ctx.t(key, { n, count: n });
}

export type ActivityRow = HubActivityItem;

export type ActivityQuery = { actions: string[]; q?: string; page: number; pageSize: number };

export async function auditWhere(ctx: HubCtx, actions: string[], q?: string): Promise<Prisma.AuditLogWhereInput> {
  const where: Prisma.AuditLogWhereInput = { companyId: ctx.companyId, action: { in: actions } };
  const text = q?.trim();
  if (text) {
    const needle = text.toLocaleLowerCase(ctx.locale);
    const byLabel = actions.filter((a) => ctx.t(actionKey(a, null)).toLocaleLowerCase(ctx.locale).includes(needle));
    const byName = await memberIdsByName(ctx.companyId, text);
    where.OR = [{ action: { in: byLabel } }, { userId: { in: byName } }];
  }
  return where;
}

/** Sayfadaki kayıtların hedefleri toplu okunur: satır başına sorgu yok. Silinen kaydın bağlantısı olmaz. */
async function describeTargets(ctx: HubCtx, rows: { entity: string; entityId: string | null; action: string; data: unknown }[]) {
  const { companyId } = ctx;
  const ids = (entity: string) => [...new Set(rows.filter((r) => r.entity === entity && r.entityId).map((r) => r.entityId!))];
  const [invoices, lines, measurements, tariffs, carriers] = await Promise.all([
    ids('Invoice').length
      ? prisma.invoice.findMany({ where: { companyId, id: { in: ids('Invoice') } }, select: { id: true, invoiceNo: true, deletedAt: true, carrier: { select: { name: true } } } })
      : [],
    ids('InvoiceLine').length
      ? prisma.invoiceLine.findMany({ where: { companyId, id: { in: ids('InvoiceLine') } }, select: { id: true, trackingNo: true, invoiceId: true, status: true, invoice: { select: { deletedAt: true } } } })
      : [],
    ids('Measurement').length ? prisma.measurement.findMany({ where: { companyId, id: { in: ids('Measurement') } }, select: { id: true, trackingNo: true, deletedAt: true } }) : [],
    ids('Tariff').length ? prisma.tariff.findMany({ where: { companyId, id: { in: ids('Tariff') } }, select: { id: true, name: true } }) : [],
    ids('Carrier').length ? prisma.carrier.findMany({ where: { companyId, id: { in: ids('Carrier') } }, select: { id: true, name: true } }) : [],
  ]);
  const inv = new Map(invoices.map((x) => [x.id, x]));
  const line = new Map(lines.map((x) => [x.id, x]));
  const meas = new Map(measurements.map((x) => [x.id, x]));
  const tar = new Map(tariffs.map((x) => [x.id, x]));
  const car = new Map(carriers.map((x) => [x.id, x]));

  return (r: { entity: string; entityId: string | null; action: string; data: unknown }): { target?: string; href?: string } => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const id = r.entityId ?? '';
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    switch (r.entity) {
      case 'Invoice': {
        const x = inv.get(id);
        if (!x) return { target: str(data.invoiceNo) };
        return { target: `${x.carrier.name} ${x.invoiceNo}`, ...(x.deletedAt ? {} : { href: deciship.invoice(x.id, 'ALL') }) };
      }
      case 'InvoiceLine': {
        const x = line.get(id);
        if (!x) return {};
        return { target: x.trackingNo, ...(x.invoice.deletedAt ? {} : { href: deciship.invoiceLine(x.invoiceId, x.id, x.status) }) };
      }
      case 'Measurement': {
        const x = meas.get(id);
        if (!x) return { target: str(data.trackingNo) };
        return { target: x.trackingNo, ...(x.deletedAt ? {} : { href: deciship.measurement(x.id) }) };
      }
      case 'Tariff': {
        const x = tar.get(id);
        return x ? { target: x.name, href: deciship.tariff(x.id) } : { target: str(data.name) };
      }
      case 'Carrier': {
        const x = car.get(id);
        return x ? { target: x.name, href: deciship.tariffs(x.id) } : { target: str(data.name) };
      }
      case 'Company': {
        // Y14: toplu ayar geçişi Ayarlar'a götürür (ayar izni olana: eylemin kendisi de o izinle görünür)
        if (r.action === 'settings.recompare' && ctx.can(P.settings)) return { href: deciship.settings };
        return {};
      }
      case 'Dataset': {
        const label = ctx.t(`dataset.${id}` as HubKey) ?? id;
        const href = dataLink(ctx, id, {});
        return { target: label, ...(href ? { href } : {}) };
      }
      default:
        return {};
    }
  };
}

export async function activityRows(ctx: HubCtx, where: Prisma.AuditLogWhereInput, opts: { skip: number; take: number; orderBy?: Prisma.AuditLogOrderByWithRelationInput[] }): Promise<ActivityRow[]> {
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: opts.orderBy ?? [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: opts.skip,
    take: opts.take,
    select: { id: true, userId: true, action: true, entity: true, entityId: true, data: true, createdAt: true },
  });
  const [names, describe] = await Promise.all([memberNames(ctx.companyId, rows.map((r) => r.userId)), describeTargets(ctx, rows)]);
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    actor: r.userId ? (names.get(r.userId) ?? null) : null,
    action: actionLabel(ctx, r.action, r.data),
    ...describe(r),
  }));
}

const ACTIVITY_PAGE_SIZE = 25;
const ACTIVITY_PAGE_SIZE_MAX = 100;

export async function buildActivity(ctx: HubCtx, query: Record<string, unknown>): Promise<HubActivityPage> {
  const page = queryInt(query.page, 1, 'page', ctx.t);
  const pageSize = Math.min(ACTIVITY_PAGE_SIZE_MAX, queryInt(query.pageSize, ACTIVITY_PAGE_SIZE, 'pageSize', ctx.t));
  const where = await auditWhere(ctx, visibleActions(ctx));
  const [total, items] = await Promise.all([prisma.auditLog.count({ where }), activityRows(ctx, where, { skip: (page - 1) * pageSize, take: pageSize })]);
  return JSON.parse(JSON.stringify({ items, page, pageSize, total })) as HubActivityPage;
}
