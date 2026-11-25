import type { AiCallOrigin, AiCallStatus, AiKeySource, AiProvider, ProductKey } from '@sellerondata/contracts';
import { Prisma, type PrismaClient } from '../db.ts';
import type { MeteredUsage } from './pricing.ts';

/**
 * Harcama defteri (`ai.AiCall`). Satırı yalnız geçit yazar; her yukarı akış denemesi bir satır (sağlayıcı her denemeyi ücretlendirir).
 * - Açma (`open`): `pending` (kabul, üst sınır payıyla) ya da doğrudan `rejected` (geçidin reddi, tutar 0). Deneme sayısı: aracın
 *   bildirdiği sayı (`x-sod-attempt`, yoksa SDK'nın `x-stainless-retry-count`'u) boşsa o, doluysa ondan büyük ilk boş sayı: aynı istek
 *   kimliği ve deneme sayısıyla ikinci istek reddedilmez (o da ücretlidir), ayrı satır olur. Seçim istek kimliğine bağlı işlem kilidi
 *   altında; `UNIQUE(product, toolRequestId, attempt)` son güvencedir (yarışta işlem baştan denenir).
 * - Kapatma (`close`): tek koşullu güncelleme (`WHERE id = … AND status = 'pending'`); iki kez kapanamaz, kapanan satırın payı 0.
 * - Tarama (`sweep`): verilen andan önce açılmış ve hâlâ `pending` satırları `interrupted` yapar; tutar üst tahmin (= payı), `estimated`.
 */

export type OpenInput = {
  id: string;
  product: ProductKey;
  orgId: string;
  memberId: string | null;
  purpose: string;
  origin: AiCallOrigin;
  provider: AiProvider;
  requestedModel: string;
  stream: boolean;
  inputImages: number;
  toolRequestId: string;
  /** Aracın bildirdiği deneme sayısı. */
  attempt: number;
  keySource: AiKeySource;
  priceVersion: string;
  startedAt: Date;
};

export type OpenPending = OpenInput & { status: 'pending'; reservedMicroUsd: number };
export type OpenRejected = OpenInput & { status: 'rejected'; errorCode: string; httpStatus: number };

export type CloseInput = {
  status: Exclude<AiCallStatus, 'pending'>;
  usage: MeteredUsage;
  costMicroUsd: number;
  servedModel: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  estimated: boolean;
  upstreamRequestId: string | null;
  finishedAt: Date;
};

export type SweptRow = { id: string; product: string; orgId: string; costMicroUsd: number };

const MAX_OPEN_TRIES = 4;
const INT_MAX = 2_147_483_647;
const clampInt = (n: number) => Math.max(0, Math.min(INT_MAX, Math.round(Number.isFinite(n) ? n : 0)));
const short = (s: string | null, n = 200) => (s === null ? null : s.slice(0, n));

export class Ledger {
  constructor(private readonly prisma: PrismaClient) {}

  /** Satırı açar; yazılan deneme sayısını döner. */
  async open(row: OpenPending | OpenRejected): Promise<{ attempt: number }> {
    for (let i = 0; ; i++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:req:${row.product}:${row.toolRequestId}`}, 0))`;
          const taken = await tx.aiCall.findMany({ where: { product: row.product, toolRequestId: row.toolRequestId, attempt: { gte: row.attempt } }, select: { attempt: true } });
          const used = new Set(taken.map((t) => t.attempt));
          let attempt = row.attempt;
          while (used.has(attempt)) attempt += 1;
          const rejected = row.status === 'rejected';
          await tx.aiCall.create({
            data: {
              id: row.id,
              product: row.product,
              orgId: row.orgId,
              memberId: row.memberId,
              purpose: row.purpose,
              origin: row.origin,
              provider: row.provider,
              requestedModel: row.requestedModel.slice(0, 200),
              stream: row.stream,
              inputImages: clampInt(row.inputImages),
              reservedMicroUsd: rejected ? 0n : BigInt(Math.max(0, Math.ceil(row.reservedMicroUsd))),
              costMicroUsd: 0n,
              priceVersion: row.priceVersion,
              status: row.status,
              errorCode: rejected ? row.errorCode : null,
              httpStatus: rejected ? row.httpStatus : null,
              keySource: row.keySource,
              toolRequestId: row.toolRequestId,
              attempt,
              startedAt: row.startedAt,
              finishedAt: rejected ? row.startedAt : null,
              durationMs: rejected ? 0 : null,
            },
          });
          return { attempt };
        });
      } catch (e) {
        if (i + 1 < MAX_OPEN_TRIES && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
  }

  /** Açık satırı kapatır. Satır açık değilse (tarama önce kapattı) false. */
  async close(id: string, c: CloseInput): Promise<boolean> {
    const row = await this.prisma.aiCall.findUnique({ where: { id }, select: { startedAt: true } });
    if (!row) return false;
    const u = c.usage;
    const res = await this.prisma.aiCall.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: c.status,
        servedModel: short(c.servedModel),
        inputTokens: clampInt(u.inputTokens),
        outputTokens: clampInt(u.outputTokens),
        cacheReadTokens: clampInt(u.cacheReadTokens),
        cacheWrite5mTokens: clampInt(u.cacheWrite5mTokens),
        cacheWrite1hTokens: clampInt(u.cacheWrite1hTokens),
        outputImages: clampInt(u.outputImages),
        costMicroUsd: BigInt(Math.max(0, Math.round(c.costMicroUsd))),
        reservedMicroUsd: 0n,
        errorCode: short(c.errorCode, 100),
        httpStatus: c.httpStatus,
        estimated: c.estimated,
        finishedAt: c.finishedAt,
        durationMs: clampInt(c.finishedAt.getTime() - row.startedAt.getTime()),
        upstreamRequestId: short(c.upstreamRequestId),
      },
    });
    return res.count === 1;
  }

  /**
   * `before`'dan önce açılıp hâlâ açık satırlar → `interrupted`, tutar = payı (üst tahmin), `estimated`. Her satır kendi koşullu
   * güncellemesiyle: o arada canlı istek kapattıysa dokunulmaz.
   */
  async sweep(before: Date, now: Date = new Date()): Promise<SweptRow[]> {
    const rows = await this.prisma.aiCall.findMany({
      where: { status: 'pending', startedAt: { lt: before } },
      select: { id: true, product: true, orgId: true, reservedMicroUsd: true, startedAt: true },
      take: 1000,
    });
    const out: SweptRow[] = [];
    for (const r of rows) {
      const res = await this.prisma.aiCall.updateMany({
        where: { id: r.id, status: 'pending' },
        data: {
          status: 'interrupted',
          costMicroUsd: r.reservedMicroUsd,
          reservedMicroUsd: 0n,
          estimated: true,
          errorCode: 'gateway_interrupted',
          finishedAt: now,
          durationMs: clampInt(now.getTime() - r.startedAt.getTime()),
        },
      });
      if (res.count === 1) out.push({ id: r.id, product: r.product, orgId: r.orgId, costMicroUsd: Number(r.reservedMicroUsd) });
    }
    return out;
  }
}
