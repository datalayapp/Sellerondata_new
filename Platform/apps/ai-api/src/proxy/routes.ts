import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import {
  AI_CHARGED_MAYBE,
  AI_HEADERS,
  AI_LIMIT_DEFAULTS,
  AI_REJECT_STATUS,
  aiProviderOfModel,
  aiRejectBody,
  aiRejectHeaders,
  isAiModelAllowed,
  isAiPurposeOf,
  parseAiContextHeaders,
  type AiCallContext,
  type AiCallStatus,
  type AiProvider,
  type AiRejectCode,
  type ProductKey,
} from '@sellerondata/contracts';
import type { AppDeps } from '../app.ts';
import { env } from '../env.ts';
import type { InternalRoutes } from '../internal/scope.ts';
import { uuidv7 } from '../ledger/ids.ts';
import {
  cancelledUsage,
  costOf,
  currentPriceVersion,
  DEFAULT_UPPER_OUTPUT_TOKENS,
  estimateInput,
  paidFeatures,
  priceOf,
  upperMicroUsd,
  ZERO_USAGE,
  type MeteredUsage,
  type UpperBound,
} from '../ledger/pricing.ts';
import { Ledger, type CloseInput } from '../ledger/store.ts';
import { clientResponseHeaders, upstreamQuery, upstreamRequestHeaders } from './headers.ts';
import { allowAllLimits, type Limits } from './limits.ts';
import { countInputImages, createMeter, type MeterResult } from './meter.ts';

/**
 * Vekil (YAPAY-ZEKA-GECIDI §2 "Geçidin ayrıntıları", §3): araç yolları `/internal/anthropic/v1/messages`, `…/count_tokens`,
 * `/internal/gemini/v1beta/models/{model}:generateContent|streamGenerateContent`. Araç jetonu kapsamın kancasında denetlendi.
 *
 * - Gövde bir kez okunur, aynı tampondan değiştirilmeden iletilir (araçlar, görsel, belge, `cache_control` olduğu gibi). Başlıklar
 *   `headers.ts` süzgecinden: `anthropic-beta`/`anthropic-version` korunur, `x-sod-*` ve araç jetonu gitmez, gerçek anahtar eklenir.
 * - Yanıt: durum, başlıklar ve gövde olduğu gibi; akış parça parça (tampon yok) aktarılır; geçit `x-sod-ai-call-id` ekler. Hata
 *   gövdesi (4xx/5xx) yalnız anahtarın kendisi geçiyorsa maskelenir (sağlayıcı anahtarı yansıtsa da araca gitmez).
 * - Defter: kabulde `pending` (pay = üst sınır), yanıt bitince tek koşullu güncellemeyle kapanır. Araç bağlantıyı keserse geçit de
 *   sağlayıcıyı keser: `cancelled` + `estimated` (bilinmeyen kısım fazla). Sağlayıcı akışı koparsa ya da süre (`maxStreamMs`)
 *   dolarsa `failed` + `estimated`. Süreç çökerse açılış taraması `interrupted` yapar (aşağıda).
 * - `count_tokens` ücretsizdir: bağlam, amaç ve model denetlenir, deftere yazılmaz, tavana gitmez.
 * - Gizlilik: gövde ve başlık günlüğe yazılmaz; günlükte çağrı kimliği, ürün, durum, tutar, süre.
 *
 * Tarama: geçit tek örnek çalışır (compose); açılışta bu süreçten önce açılmış her `pending` satır `interrupted` olur. Ayrıca her
 * `sweepEveryMs`'te `maxStreamMs + 5 dk`'dan eski açık satırlar kapanır (birden çok örnekte de güvenli olan kural).
 */

export type ProxyOptions = {
  /** Tavanlar (G3). Yoksa `deps.limits`, o da yoksa hepsine izin. */
  limits?: Limits;
  maxStreamMs?: number;
  /** Periyodik tarama aralığı; 0: kapalı. */
  sweepEveryMs?: number;
  /** Açılış taraması (varsayılan açık). */
  bootSweep?: boolean;
};

const SWEEP_EVERY_MS = 60_000;
const SWEEP_GRACE_MS = 5 * 60_000;
/** Hata gövdesinin araca aktarılmadan önce tutulduğu en büyük boy (maskeleme için). */
const MAX_ERROR_BODY_BYTES = 4 * 1024 * 1024;
const BODY_LIMIT = AI_LIMIT_DEFAULTS.maxBodyBytes;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Bağlantı kurulmadan düşen ağ hataları: istek sağlayıcıya hiç gitmedi (ücret yok). */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);

type Kind = 'messages' | 'count_tokens' | 'generate';

type Spec = { provider: AiProvider; kind: Kind; upstreamPath: string; model?: string; geminiStream?: boolean };

const GEMINI_STATUS: Readonly<Record<number, string>> = { 400: 'INVALID_ARGUMENT', 404: 'NOT_FOUND', 413: 'INVALID_ARGUMENT', 500: 'INTERNAL', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE' };

function providerError(reply: FastifyReply, provider: AiProvider, status: number, type: string, message: string, opts: { retry?: boolean; callId?: string } = {}) {
  void reply.header('cache-control', 'no-store');
  if (opts.retry !== undefined) void reply.header(AI_HEADERS.shouldRetry, String(opts.retry));
  if (opts.callId) void reply.header(AI_HEADERS.callId, opts.callId);
  const body = provider === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { code: status, message, status: GEMINI_STATUS[status] ?? 'UNKNOWN' } };
  return reply.status(status).type('application/json').send(body);
}

function sendReject(reply: FastifyReply, provider: AiProvider, code: AiRejectCode, message: string, callId: string | null, retryAfterSec?: number) {
  void reply.headers(aiRejectHeaders(code, retryAfterSec));
  void reply.header('cache-control', 'no-store');
  if (callId) void reply.header(AI_HEADERS.callId, callId);
  return reply.status(AI_REJECT_STATUS[code]).send(aiRejectBody(provider, code, message));
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function upperBound(spec: Spec, body: Record<string, unknown>, bodyBytes: number, model: string, fallback: { models: string[]; maxTokens: number }): UpperBound {
  const { inputTokens, inputKind } = estimateInput(body, bodyBytes);
  if (spec.provider === 'anthropic') {
    const outputTokens = Math.max(posInt(body.max_tokens) ?? DEFAULT_UPPER_OUTPUT_TOKENS, fallback.maxTokens);
    return { inputTokens, inputKind, outputTokens, outputImages: 0, fallbackModels: fallback.models };
  }
  const gc = isRec(body.generationConfig) ? body.generationConfig : isRec(body.generation_config) ? body.generation_config : {};
  const outputTokens = posInt(gc.maxOutputTokens) ?? posInt(gc.max_output_tokens) ?? DEFAULT_UPPER_OUTPUT_TOKENS;
  const modalities = gc.responseModalities ?? gc.response_modalities;
  const wantsImage = !Array.isArray(modalities) || modalities.some((m) => String(m).toUpperCase() === 'IMAGE');
  const candidates = Math.min(8, posInt(gc.candidateCount) ?? posInt(gc.candidate_count) ?? 1);
  const images = (priceOf(model).price.perOutputImage ?? 0) > 0 && wantsImage ? candidates : 0;
  return { inputTokens, inputKind, outputTokens: outputTokens * candidates, outputImages: images };
}

function waitDrain(raw: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      raw.off('drain', done);
      raw.off('close', done);
      resolve();
    };
    raw.on('drain', done);
    raw.on('close', done);
  });
}

function errCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Tampon kopyalanmadan gövde (Node `fetch` Buffer'ı da kabul eder; tip için görünüm). */
const bodyOf = (b: Buffer) => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

function maskKey(buf: Buffer, key: string): Buffer {
  if (!key || !buf.includes(key)) return buf;
  return Buffer.from(buf.toString('utf8').split(key).join('[gizli]'), 'utf8');
}

export function proxyRoutes(deps: AppDeps, opts: ProxyOptions = {}): InternalRoutes {
  const ledger = new Ledger(deps.prisma);
  const limits: Limits = opts.limits ?? deps.limits ?? allowAllLimits;
  const maxStreamMs = opts.maxStreamMs ?? AI_LIMIT_DEFAULTS.maxStreamMs;
  const sweepEveryMs = opts.sweepEveryMs ?? SWEEP_EVERY_MS;
  const bootAt = new Date();

  return async (scope) => {
    await scope.register(async (child: FastifyInstance) => {
      const log = child.log;
      const notify = (what: string, p: Promise<unknown> | void) =>
        Promise.resolve(p).catch((e: unknown) => log.error({ errName: (e as Error)?.name, what }, 'tavan bildirimi başarısız'));

      // ---------- Tarama ----------
      let timer: NodeJS.Timeout | null = null;
      const sweep = async (before: Date) => {
        try {
          const rows = await ledger.sweep(before);
          for (const r of rows) {
            log.warn({ callId: r.id, product: r.product, costMicroUsd: r.costMicroUsd }, 'yarıda kalan çağrı kapatıldı (interrupted)');
            await notify('settle', limits.settle(r.id, r.costMicroUsd));
          }
        } catch (e) {
          log.error({ errName: (e as Error)?.name }, 'defter taraması başarısız');
        }
      };
      child.addHook('onReady', async () => {
        if (opts.bootSweep !== false) await sweep(bootAt);
        if (sweepEveryMs > 0) {
          timer = setInterval(() => void sweep(new Date(Date.now() - maxStreamMs - SWEEP_GRACE_MS)), sweepEveryMs);
          timer.unref();
        }
      });
      child.addHook('onClose', async () => {
        if (timer) clearInterval(timer);
      });

      // ---------- Gövde: ham tampon, 32 MB ----------
      child.removeAllContentTypeParsers();
      child.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));
      child.setErrorHandler((err: FastifyError, req, reply) => {
        const provider: AiProvider = req.url.includes('/gemini/') ? 'gemini' : 'anthropic';
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendReject(reply, provider, 'sod_body_too_large', 'request body exceeds gateway limit', null);
        if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return providerError(reply, provider, 400, 'invalid_request_error', 'invalid request', { retry: false });
        req.log.error({ errName: err.name, errCode: err.code }, 'vekil hatası');
        return providerError(reply, provider, 500, 'api_error', 'gateway error', { retry: false });
      });

      const route = { bodyLimit: BODY_LIMIT };
      // Testin `internalRoutes` ile önce verdiği aynı adresli yol kalır (G1 testlerinin yer tutucuları); üretimde liste boştur.
      const shape = (u: string) => u.replace(/:\w+/g, ':');
      const taken = (path: string) => (child.sodRoutes ?? []).some((r) => shape(r) === shape(`POST ${child.prefix}${path}`));
      if (!taken('/anthropic/v1/messages')) {
        child.post('/anthropic/v1/messages', route, (req, reply) => handle(req, reply, { provider: 'anthropic', kind: 'messages', upstreamPath: '/v1/messages' }));
      }
      if (!taken('/anthropic/v1/messages/count_tokens')) {
        child.post('/anthropic/v1/messages/count_tokens', route, (req, reply) =>
          handle(req, reply, { provider: 'anthropic', kind: 'count_tokens', upstreamPath: '/v1/messages/count_tokens' }),
        );
      }
      if (!taken('/gemini/v1beta/models/:target')) child.post<{ Params: { target: string } }>('/gemini/v1beta/models/:target', route, (req, reply) => {
        const target = req.params.target ?? '';
        const i = target.lastIndexOf(':');
        const model = i > 0 ? target.slice(0, i) : '';
        const action = i > 0 ? target.slice(i + 1) : '';
        if ((action !== 'generateContent' && action !== 'streamGenerateContent') || !MODEL_NAME.test(model)) {
          return providerError(reply, 'gemini', 404, 'not_found_error', 'path not allowed by gateway');
        }
        return handle(req, reply, {
          provider: 'gemini',
          kind: 'generate',
          model,
          geminiStream: action === 'streamGenerateContent',
          upstreamPath: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
        });
      });

      // ---------- İşleyici ----------
      async function handle(req: FastifyRequest, reply: FastifyReply, spec: Spec) {
        const { provider } = spec;
        const product = req.tool!.product as ProductKey;
        const parsed = parseAiContextHeaders(req.headers);
        if (!parsed.ok) return sendReject(reply, provider, 'sod_context_invalid', `invalid context headers: ${parsed.invalid.join(', ')}`, null);
        const ctx = parsed.ctx;
        const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let body: unknown;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
        } catch {
          body = undefined;
        }
        if (!isRec(body)) return providerError(reply, provider, 400, 'invalid_request_error', 'request body must be a JSON object', { retry: false });
        const model = spec.provider === 'anthropic' ? (typeof body.model === 'string' ? body.model.trim() : '') : spec.model!;
        const ledgered = spec.kind !== 'count_tokens';
        const stream = spec.provider === 'anthropic' ? body.stream === true : spec.geminiStream === true;
        const startedAt = new Date();
        const base = {
          product,
          orgId: ctx.orgId,
          memberId: ctx.memberId,
          purpose: ctx.purpose,
          origin: ctx.origin,
          provider,
          requestedModel: model,
          stream,
          inputImages: countInputImages(provider, body),
          toolRequestId: ctx.requestId,
          attempt: ctx.attempt,
          keySource: 'platform' as const,
          priceVersion: currentPriceVersion(),
          startedAt,
        };

        // Vekilin kendi retleri (amaç, model, anahtar): ücretli yolda `rejected` satırı yazılır.
        const reject = async (code: AiRejectCode, message: string, retryAfterSec?: number) => {
          if (!ledgered) return sendReject(reply, provider, code, message, null, retryAfterSec);
          const id = uuidv7();
          try {
            await ledger.open({ ...base, id, status: 'rejected', errorCode: code, httpStatus: AI_REJECT_STATUS[code] });
          } catch (e) {
            req.log.error({ errName: (e as Error)?.name }, 'ret satırı yazılamadı');
          }
          req.log.info({ callId: id, product, status: 'rejected', reject: code }, 'ai çağrısı reddedildi');
          return sendReject(reply, provider, code, message, id, retryAfterSec);
        };

        if (!isAiPurposeOf(product, ctx.purpose)) return reject('sod_purpose_unknown', 'purpose is not registered for this tool');
        if (!model || !MODEL_NAME.test(model) || !isAiModelAllowed(product, model) || aiProviderOfModel(model) !== provider) {
          return reject('sod_model_not_allowed', 'model is not allowed for this tool');
        }
        const secret = await deps.keys.secretFor(provider);
        if (!secret) return reject('sod_provider_missing', 'provider key is not configured');

        const upstreamUrl = `${env.providerBaseUrls[provider]}${spec.upstreamPath}${upstreamQuery(req.url, provider)}`;
        const headers = upstreamRequestHeaders(req.headers, provider, secret.key);

        if (!ledgered) return forwardFree(req, reply, provider, upstreamUrl, headers, raw, secret.key);

        // Fiyatlanamayan ücretli özellikler (sağlayıcı araçları, tanınmayan yedek model): ret (`paidFeatures`).
        const features = paidFeatures(provider, body);
        if (!features.ok) return reject('sod_model_not_allowed', features.message);

        // ---------- Pay ve kabul ----------
        const bound = upperBound(spec, body, raw.length, model, { models: features.fallbackModels, maxTokens: features.fallbackMaxTokens });
        const reserve = upperMicroUsd(bound, model);
        const callId = uuidv7();
        let attempt: number;
        try {
          ({ attempt } = await ledger.open({ ...base, id: callId, status: 'pending', reservedMicroUsd: reserve }));
        } catch (e) {
          req.log.error({ errName: (e as Error)?.name }, 'defter satırı açılamadı');
          return providerError(reply, provider, 503, 'api_error', 'gateway ledger unavailable');
        }
        const closeRow = (c: Omit<CloseInput, 'finishedAt'>) =>
          ledger.close(callId, { ...c, finishedAt: new Date() }).catch((e: unknown) => {
            req.log.error({ errName: (e as Error)?.name, callId }, 'defter satırı kapatılamadı');
            return false;
          });
        const closeZero = (status: Exclude<AiCallStatus, 'pending'>, errorCode: string, httpStatus: number | null) =>
          closeRow({ status, usage: ZERO_USAGE, costMicroUsd: 0, servedModel: null, errorCode, httpStatus, estimated: false, upstreamRequestId: null });

        let admitted: Awaited<ReturnType<Limits['admit']>>;
        try {
          admitted = await limits.admit({
            product,
            orgId: ctx.orgId,
            memberId: ctx.memberId,
            purpose: ctx.purpose,
            model,
            provider,
            estimateMicroUsd: reserve,
            requestId: ctx.requestId,
            attempt,
            callId,
            origin: ctx.origin,
            stream,
            keySource: secret.keySource,
          });
        } catch (e) {
          req.log.error({ errName: (e as Error)?.name, callId }, 'tavan denetimi başarısız');
          await closeZero('failed', 'gateway_limits_error', 503);
          return providerError(reply, provider, 503, 'api_error', 'gateway limits unavailable', { retry: false, callId });
        }
        if (!admitted.ok) {
          const code = admitted.code;
          await closeZero('rejected', code, AI_REJECT_STATUS[code]);
          req.log.info({ callId, product, status: 'rejected', reject: code }, 'ai çağrısı reddedildi');
          return sendReject(reply, provider, code, code, callId, admitted.retryAfterSec);
        }
        const reservationId = admitted.reservationId;

        try {
          await forwardMetered(req, reply, {
            spec,
            callId,
            reservationId,
            upstreamUrl,
            headers,
            raw,
            key: secret.key,
            keyId: secret.keyId,
            model,
            bound,
            ctx,
            product,
            closeRow,
          });
        } catch (e) {
          // Beklenmeyen hata (aktarım sırasında): satır açık kalırsa tarama üst tahminle kapatır. Ücret doğmuş olabilir: yeniden deneme yok.
          req.log.error({ errName: (e as Error)?.name, callId }, 'vekil aktarım hatası');
          // Satır hâlâ açıksa üst tahminle kapanır (kapanmışsa dokunulmaz); kiralar bırakılsın diye settle (ikinci settle etkisiz).
          const usage = cancelledUsage(null, bound, Date.now() - startedAt.getTime(), 0);
          const { costMicroUsd } = costOf(usage, model);
          await closeRow({ status: 'failed', usage, costMicroUsd, servedModel: null, errorCode: 'gateway_error', httpStatus: null, estimated: true, upstreamRequestId: null });
          await notify('settle', limits.settle(reservationId, costMicroUsd));
          if (!reply.raw.headersSent && !reply.raw.destroyed) writeProviderError(reply.raw, provider, 500, 'api_error', 'gateway error', callId, false);
          else reply.raw.destroy();
        }
      }

      // ---------- count_tokens: ücretsiz, defter yok ----------
      async function forwardFree(req: FastifyRequest, reply: FastifyReply, provider: AiProvider, url: string, headers: Record<string, string>, raw: Buffer, key: string) {
        let res: Response;
        try {
          res = await deps.fetch(url, { method: 'POST', headers, body: bodyOf(raw), redirect: 'error', signal: AbortSignal.timeout(60_000) });
        } catch {
          return providerError(reply, provider, 502, 'api_error', 'upstream unreachable');
        }
        const buf = maskKey(Buffer.from(await res.arrayBuffer()), key);
        if (res.status === 401 || res.status === 403) void deps.keys.markRejected(provider).catch(() => undefined);
        void reply.headers(clientResponseHeaders(res.headers));
        return reply.status(res.status).send(buf);
      }

      // ---------- Ücretli çağrı: aktarım + ölçüm ----------
      async function forwardMetered(
        req: FastifyRequest,
        reply: FastifyReply,
        c: {
          spec: Spec;
          callId: string;
          reservationId: string;
          upstreamUrl: string;
          headers: Record<string, string>;
          raw: Buffer;
          key: string;
          keyId: string;
          model: string;
          bound: UpperBound;
          ctx: Required<AiCallContext>;
          product: ProductKey;
          closeRow: (x: Omit<CloseInput, 'finishedAt'>) => Promise<boolean>;
        },
      ) {
        const { provider } = c.spec;
        const out = reply.raw;
        const ac = new AbortController();
        let clientGone = false;
        let timedOut = false;
        const onClientClose = () => {
          if (!out.writableFinished) {
            clientGone = true;
            ac.abort();
          }
        };
        out.on('close', onClientClose);
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, maxStreamMs);
        timer.unref();

        let sentAt = 0;
        let res: Response | null = null;
        let meterResult: MeterResult | null = null;
        let upstreamBroke = false;
        let headersSent = false;

        const finish = async (status: Exclude<AiCallStatus, 'pending'>, x: { usage: MeteredUsage; estimated: boolean; errorCode: string | null; servedModel: string | null }) => {
          clearTimeout(timer);
          out.off('close', onClientClose);
          const costModel = x.servedModel || c.model;
          const { costMicroUsd, unknownModels } = costOf(x.usage, costModel);
          if (unknownModels.length) req.log.warn({ callId: c.callId, models: unknownModels }, 'fiyat tablosunda olmayan model: en pahalı fiyattan yazıldı');
          const closedHere = await c.closeRow({
            status,
            usage: x.usage,
            costMicroUsd,
            servedModel: x.servedModel,
            errorCode: x.errorCode,
            httpStatus: res?.status ?? null,
            estimated: x.estimated,
            upstreamRequestId: res?.headers.get('request-id') ?? res?.headers.get('x-request-id') ?? null,
          });
          if (!closedHere) req.log.warn({ callId: c.callId }, 'defter satırı önceden kapanmıştı');
          if (sentAt === 0) await notify('release', limits.release(c.reservationId));
          else await notify('settle', limits.settle(c.reservationId, costMicroUsd));
          req.log.info(
            { callId: c.callId, product: c.product, provider, status, httpStatus: res?.status ?? null, costMicroUsd, estimated: x.estimated, durationMs: Date.now() - (sentAt || Date.now()) },
            'ai çağrısı',
          );
        };

        reply.hijack();

        // Araç kabul ile gönderim arasında gittiyse: istek hiç gitmedi.
        if (clientGone || out.destroyed) {
          await finish('cancelled', { usage: ZERO_USAGE, estimated: false, errorCode: 'client_closed', servedModel: null });
          return;
        }

        sentAt = Date.now();
        try {
          res = await deps.fetch(c.upstreamUrl, { method: 'POST', headers: c.headers, body: bodyOf(c.raw), redirect: 'error', signal: ac.signal });
        } catch (e) {
          const elapsed = Date.now() - sentAt;
          if (clientGone) {
            await finish('cancelled', { usage: cancelledUsage(null, c.bound, elapsed, 0), estimated: true, errorCode: 'client_closed', servedModel: null });
            out.destroy();
            return;
          }
          const code = errCode(e);
          const notSent = !timedOut && code !== null && NOT_SENT_CODES.has(code);
          if (notSent) sentAt = 0;
          await finish('failed', {
            usage: notSent ? ZERO_USAGE : cancelledUsage(null, c.bound, elapsed, 0),
            estimated: !notSent,
            errorCode: timedOut ? 'gateway_timeout' : 'upstream_unreachable',
            servedModel: null,
          });
          // Ücret doğmuş olabilir (istek gitti): SDK yeniden denemesin (ikinci ücret). Hiç gitmediyse yeniden denemek güvenli.
          writeProviderError(out, provider, timedOut ? 504 : 502, 'api_error', timedOut ? 'upstream timeout' : 'upstream unreachable', c.callId, notSent);
          return;
        }

        const status = res.status;
        const isError = status >= 400;
        const meter = createMeter(provider, res.headers.get('content-type'));
        const outHeaders = { ...clientResponseHeaders(res.headers), [AI_HEADERS.callId]: c.callId };

        // Son bayt yazılır ama yanıt, defter satırı kapandıktan SONRA bitirilir (`out.end()`): araç yanıtın bittiğini gördüğünde
        // satır kesindir (tutar, durum). Gecikme bir veritabanı güncellemesi kadardır; akışın içeriği beklemez.
        let pendingTail: Buffer | null = null;
        try {
          if (isError) {
            // Hata gövdesi küçük: bütünü okunur, anahtar geçiyorsa maskelenir, öyle aktarılır.
            const buf = await readCapped(res, MAX_ERROR_BODY_BYTES);
            meter.push(buf);
            pendingTail = maskKey(buf, c.key);
          } else {
            out.writeHead(status, outHeaders);
            headersSent = true;
            if (res.body) {
              const reader = res.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                meter.push(value);
                if (clientGone) break;
                if (!out.write(value)) await waitDrain(out);
              }
            }
          }
        } catch {
          if (!clientGone && !timedOut) upstreamBroke = true;
        }
        meterResult = meter.finish();

        // Anahtar durumu (yalnız reddedilen anahtar işaretlenir; başarı işaretli anahtarı geri açar).
        const keyRejected = provider === 'anthropic' ? status === 401 || status === 403 : status === 401 || status === 403 || (status === 400 && meterResult.keyInvalid);
        if (keyRejected) void deps.keys.markRejected(provider, c.keyId).catch(() => undefined);
        else if (status >= 200 && status < 300) void deps.keys.markAccepted(provider, c.keyId).catch(() => undefined);

        const m = meterResult;
        const elapsed = Date.now() - sentAt;
        const exact = m.completed && m.hasUsage && !m.unreadable;
        const sse = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
        const estimate = () => cancelledUsage(m.hasUsage ? m.usage : null, c.bound, elapsed, m.streamedChars);
        const endClient = () => {
          if (clientGone || out.destroyed) return;
          if (pendingTail !== null) {
            out.writeHead(status, outHeaders);
            out.end(pendingTail);
          } else out.end();
        };

        if (clientGone) {
          await finish('cancelled', { usage: exact ? m.usage : estimate(), estimated: !exact, errorCode: 'client_closed', servedModel: m.servedModel });
          out.destroy();
          return;
        }
        if (timedOut || upstreamBroke) {
          await finish('failed', { usage: estimate(), estimated: true, errorCode: timedOut ? 'gateway_timeout' : 'stream_interrupted', servedModel: m.servedModel });
          // Başlık gittiyse aracın SDK'sı yarım akışı hata olarak görsün diye bağlantı kesilir.
          if (headersSent) out.destroy();
          else writeProviderError(out, provider, timedOut ? 504 : 502, 'api_error', timedOut ? 'upstream timeout' : 'upstream interrupted', c.callId, false);
          return;
        }
        if (isError) {
          await finish('failed', { usage: m.hasUsage ? m.usage : ZERO_USAGE, estimated: false, errorCode: m.errorType ?? `http_${status}`, servedModel: m.servedModel });
        } else if (m.errorType) {
          // Akış içinde hata olayı (ör. aşırı yük): üretilen kısım ücretlidir, bilinmeyen kısım fazla sayılır.
          await finish('failed', { usage: estimate(), estimated: true, errorCode: m.errorType, servedModel: m.servedModel });
        } else if (!exact) {
          // Yanıt aktarıldı ama kullanım okunamadı (JSON) ya da akışın bitiş olayı gelmedi (SSE).
          const delivered = m.completed || !sse;
          await finish(delivered ? 'ok' : 'failed', { usage: estimate(), estimated: true, errorCode: delivered ? null : 'stream_incomplete', servedModel: m.servedModel });
        } else {
          await finish('ok', { usage: m.usage, estimated: false, errorCode: null, servedModel: m.servedModel });
        }
        endClient();
      }
    });
  };
}

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * Geçidin kendi 5xx'i, istek sağlayıcıya gittikten sonra: `retry` false ise `x-should-retry: false` ve `x-sod-ai-charged: maybe`
 * (R2 2026-11-22: ücret doğmuş olabilir; araç bunu geçici hata sayıp kendiliğinden yeniden denememeli, ikinci ücret olurdu). İstek
 * hiç gitmediyse (`retry` true) başlık yok: yeniden denemek güvenli.
 */
function writeProviderError(out: ServerResponse, provider: AiProvider, status: number, type: string, message: string, callId: string, retry: boolean) {
  if (out.headersSent || out.destroyed) return;
  const body = provider === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { code: status, message, status: GEMINI_STATUS[status] ?? 'UNAVAILABLE' } };
  out.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    [AI_HEADERS.callId]: callId,
    [AI_HEADERS.shouldRetry]: String(retry),
    ...(retry ? {} : { [AI_HEADERS.charged]: AI_CHARGED_MAYBE }),
  });
  out.end(JSON.stringify(body));
}
