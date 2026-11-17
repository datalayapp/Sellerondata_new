/**
 * Y83: uzun işler (PDF fatura okuma, tarife PDF'inin yapay zekâ taraması ve tablo okuması, toplu yeniden hesap) yalnız arka
 * planda yürür; `?async=1` olmayan istek 400 `ASYNC_REQUIRED`. Eski eşzamanlı yolu çağıran testler bu yardımcıyla arka plan
 * yoluna geçti: beklentileri aynı kalır, yalnız çağrı biçimi değişir.
 *
 * `viaJob` isteğe `async=1` ekler. 202 `{ job }` gelirse iş bitene kadar bekler (testlerde `JOB_RUNNER=inline`: başlatan
 * istek işi bitirir; süren bir işe bağlanıldıysa `GET /jobs/:id` yoklanır) ve sonucu eski yanıt biçimine çevirir:
 *  - SUCCEEDED → 200, gövde `job.result`;
 *  - FAILED → `job.error.statusCode`, gövde `{ error: { code, message, details? } }` (hata işleyicisinin biçimi);
 *  - CANCELLED → 409, gövde `{ error: { code: 'CANCELLED' } }`.
 * 202 dışı yanıt (iş açılmadan dönen 400/404/409/429, CSV/XLSX önizlemesinin 200'ü) olduğu gibi döner. İş süre içinde
 * bitmezse 202 ve başlatma gövdesi döner (test bekleneni görmez, kırılır; asılı kalmaz).
 *
 * Fark: iş hatasında yanıt başlıkları (ör. `retry-after`) yoktur; o başlığı sınayan test 202'yi kendisi okumalı.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { expect } from 'vitest';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
type JobLike = {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  result?: unknown;
  error?: { statusCode: number; code: string; message: string; details?: unknown };
};

/** Eski eşzamanlı yanıtın yerine geçen yanıt: `statusCode`, `body`, `json()`; `job` arka plan işinin son hâli (yoksa null). */
export type JobReply = {
  statusCode: number;
  body: string;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any
  job: JobLike | null;
  /** başlatan isteğin ham yanıtı (202 ya da iş açılmadan dönen yanıt) */
  start: InjectResponse;
};

const FINISHED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** `url`'ye `async=1` ekler (sorgu varsa `&` ile). */
export function withAsync(url: string): string {
  if (/[?&]async=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}async=1`;
}

function reply(start: InjectResponse, statusCode: number, payload: unknown, job: JobLike | null): JobReply {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { statusCode, body, json: () => JSON.parse(body), job, start };
}

/** İşi `GET /jobs/:id` ile bitene kadar okur (en çok `timeoutMs`). */
async function settle(app: FastifyInstance, base: string, job: JobLike, headers: InjectOptions['headers'], timeoutMs: number): Promise<JobLike> {
  let cur = job;
  const end = Date.now() + timeoutMs;
  while (!FINISHED.has(cur.status) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    const auth = { ...(headers as Record<string, string> | undefined) };
    // çok parçalı başlatmanın içerik başlıkları GET'e taşınmaz
    delete auth['content-type'];
    delete auth['content-length'];
    const r = await app.inject({ method: 'GET', url: `${base}/jobs/${cur.id}`, headers: auth });
    if (r.statusCode !== 200) break;
    cur = r.json() as JobLike;
  }
  return cur;
}

/**
 * İsteği arka plan yoluyla gönderir ve iş sonucunu eski eşzamanlı yanıt biçiminde döner (yukarıdaki kurallar). `url`
 * `/api/deciship/...` ya da `/api/...` (hub) olabilir; iş ucu aynı önekte aranır.
 */
export async function viaJob(app: FastifyInstance, opts: InjectOptions & { url: string }, timeoutMs = 10_000): Promise<JobReply> {
  const url = withAsync(opts.url);
  const start = await app.inject({ ...opts, url });
  if (start.statusCode !== 202) return reply(start, start.statusCode, start.body, null);
  const started = start.json() as { job?: JobLike };
  if (!started.job) return reply(start, start.statusCode, start.body, null);
  const base = url.slice(0, url.search(/\/(invoices|tariff-documents|tariff-imports|tariffs|settings)(\/|\?|$)/));
  const job = await settle(app, base, started.job, opts.headers, timeoutMs);
  if (job.status === 'SUCCEEDED') return reply(start, 200, job.result ?? null, job);
  if (job.status === 'FAILED') {
    const e = job.error ?? { statusCode: 500, code: 'INTERNAL', message: '' };
    return reply(start, e.statusCode, { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, job);
  }
  if (job.status === 'CANCELLED') return reply(start, 409, { error: { code: 'CANCELLED' } }, job);
  return reply(start, start.statusCode, start.body, job);
}

/** Eski yolun kapandığını sınar: `async` olmadan 400 `ASYNC_REQUIRED`. */
export function expectAsyncRequired(r: { statusCode: number; json(): unknown; body: string }) {
  expect(r.statusCode, r.body).toBe(400);
  expect(r.json()).toMatchObject({ error: { code: 'ASYNC_REQUIRED' } });
}
