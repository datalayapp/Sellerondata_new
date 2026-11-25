import {
  AI_SPEND_CALL_COLUMNS,
  AI_SPEND_CALLS_PAGE_SIZE,
  AI_SPEND_CALLS_PAGE_SIZE_MAX,
  AI_SPEND_EXPORT_MAX_ROWS,
  AI_SPEND_MEMBER_NONE,
  PRODUCTS,
  aiPurposeLabel,
  type AiSpendCallColumn,
  type AiSpendCallsPage,
  type HubColumn,
  type HubRow,
} from '@sellerondata/contracts';
import { AppError } from '../errors.ts';
import type { Prisma, PrismaClient } from '../db.ts';
import { amountOf, positiveInt, zonedDateTime, type SpendContext } from './query.ts';
import type { SpendTextKey } from './text.ts';
import { buildCsv, buildXlsx, type XlsxCell, type XlsxColumn } from './xlsx.ts';

/**
 * `GET /api/ai/spend/calls` → `HubDatasetPage` (`id: 'calls'`) ve dışa aktarma `GET /api/ai/spend/calls/export?format=csv|xlsx`.
 * Satır başına bir defter satırı (her yukarı akış denemesi), `pending` dahil; sıra en yeni önce, eşitlikte kimlik (sayfalar arası
 * kayma olmasın). Firma görünümünde yalnız jetondaki firma; platformda bütün firmalar (`org` süzgeci) ve `org` sütunu.
 * `member` hücresi `memberId` (ad Merkez'de ekip listesinden çözülür; dışa aktarmada da kimlik kalır, geçit kişi adı tutmaz) [V].
 * Dışa aktarma en çok `AI_SPEND_EXPORT_MAX_ROWS` satır; aşan aralık `400 VALIDATION` (`details: { reason: 'too_many_rows', maxRows }`).
 */

const SELECT = {
  id: true,
  orgId: true,
  memberId: true,
  product: true,
  purpose: true,
  requestedModel: true,
  servedModel: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWrite5mTokens: true,
  cacheWrite1hTokens: true,
  inputImages: true,
  outputImages: true,
  costMicroUsd: true,
  status: true,
  estimated: true,
  errorCode: true,
  durationMs: true,
  startedAt: true,
} as const;

type CallRow = Prisma.AiCallGetPayload<{ select: typeof SELECT }>;

const ORDER: Prisma.AiCallOrderByWithRelationInput[] = [{ startedAt: 'desc' }, { id: 'desc' }];

type ColumnSpec = { format: HubColumn['format']; align?: 'right'; hidden?: boolean; xlsx?: XlsxColumn['format']; width?: number };

const SPEC: Record<AiSpendCallColumn, ColumnSpec> = {
  at: { format: 'datetime', xlsx: 'dateTime', width: 18 },
  product: { format: 'text', width: 12 },
  purpose: { format: 'text', width: 26 },
  member: { format: 'text', width: 26 },
  model: { format: 'text', width: 24 },
  served_model: { format: 'text', hidden: true, width: 24 },
  input_tokens: { format: 'number', align: 'right', xlsx: 'integer', width: 14 },
  output_tokens: { format: 'number', align: 'right', xlsx: 'integer', width: 14 },
  cache_read_tokens: { format: 'number', align: 'right', hidden: true, xlsx: 'integer', width: 16 },
  cache_write_tokens: { format: 'number', align: 'right', hidden: true, xlsx: 'integer', width: 16 },
  images: { format: 'number', align: 'right', xlsx: 'integer', width: 9 },
  amount: { format: 'money', align: 'right', xlsx: 'money', width: 12 },
  status: { format: 'text', width: 16 },
  estimated: { format: 'text', hidden: true, width: 10 },
  error_code: { format: 'text', hidden: true, width: 22 },
  duration_ms: { format: 'number', align: 'right', hidden: true, xlsx: 'integer', width: 12 },
  org: { format: 'text', width: 26 },
};

function visibleColumns(ctx: SpendContext): AiSpendCallColumn[] {
  return AI_SPEND_CALL_COLUMNS.filter((c) => c !== 'org' || ctx.scope === 'platform');
}

export function callsWhere(ctx: SpendContext): Prisma.AiCallWhereInput {
  const f = ctx.filters;
  return {
    startedAt: { gte: ctx.window.start, lt: ctx.window.end },
    ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
    ...(f.product ? { product: f.product } : {}),
    ...(f.purpose ? { purpose: f.purpose } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.member === AI_SPEND_MEMBER_NONE ? { memberId: null } : f.member ? { memberId: f.member } : {}),
    ...(f.model ? { OR: [{ servedModel: f.model }, { servedModel: null, requestedModel: f.model }] } : {}),
  };
}

const productName = (key: string) => (PRODUCTS as Record<string, { name: string } | undefined>)[key]?.name ?? key;

async function orgNamesOf(prisma: PrismaClient, ctx: SpendContext, rows: CallRow[]): Promise<Map<string, string | null>> {
  if (ctx.scope !== 'platform' || !rows.length) return new Map();
  const ids = [...new Set(rows.map((r) => r.orgId))];
  const orgs = await prisma.org.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(orgs.map((o) => [o.id, o.name]));
}

/** Satırın hücre değerleri (liste ve dışa aktarma ortak; `at` ISO). */
function cellsOf(ctx: SpendContext, r: CallRow, orgNames: Map<string, string | null>): Record<AiSpendCallColumn, string | number | null> {
  const { t } = ctx;
  return {
    at: r.startedAt.toISOString(),
    product: productName(r.product),
    purpose: aiPurposeLabel(r.purpose, ctx.locale),
    member: r.memberId,
    model: r.requestedModel,
    served_model: r.servedModel,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens,
    cache_write_tokens: r.cacheWrite5mTokens + r.cacheWrite1hTokens,
    images: r.inputImages + r.outputImages,
    amount: amountOf(Number(r.costMicroUsd), ctx.currency, ctx.rate),
    status: t(`status.${r.status}` as SpendTextKey),
    estimated: r.estimated ? t('export.yes') : t('export.no'),
    error_code: r.errorCode,
    duration_ms: r.durationMs,
    org: orgNames.get(r.orgId) ?? r.orgId,
  };
}

export async function buildCallsPage(prisma: PrismaClient, ctx: SpendContext, query: Record<string, unknown>): Promise<AiSpendCallsPage> {
  const page = positiveInt(query, 'page', 1);
  const pageSize = positiveInt(query, 'pageSize', AI_SPEND_CALLS_PAGE_SIZE, AI_SPEND_CALLS_PAGE_SIZE_MAX);
  const where = callsWhere(ctx);
  const [total, rows] = await Promise.all([
    prisma.aiCall.count({ where }),
    prisma.aiCall.findMany({ where, orderBy: ORDER, skip: (page - 1) * pageSize, take: pageSize, select: SELECT }),
  ]);
  const names = await orgNamesOf(prisma, ctx, rows);
  const cols = visibleColumns(ctx);
  const columns: HubColumn[] = cols.map((id) => {
    const s = SPEC[id];
    return {
      id,
      label: ctx.t(`col.${id}` as SpendTextKey),
      format: s.format,
      ...(s.format === 'money' ? { currency: ctx.currency } : {}),
      ...(s.align ? { align: s.align } : {}),
      ...(s.hidden ? { hiddenByDefault: true } : {}),
    };
  });
  const out: HubRow[] = rows.map((r) => {
    const all = cellsOf(ctx, r, names);
    return { id: r.id, cells: Object.fromEntries(cols.map((c) => [c, all[c]])) };
  });
  return { id: 'calls', columns, rows: out, page, pageSize, total };
}

export type ExportFile = { body: Buffer; contentType: string; fileName: string; rows: number };

/** Dışa aktarma: aynı süzgeçler ve sütunlar (gizliler dahil), başlıklar isteğin dilinde; an firmanın saat diliminde (platformda UTC). */
export async function buildCallsExport(prisma: PrismaClient, ctx: SpendContext, format: 'csv' | 'xlsx'): Promise<ExportFile> {
  const where = callsWhere(ctx);
  const total = await prisma.aiCall.count({ where });
  if (total > AI_SPEND_EXPORT_MAX_ROWS) throw new AppError(400, 'VALIDATION', { reason: 'too_many_rows', maxRows: AI_SPEND_EXPORT_MAX_ROWS, total });
  // Sayımla okuma arasında yazılan satırlar sınırı aşmasın.
  const rows = await prisma.aiCall.findMany({ where, orderBy: ORDER, select: SELECT, take: AI_SPEND_EXPORT_MAX_ROWS });
  const names = await orgNamesOf(prisma, ctx, rows);
  const cols = visibleColumns(ctx);
  const header = (id: AiSpendCallColumn) => (id === 'amount' ? `${ctx.t('col.amount')} (${ctx.currency})` : ctx.t(`col.${id}` as SpendTextKey));
  const columns: XlsxColumn[] = cols.map((id) => ({ header: header(id), width: SPEC[id].width, ...(SPEC[id].xlsx ? { format: SPEC[id].xlsx } : {}) }));
  const platform = ctx.scope === 'platform';
  if (platform) columns.push({ header: ctx.t('col.org_id'), width: 28 });
  const wall = (at: Date) => new Date(`${zonedDateTime(at, ctx.timeZone).replace(' ', 'T')}:00.000Z`);
  const data: XlsxCell[][] = rows.map((r) => {
    const all = cellsOf(ctx, r, names);
    const line: XlsxCell[] = cols.map((c) => (c === 'at' ? { dateTime: wall(r.startedAt) } : all[c]));
    if (platform) line.push(r.orgId);
    return line;
  });
  const fileBase = ctx.t('export.file', { from: ctx.window.from, to: ctx.window.to });
  if (format === 'csv') {
    const body = buildCsv(columns, data, (d) => d.toISOString().slice(0, 16).replace('T', ' '));
    return { body, contentType: 'text/csv; charset=utf-8', fileName: `${fileBase}.csv`, rows: rows.length };
  }
  const body = buildXlsx(ctx.t('export.sheet'), columns, data);
  return { body, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: `${fileBase}.xlsx`, rows: rows.length };
}
