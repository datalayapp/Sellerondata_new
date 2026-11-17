/**
 * Merkez → Abonelik → Yapay zekâ kullanımı: ayrıntılı döküm (`GET /platform/ai-usage/calls`, contracts `HubAiCallPage`) ve Excel'i
 * (`GET /platform/ai-usage/calls/export`). Satır başına bir `AiUsage` kaydı; önceki sonuçtan gelen ücretsiz işlemler (`CACHED`)
 * listede yok (özetteki `cachedCalls`). Sıra en yeni önce, eşitlikte kimlik (sayfalar arası kayma olmasın).
 *
 * Gizlilik: uç ayar iznine bağlı (kişi adları). Para alanları (`amount`, `priceVersion`, `priceUsdRate`) yalnız fiyat izniyle;
 * burada çıkarılır, `app.ts` `stripMoney` ikinci güvencedir. İlgili kaydın adı ve bağlantısı yalnız kişinin o kaydı görme izni
 * varsa: fatura dosyası fatura izniyle, tarife belgesi ve tarife taslağı tarife izniyle. Silinmiş kaydın adı yazılmaz.
 */
import ExcelJS from 'exceljs';
import {
  AI_CURRENCY,
  HUB_AI_CALLS_PAGE_SIZE,
  HUB_AI_CALLS_PAGE_SIZE_MAX,
  HUB_AI_MEMBER_NONE,
  aiMicrosToAmount,
  type HubAiCall,
  type HubAiCallPage,
  type Permission,
} from '@sellerondata/contracts';
import { prisma, withCompany, type Prisma } from '../../db.ts';
import { zonedDateTimeText } from '../../lib/time.ts';
import { AI_KINDS, type AiKind } from '../aiMeter.ts';
import { aiCallStatus, queryText, resolveAiPeriod } from './aiUsage.ts';
import type { HubKey } from './i18n.ts';
import { deciship } from './links.ts';
import { memberNames } from './members.ts';
import { P, hubError, queryInt, type HubCtx } from './types.ts';

/** Tarife belgesi ve taslağının adı tarifeyi görebilene. */
const TARIFFS_VIEW: Permission = 'deciship.tariffs.view';
/** Excel'e en çok bu kadar satır (bir firmanın bir aylık kullanımı bunun çok altında kalır). */
export const AI_CALLS_EXPORT_MAX = 50_000;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AiCallsQuery = { period: string; timeZone: string; where: Prisma.AiUsageWhereInput };

/** Süzgeçler: dönem (özetle aynı kural), tür (`AI_KINDS`), kişi (üye kimliği ya da silinmiş kişi için `none`). */
export async function aiCallsQuery(ctx: HubCtx, query: Record<string, unknown>): Promise<AiCallsQuery> {
  const { period, timeZone } = await resolveAiPeriod(ctx, queryText(ctx, query.period, 'period'));
  const kind = queryText(ctx, query.kind, 'kind');
  if (kind !== undefined && !AI_KINDS.includes(kind as AiKind)) throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name: 'kind' }));
  const member = queryText(ctx, query.member, 'member');
  if (member !== undefined && member !== HUB_AI_MEMBER_NONE && !MEMBER_ID.test(member)) throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name: 'member' }));
  const where: Prisma.AiUsageWhereInput = {
    companyId: ctx.companyId,
    period,
    status: { in: ['OK', 'FAILED'] },
    ...(kind ? { kind: kind as AiKind } : {}),
    ...(member === HUB_AI_MEMBER_NONE ? { memberId: null } : member ? { memberId: member } : {}),
  };
  return { period, timeZone, where };
}

const SELECT = {
  id: true,
  memberId: true,
  kind: true,
  status: true,
  errorCode: true,
  model: true,
  servedModel: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  cost: true,
  priceVersion: true,
  durationMs: true,
  estimated: true,
  refType: true,
  refId: true,
  createdAt: true,
} as const;
type UsageRow = Prisma.AiUsageGetPayload<{ select: typeof SELECT }>;

/** `priceVersion` "r<kur>:<özet>" (aiMeter `priceVersion`): kuru okur; başka biçimde null. */
export function priceUsdRateOf(priceVersion: string): number | null {
  const m = /^r(\d+(?:\.\d+)?):/.exec(priceVersion);
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sayfadaki satırların kayıtları toplu okunur (satır başına sorgu yok). Görme izni olmayan tür hiç okunmaz. */
async function describeRecords(ctx: HubCtx, rows: UsageRow[]): Promise<(r: UsageRow) => { record?: string; href?: string }> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.refType === type && r.refId).map((r) => r.refId!))];
  const fileIds = ctx.can(P.invoices) ? ids('File') : [];
  const docIds = ctx.can(TARIFFS_VIEW) ? ids('TariffDocument') : [];
  const draftIds = ctx.can(TARIFFS_VIEW) ? ids('TariffImportDraft') : [];
  const { companyId } = ctx;
  const [files, docs, drafts] = await Promise.all([
    fileIds.length
      ? prisma.file.findMany({
          where: { companyId, id: { in: fileIds }, purgedAt: null },
          select: { id: true, originalName: true, invoicesAsSource: { select: { id: true, deletedAt: true, isSample: true }, orderBy: { createdAt: 'desc' } } },
        })
      : [],
    docIds.length ? prisma.tariffDocument.findMany({ where: { companyId, id: { in: docIds } }, select: { id: true, fileName: true, tariffId: true } }) : [],
    draftIds.length ? prisma.tariffImportDraft.findMany({ where: { companyId, id: { in: draftIds } }, select: { id: true, fileName: true, tariffId: true } }) : [],
  ]);
  const file = new Map(files.map((x) => [x.id, x]));
  const doc = new Map([...docs, ...drafts].map((x) => [x.id, x]));
  return (r) => {
    if (!r.refId) return {};
    if (r.refType === 'File') {
      const f = file.get(r.refId);
      if (!f) return {};
      // Faturaya bağlı dosya yalnız fatura yerindeyken görünür (silinen ve örnek fatura listede yok sayılır); hiç faturaya
      // bağlanmamış dosya (önizleme, sütun eşleme) adıyla, bağlantısız.
      const invoice = f.invoicesAsSource.find((i) => !i.deletedAt && !i.isSample);
      if (f.invoicesAsSource.length && !invoice) return {};
      return { record: f.originalName || ctx.t('aiUsage.record.file'), ...(invoice ? { href: deciship.invoice(invoice.id, 'ALL') } : {}) };
    }
    if (r.refType === 'TariffDocument' || r.refType === 'TariffImportDraft') {
      const d = doc.get(r.refId);
      if (!d) return {};
      return { record: d.fileName, ...(d.tariffId ? { href: deciship.tariff(d.tariffId) } : {}) };
    }
    return {};
  };
}

async function toCalls(ctx: HubCtx, rows: UsageRow[]): Promise<HubAiCall[]> {
  const [names, describe] = await Promise.all([memberNames(ctx.companyId, rows.map((r) => r.memberId)), describeRecords(ctx, rows)]);
  const unknown = ctx.t('aiUsage.member.unknown');
  const money = ctx.can(P.prices);
  return rows.map((r) => {
    const tokens = { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens, total: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens };
    const status = aiCallStatus(r);
    const call: HubAiCall = {
      id: r.id,
      at: r.createdAt.toISOString(),
      memberId: r.memberId,
      person: (r.memberId && names.get(r.memberId)) || unknown,
      kind: r.kind,
      label: ctx.t(`aiUsage.kind.${r.kind}` as HubKey),
      ...describe(r),
      status,
      errorCode: r.status === 'OK' ? null : (r.errorCode ?? null),
      estimated: r.estimated,
      tokens,
      durationMs: r.durationMs,
      model: r.model,
      servedModel: r.servedModel,
      amount: aiMicrosToAmount(Math.round(Number(r.cost.toString()) * 1_000_000)),
      deducted: status === 'ok',
      priceVersion: r.priceVersion,
      priceUsdRate: priceUsdRateOf(r.priceVersion),
    };
    if (money) return call;
    const { amount: _a, priceVersion: _v, priceUsdRate: _r, ...rest } = call;
    return rest as HubAiCall;
  });
}

const ORDER: Prisma.AiUsageOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

export async function buildAiCalls(ctx: HubCtx, query: Record<string, unknown>): Promise<HubAiCallPage> {
  const page = queryInt(query.page, 1, 'page', ctx.t);
  const pageSize = Math.min(HUB_AI_CALLS_PAGE_SIZE_MAX, queryInt(query.pageSize, HUB_AI_CALLS_PAGE_SIZE, 'pageSize', ctx.t));
  const { period, where } = await aiCallsQuery(ctx, query);
  return withCompany(ctx.companyId, async () => {
    const [total, rows] = await Promise.all([prisma.aiUsage.count({ where }), prisma.aiUsage.findMany({ where, orderBy: ORDER, skip: (page - 1) * pageSize, take: pageSize, select: SELECT })]);
    return { product: 'deciship', period, currency: AI_CURRENCY, page, pageSize, total, items: await toCalls(ctx, rows) };
  });
}

/**
 * Excel hücresindeki an, firmanın saat diliminde: tarih hücresi (sıralanır, süzülür). Excel saat dilimi bilmez; hücreye firmanın
 * duvar saati UTC gibi yazılır. Biçim TR "13.11.2026 14:22", EN "2026-11-13 14:22".
 */
function atCell(at: Date, timeZone: string): Date {
  const [day, time] = zonedDateTimeText(at, timeZone).split(' ') as [string, string];
  return new Date(`${day}T${time}:00.000Z`);
}

const STATUS_KEY = { ok: 'aiUsage.status.ok', refused: 'aiUsage.status.refused', truncated: 'aiUsage.status.truncated', failed: 'aiUsage.status.failed' } as const satisfies Record<HubAiCall['status'], HubKey>;
const MONEY_FMT = '#,##0.00';

/**
 * Excel (tek sayfa). Başlıklar isteğin dilinde; tutar, haktan düşme ve fiyat tablosu sütunları yalnız fiyat izniyle. Süzgeçler
 * listeyle aynı. Satır `AI_CALLS_EXPORT_MAX`'ı aşarsa 400 (süzgeç daraltılmalı).
 */
export async function buildAiCallsXlsx(ctx: HubCtx, query: Record<string, unknown>): Promise<{ buffer: Buffer; fileName: string; period: string; rows: number }> {
  const { period, timeZone, where } = await aiCallsQuery(ctx, query);
  const calls = await withCompany(ctx.companyId, async () => {
    const total = await prisma.aiUsage.count({ where });
    if (total > AI_CALLS_EXPORT_MAX) throw hubError(400, 'EXPORT_TOO_LARGE', ctx.t('err.exportTooLarge', { total, max: AI_CALLS_EXPORT_MAX }));
    // sayımla okuma arasında yazılan satırlar tavanı aşmasın
    return toCalls(ctx, await prisma.aiUsage.findMany({ where, orderBy: ORDER, select: SELECT, take: AI_CALLS_EXPORT_MAX }));
  });
  const money = ctx.can(P.prices);
  const yes = ctx.t('aiUsage.export.yes');
  const no = ctx.t('aiUsage.export.no');
  const columns: { key: string; header: HubKey; width: number; fmt?: string; value: (c: HubAiCall) => string | number | Date | null; money?: boolean }[] = [
    { key: 'at', header: 'aiUsage.col.at', width: 18, fmt: ctx.locale === 'en' ? 'yyyy-mm-dd hh:mm' : 'dd.mm.yyyy hh:mm', value: (c) => atCell(new Date(c.at), timeZone) },
    { key: 'person', header: 'aiUsage.col.person', width: 22, value: (c) => c.person },
    { key: 'kind', header: 'aiUsage.col.kind', width: 20, value: (c) => c.label },
    { key: 'record', header: 'aiUsage.col.record', width: 32, value: (c) => c.record ?? '' },
    { key: 'status', header: 'aiUsage.col.status', width: 22, value: (c) => (c.estimated ? `${ctx.t(STATUS_KEY[c.status])} · ${ctx.t('aiUsage.status.estimated')}` : ctx.t(STATUS_KEY[c.status])) },
    { key: 'input', header: 'aiUsage.col.input', width: 12, fmt: '#,##0', value: (c) => c.tokens.input },
    { key: 'output', header: 'aiUsage.col.output', width: 12, fmt: '#,##0', value: (c) => c.tokens.output },
    { key: 'cacheRead', header: 'aiUsage.col.cacheRead', width: 14, fmt: '#,##0', value: (c) => c.tokens.cacheRead },
    { key: 'cacheWrite', header: 'aiUsage.col.cacheWrite', width: 14, fmt: '#,##0', value: (c) => c.tokens.cacheWrite },
    { key: 'seconds', header: 'aiUsage.col.seconds', width: 10, fmt: '0.0', value: (c) => Math.round(c.durationMs / 100) / 10 },
    { key: 'amount', header: 'aiUsage.col.amount', width: 13, fmt: MONEY_FMT, value: (c) => c.amount, money: true },
    // tutar değil (yalnız sonuç): listedeki `deducted` gibi herkese
    { key: 'deducted', header: 'aiUsage.col.deducted', width: 14, value: (c) => (c.deducted ? yes : no) },
    { key: 'model', header: 'aiUsage.col.model', width: 22, value: (c) => c.model },
    { key: 'servedModel', header: 'aiUsage.col.servedModel', width: 22, value: (c) => c.servedModel ?? '' },
    { key: 'priceVersion', header: 'aiUsage.col.priceVersion', width: 24, value: (c) => c.priceVersion, money: true },
  ];
  const visible = columns.filter((c) => money || !c.money);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DeciShip';
  const ws = wb.addWorksheet(ctx.t('aiUsage.export.sheet'), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = visible.map((c) => ({ header: ctx.t(c.header), key: c.key, width: c.width, ...(c.fmt ? { style: { numFmt: c.fmt } } : {}) }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF161616' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: visible.length } };
  for (const call of calls) ws.addRow(Object.fromEntries(visible.map((c) => [c.key, c.value(call)])));
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: ctx.t('aiUsage.export.file', { period }), period, rows: calls.length };
}
