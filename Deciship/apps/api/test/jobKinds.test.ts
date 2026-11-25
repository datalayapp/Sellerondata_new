/**
 * Mesaj 7 P2 (plan §4.2, §4.5, §4.7, §5 P2): PDF fatura okuma ve tarife PDF işleri kuyrukta. Sahte yapay zekâ (gerçek
 * çağrı yok); çalıştırıcı satır içi (`JOB_RUNNER=inline`, vitest.config.ts): başlatan istek işi sonuna kadar çalıştırır.
 *
 * Odak çift ücret: yeniden deneme önbellekten alır (OK + CACHED), `fresh` yalnız işten önceki sonucu dışlar, kota doluyken
 * iş açılmaz. Ayrıca önizleme kaydı (`File.preview`): içe aktarma PDF'i ikinci kez okumaz (E2), takip no'suz satırlar
 * sunucu yeniden başlasa da kalır (E6). Başarısız ya da durdurulan okumanın önizleme dosyası silinir.
 */
import fs from 'node:fs';
import pg from 'pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { m } from '../src/i18n/index.ts';
import { absolutePath, sha256 } from '../src/lib/storage.ts';
import { aiJobContext, resetAiMeterState } from '../src/services/aiMeter.ts';
import { readInvoicePdfPreview } from '../src/services/jobs/handlers/invoicePdf.ts';
import { createMember, getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { expectAsyncRequired, viaJob } from './jobHelpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

// ---------- sahte yapay zekâ ----------

type Reply = { text?: string; stop_reason?: string };
const calls: { system: string; user: string }[] = [];
let reply: (system: string, user: string) => Reply = () => ({});
/** Verilirse yanıt bu kadar gecikir (ms; ilerleme yazımının saniyede bir sınırını geçmek için). */
let replyDelayMs = 0;
/** Verilirse sağlayıcı yanıtı bu söz çözülene kadar bekler (süren işe bağlanma ve durdurma için). */
let gate: Promise<void> | null = null;

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          const system = String(params.system ?? '');
          const msgs = (params.messages ?? []) as { content: { type: string; text?: string }[] }[];
          const user = msgs.flatMap((x) => x.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
          calls.push({ system, user });
          const r = reply(system, user);
          const delay = replyDelayMs;
          const wait = gate;
          // gerçek SDK gibi: sinyal kesilirse bekleyen yanıt `APIUserAbortError` ile düşer (KALANLAR 6.5)
          const aborted = new Promise<never>((_, rej) => {
            const fail = () => rej(new actual.APIUserAbortError());
            if (opts?.signal?.aborted) fail();
            else opts?.signal?.addEventListener('abort', fail, { once: true });
          });
          aborted.catch(() => undefined);
          return {
            finalMessage: async () => {
              if (wait) await Promise.race([wait, aborted]);
              if (delay) await Promise.race([new Promise((res) => setTimeout(res, delay)), aborted]);
              return {
                model: 'claude-sonnet-5-5',
                stop_reason: r.stop_reason ?? 'end_turn',
                usage: { input_tokens: 1000, output_tokens: 300 },
                content: [{ type: 'text', text: r.text ?? '{}' }],
              };
            },
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

// ---------- "işten sonra süreç düştü" benzetimi: yapay zekâ sonucundan sonra bir kez geçici hata ----------

let failAfterAiOnce = false;
vi.mock('../src/lib/settings.ts', async (orig) => {
  const actual = await orig<typeof import('../src/lib/settings.ts')>();
  return {
    ...actual,
    firmCurrency: async (companyId: string) => {
      if (failAfterAiOnce) {
        failAfterAiOnce = false;
        // çalıştırıcı geçici sayar (`jobRetry`): iş QUEUED'e döner, deneme +1
        throw Object.assign(new Error('benzetim: süreç düştü'), { jobRetry: true });
      }
      return actual.firmCurrency(companyId);
    },
  };
});

const API = '/api/deciship';
type Auth = { authorization: string };

const blank = {
  shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
  billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null,
};
const aiLine = (trackingNo: string, netAmount: number) => ({ ...blank, trackingNo, netAmount });
/** `currency: null`: önizleme firma para birimine bakar (geçici hata benzetimi orada). */
const invoiceAi = (lines = [aiLine('794812345305', 1642.5), aiLine('', 45)]) =>
  JSON.stringify({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: null, amountsIncludeVat: false, lines });

/** Her testte farklı bayt (önbellek ve hatırlama birbirine karışmasın): metin katmanlı tek sayfa. */
async function invoicePdf(tag = uniq('t')): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  ['FATURA 9-482-11735', '794812345305 20.10.2026 1.642,50', `ref ${tag}`].forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

let app: FastifyInstance;
let auth: Auth;
let companyId: string;
let carrierId: string;

function previewReq(pdf: Buffer, query = '?async=1', headers: Record<string, string> = {}) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
  ]);
  return app.inject({ method: 'POST', url: `${API}/invoices/preview${query}`, headers: { ...auth, ...form.headers, ...headers }, payload: form.payload });
}

const jobOf = (id: string, h: Record<string, string> = {}) => app.inject({ method: 'GET', url: `${API}/jobs/${id}`, headers: { ...auth, ...h } }).then((r) => r.json());
const filesWithSha = (sha: string) => inCompany(companyId, () => prisma.file.findMany({ where: { companyId, sha256: sha }, select: { id: true, path: true, preview: true } }));
const usageFor = (refId: string) =>
  inCompany(companyId, () => prisma.aiUsage.findMany({ where: { companyId, refId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { status: true, kind: true } }));
const jobRows = (kind: 'INVOICE_PDF_READ' | 'TARIFF_PDF_SCAN' | 'TARIFF_PDF_EXTRACT') => inCompany(companyId, () => prisma.job.count({ where: { companyId, kind } }));
/** Testin kendisi başka istek açıkken arka planda süren isteğin sağlayıcıya ulaşmasını bekler. */
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('bekleme süresi doldu');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  app = await getApp();
  const admin = await registerCompany(app, uniq('İş '));
  auth = admin.auth;
  companyId = admin.companyId;
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  calls.length = 0;
  reply = () => ({ text: invoiceAi() });
  gate = null;
  replyDelayMs = 0;
  failAfterAiOnce = false;
  resetAiMeterState();
});

afterEach(() => {
  delete process.env.AI_FREE_CREDIT_MONTHLY_TRY;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('INVOICE_PDF_READ', () => {
  it('?async=1: 202 { job, joined }; sonuç bugünkü önizleme yanıtı; async olmadan 400 ASYNC_REQUIRED (dosya saklanmaz, ücret yok); yeniden okuma aynı biçim, ücretsiz', async () => {
    const pdf = await invoicePdf();
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(202);
    const { job, joined } = r.json();
    expect(joined).toBe(false);
    expect(job).toMatchObject({ kind: 'INVOICE_PDF_READ', status: 'SUCCEEDED', attempt: 1, cancellable: false, label: 'fatura.pdf', ref: { type: 'File' } });
    expect(job.params).toBeUndefined(); // girdi (limitler, dosya) dışarı verilmez
    const res = job.result;
    expect(res).toMatchObject({ format: 'pdf', aiCached: false, aiSkipped: { count: 1, amount: 45 }, pdfCheck: { method: 'text', checked: 1, unverified: 0 } });
    expect(res.fileId).toBe(job.ref.id);
    expect(res.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(['794812345305']);
    // aynı iş GET /jobs/:id ile de okunur
    expect((await jobOf(job.id)).result).toEqual(res);

    // Y83: eski eşzamanlı yol (async yok) kapandı: 400 ASYNC_REQUIRED, yeni dosya kaydı yok, sağlayıcı çağrılmaz
    expectAsyncRequired(await previewReq(pdf, ''));
    expect(await filesWithSha(sha256(pdf))).toHaveLength(1);
    expect(calls).toHaveLength(1);

    // aynı dosya yeniden (arka plan yolu): aynı biçim, önceki okuma ücretsiz (önbellek)
    const again = await previewReq(pdf);
    expect(again.statusCode, again.body).toBe(202);
    const s = again.json().job.result;
    expect(Object.keys(s).sort()).toEqual(Object.keys(res).sort());
    expect({ ...s, fileId: 'x', aiCached: false }).toEqual({ ...res, fileId: 'x' });
    expect(s.aiCached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('yeniden deneme önbellekten alır: yapay zekâdan sonra geçici hata → ikinci deneme CACHED (AiUsage bir OK, bir CACHED)', async () => {
    const pdf = await invoicePdf();
    failAfterAiOnce = true;
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    // ilk deneme yapay zekâ sonucunu aldı ve önbelleğe yazdı, sonra düştü: iş kuyruğa döndü
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(1);
    const fileId = job.ref.id as string;
    expect((await usageFor(fileId)).map((u) => u.status)).toEqual(['OK']);

    // "yeni süreç" işi alır (satır içi kipte elle): sağlayıcı yeniden çağrılmaz
    const { kickJob } = await import('../src/services/jobs/queue.ts');
    await kickJob(job.id);
    const done = await jobOf(job.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: true, fileId } });
    expect(calls).toHaveLength(1);
    expect((await usageFor(fileId)).map((u) => u.status)).toEqual(['OK', 'CACHED']);
  });

  it('fresh: işten önceki sonuç kullanılmaz (yeniden ücret), ama işin kendi sonucu yeniden denemede ücretsiz (cacheNotBefore)', async () => {
    const pdf = await invoicePdf();
    expect((await previewReq(pdf)).json().job.status).toBe('SUCCEEDED');
    expect(calls).toHaveLength(1);
    // önbellekte sonuç varken "yeniden oku": sağlayıcı yeniden çağrılır
    reply = () => ({ text: invoiceAi([aiLine('794812345305', 1642.5)]) });
    failAfterAiOnce = true;
    const r = await previewReq(pdf, '?async=1&fresh=1');
    const { job, joined } = r.json();
    expect(joined).toBe(false);
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(2);
    const { kickJob } = await import('../src/services/jobs/queue.ts');
    await kickJob(job.id);
    const done = await jobOf(job.id);
    // ikinci deneme: bu işin yazdığı (yeni) sonuç, ücretsiz; eski sonucun takip no'suz satırı yok
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: true, aiSkipped: { count: 0 } } });
    expect(calls).toHaveLength(2);
    expect((await usageFor(job.ref.id)).map((u) => u.status)).toEqual(['OK', 'CACHED']);
    // fresh işi ayrı tekillik anahtarında: girdide fresh, dışarı verilmez
    const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { id: job.id }, select: { dedupeKey: true, input: true } }));
    // 05-B10: taşıyıcı da anahtarda ve girdide
    expect(row.dedupeKey).toBe(`pdf:${sha256(pdf)}:tr:c:${carrierId}:fresh`);
    expect(row.input).toMatchObject({ v: 1, locale: 'tr', fresh: true, fileId: job.ref.id, carrierId });
  });

  it('aynı PDF aynı anda iki kez: ikinci istek süren işe bağlanır; tek iş, tek dosya, tek ücret', async () => {
    const pdf = await invoicePdf();
    let open!: () => void;
    gate = new Promise<void>((res) => (open = res));
    const first = previewReq(pdf);
    await until(() => calls.length === 1);
    const second = await previewReq(pdf);
    expect(second.statusCode, second.body).toBe(202);
    const s = second.json();
    expect(s.joined).toBe(true);
    expect(s.job.status).toBe('RUNNING');
    expect(s.job.progress.stage).toBe('pdfRead');
    open();
    const f = (await first).json();
    expect(f.joined).toBe(false);
    expect(f.job.id).toBe(s.job.id);
    expect(f.job.status).toBe('SUCCEEDED');
    expect(await filesWithSha(sha256(pdf))).toHaveLength(1);
    expect(await inCompany(companyId, () => prisma.job.count({ where: { companyId, dedupeKey: `pdf:${sha256(pdf)}:tr:c:${carrierId}` } }))).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('başarısız okuma (kesildi) önizleme dosyasını siler: satır ve disk', async () => {
    const pdf = await invoicePdf();
    reply = () => ({ stop_reason: 'max_tokens', text: '{' });
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job).toMatchObject({ status: 'FAILED', error: { statusCode: 422, code: 'AI_TRUNCATED' } });
    expect(job.result).toBeUndefined();
    // yapay zekâ hatası kendiliğinden yeniden denenmez
    expect(calls).toHaveLength(1);
    expect(await filesWithSha(sha256(pdf))).toEqual([]);
    const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { id: job.id }, select: { refId: true } }));
    expect(await inCompany(companyId, () => prisma.file.count({ where: { id: row.refId! } }))).toBe(0);
  });

  it('çalışırken durdurma (KALANLAR 6.5): süren yapay zekâ çağrısı kesilir, iş CANCELLED, harcama FAILED AI_CANCELLED, önizleme dosyası silinir', async () => {
    const pdf = await invoicePdf();
    let open!: () => void;
    gate = new Promise<void>((res) => (open = res));
    const first = previewReq(pdf);
    await until(() => calls.length === 1);
    const [file] = await filesWithSha(sha256(pdf));
    expect(file).toBeTruthy();
    expect(fs.existsSync(absolutePath(file!.path))).toBe(true);
    const running = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { companyId, refId: file!.id }, select: { id: true } }));
    const c = await app.inject({ method: 'POST', url: `${API}/jobs/${running.id}/cancel`, headers: auth, payload: {} });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().cancelRequested).toBe(true);
    // kapı açılmadan: çağrı sinyalle kesilir, iş sağlayıcının yanıtını beklemez
    const f = (await first).json();
    open();
    expect(f.job).toMatchObject({ id: running.id, status: 'CANCELLED' });
    expect(await filesWithSha(sha256(pdf))).toEqual([]);
    expect(fs.existsSync(absolutePath(file!.path))).toBe(false);
    // kesilen çağrının harcaması sayaçta (FAILED, kotadan düşmez); sonucu yok: aynı dosya yeniden seçilince yeniden okunur
    const spent = await inCompany(companyId, () =>
      prisma.aiUsage.findMany({ where: { companyId, refId: file!.id }, select: { status: true, errorCode: true, estimated: true } }),
    );
    expect(spent).toEqual([{ status: 'FAILED', errorCode: 'AI_CANCELLED', estimated: true }]);
    const again = (await previewReq(pdf)).json();
    expect(again.job).toMatchObject({ status: 'SUCCEEDED', result: { aiCached: false } });
    expect(calls).toHaveLength(2);
  });

  it('kota doluyken iş açılmaz: 429 AI_QUOTA_EXCEEDED, dosya saklanmaz, sağlayıcı çağrılmaz', async () => {
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '0';
    const pdf = await invoicePdf();
    const before = await jobRows('INVOICE_PDF_READ');
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(429);
    expect(r.json().error.code).toBe('AI_QUOTA_EXCEEDED');
    expect(await jobRows('INVOICE_PDF_READ')).toBe(before);
    expect(await filesWithSha(sha256(pdf))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('İngilizce istek: iş İngilizce çalışır (girdi dili, sonuç metni, anahtar), Türkçe ile ayrı iş', async () => {
    const pdf = await invoicePdf();
    const en = await previewReq(pdf, '?async=1', { 'accept-language': 'en' });
    expect(en.statusCode, en.body).toBe(202);
    const job = en.json().job;
    expect(job.result.warning).toBe(m('invoice.aiReadWarning', undefined, 'en'));
    const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { id: job.id }, select: { dedupeKey: true, input: true } }));
    expect(row.dedupeKey).toBe(`pdf:${sha256(pdf)}:en:c:${carrierId}`);
    expect(row.input).toMatchObject({ locale: 'en' });
    const tr = (await previewReq(pdf)).json().job;
    expect(tr.id).not.toBe(job.id);
    expect(tr.result.warning).toBe(m('invoice.aiReadWarning', undefined, 'tr'));
  });

  it('E6: takip no\'suz satırlar File.preview\'da; süreç belleği olmadan (yeniden başlamış sunucu) içe aktarma raporuna yazılır', async () => {
    const pdf = await invoicePdf();
    const { job } = (await previewReq(pdf)).json();
    const [file] = await filesWithSha(sha256(pdf));
    expect(file!.preview).toMatchObject({ v: 1, method: 'text', skipped: [{ rowIndex: 1, reason: 'NO_TRACKING', amount: 45 }] });
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId: job.result.fileId, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines: job.result.aiLines, confirmOverlap: true },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    expect(imp.json().importReport).toMatchObject({ rowsInFile: 2, linesImported: 1, skippedCount: 1, byReason: { NO_TRACKING: 1 }, noTrackingAmount: 45 });

    // hiç bu süreçte önizlenmemiş dosya (yalnız veritabanındaki kayıt): sayı yine yazılır
    const member = await inCompany(companyId, () => prisma.member.findFirstOrThrow({ where: { companyId } }));
    const orphan = await inCompany(companyId, () =>
      prisma.file.create({
        data: {
          companyId, kind: 'INVOICE_SOURCE', mime: 'application/pdf', size: 1, path: `yok/${uniq('f')}.pdf`, sha256: uniq('s'), createdById: member.id,
          preview: { v: 1, skipped: [{ rowIndex: 4, reason: 'NO_TRACKING', amount: 12.5 }] },
        },
      }),
    );
    const r = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId: orphan.id, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines: [{ trackingNo: '794812345399', netAmount: 10, surcharges: [] }], confirmOverlap: true },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport).toMatchObject({ rowsInFile: 2, skippedCount: 1, skippedRows: [{ row: 5, reason: 'NO_TRACKING', amount: 12.5 }], pdfCheck: { method: 'none' } });

    // bozuk kayıt sayı uydurmaz: alan yok sayılır (bugünkü davranış: NO_TRACKING yazılmaz)
    const bad = await inCompany(companyId, () =>
      prisma.file.create({
        data: {
          companyId, kind: 'INVOICE_SOURCE', mime: 'application/pdf', size: 1, path: `yok/${uniq('f')}.pdf`, sha256: uniq('s'), createdById: member.id,
          preview: { v: 1, skipped: [{ rowIndex: 'x', reason: 'NO_TRACKING', amount: 1 }] },
        },
      }),
    );
    const rb = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId: bad.id, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines: [{ trackingNo: '794812345398', netAmount: 10, surcharges: [] }], confirmOverlap: true },
    });
    expect(rb.statusCode, rb.body).toBe(201);
    expect(rb.json().importReport).toMatchObject({ rowsInFile: 1, skippedCount: 0, byReason: {} });
  });

  it('E2: içe aktarma PDF\'i ikinci kez okumaz: sayfa metni File.preview\'dan (saklanan dosyaya erişilemese de metin denetimi yapılır)', async () => {
    const pdf = await invoicePdf();
    const { job } = (await previewReq(pdf)).json();
    const [file] = await filesWithSha(sha256(pdf));
    expect((file!.preview as { pageTexts?: string[] }).pageTexts?.[0]).toContain('794812345305');
    // dosyanın yolunu boz: içe aktarma dosyaya giderse metin bulunamaz ("none") olurdu
    await inCompany(companyId, () => prisma.file.update({ where: { id: file!.id }, data: { path: `yok/${uniq('f')}.pdf` } }));
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: {
        fileId: job.result.fileId, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', confirmOverlap: true,
        lines: [...job.result.aiLines, { rowIndex: 100, trackingNo: '794899999999', netAmount: 12.34, surcharges: [] }],
      },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    expect(imp.json().importReport.pdfCheck).toEqual({ method: 'text', checked: 2, unverified: 1 });
    expect(calls).toHaveLength(1);
  });

  it('KALANLAR 6.5: içe aktarma bitince sayfa metni (File.preview.pageTexts) silinir; PDF dosyası ve öbür kayıt alanları kalır', async () => {
    const pdf = await invoicePdf();
    const { job } = (await previewReq(pdf)).json();
    const [before] = await filesWithSha(sha256(pdf));
    expect((before!.preview as { pageTexts?: string[] }).pageTexts?.[0]).toContain('794812345305');
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: {
        fileId: job.result.fileId,
        carrierId,
        invoiceNo: uniq('P'),
        invoiceDate: '2026-10-27',
        currency: 'TRY',
        lines: job.result.aiLines,
        confirmOverlap: true,
      },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const [after] = await filesWithSha(sha256(pdf));
    const { pageTexts: _gone, ...kept } = before!.preview as Record<string, unknown>;
    expect(after!.preview).toEqual(kept);
    expect(after!.preview).not.toHaveProperty('pageTexts');
    // itiraz kanıtı: PDF diskte, fatura dosyaya bağlı
    expect(fs.existsSync(absolutePath(after!.path))).toBe(true);
    const invoiceId = imp.json().invoice.id as string;
    expect(await inCompany(companyId, () => prisma.file.findFirstOrThrow({ where: { id: after!.id }, select: { invoiceId: true } }))).toEqual({ invoiceId });
    // PDF hâlâ indirilebilir
    const dl = await app.inject({ method: 'GET', url: `${API}/files/${after!.id}`, headers: auth });
    expect(dl.statusCode, dl.body).toBe(200);
  });

  it('KALANLAR 6.5: içe aktarmadan sonra geç biten okuma silinen sayfa metnini geri yazmaz', async () => {
    const pdf = await invoicePdf();
    const { job } = (await previewReq(pdf)).json();
    const imp = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId: job.result.fileId, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines: job.result.aiLines, confirmOverlap: true },
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const [file] = await filesWithSha(sha256(pdf));
    expect(file!.preview).not.toHaveProperty('pageTexts');
    // aynı dosyanın okuması içe aktarmadan sonra biter (ör. paylaşılan önizlemenin ikinci işi): önizleme kaydı yazılmaz
    const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { id: job.id } }));
    await inCompany(companyId, () =>
      readInvoicePdfPreview({ companyId, file: { id: file!.id, path: file!.path }, ctx: aiJobContext({ ...row, input: row.input as Record<string, unknown> }, 'INVOICE_PDF', { type: 'File', id: file!.id }) }),
    );
    const [after] = await filesWithSha(sha256(pdf));
    expect(after!.preview).toEqual(file!.preview);
  });

  it('KALANLAR 6.5: okunmuş önizlemeden kurulum örneği yazılınca da sayfa metni silinir', async () => {
    const pdf = await invoicePdf();
    const { job } = (await previewReq(pdf)).json();
    const r = await app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: auth, payload: { fileId: job.result.fileId, carrierId } });
    expect(r.statusCode, r.body).toBe(201);
    const [after] = await filesWithSha(sha256(pdf));
    expect(after!.preview).toMatchObject({ v: 1 });
    expect(after!.preview).not.toHaveProperty('pageTexts');
    expect(fs.existsSync(absolutePath(after!.path))).toBe(true);
  });
});

// ---------- tarife PDF ----------

const DISCOVERY = {
  document: {
    carrier: 'FedEx', validFrom: '2026-06-02', currency: 'USD', weightUnit: 'kg', dimDivisor: 5000, fuel: { kind: 'FIXED_PCT', pct: 5 },
    surchargeNotes: [], countryZonePages: [], discountPages: [], notes: [],
  },
  sections: [
    {
      title: 'IP ihracat · kutu · net', service: 'FedEx International Priority (IP)', direction: 'export', priceType: 'net', packaging: 'box',
      zones: ['A', 'B'], weightMin: 0.5, weightMax: 1, currency: 'USD', pages: [1], hasAdditionalStep: false, hasPerKgBands: false,
    },
  ],
};
const EXTRACTION = {
  tables: [
    {
      sectionId: 's1',
      zones: ['A', 'B'],
      rows: [
        { kind: 'weight', label: '0.5', weight: 0.5, from: null, step: null, cells: ['11.10', '15.30'], page: 1 },
        { kind: 'weight', label: '1', weight: 1, from: null, step: null, cells: ['12.40', '16.80'], page: 1 },
      ],
    },
  ],
  countries: [],
  notes: [],
};

async function tariffPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  ['FedEx International Priority (IP) Net Ucretler', 'AGIRLIK A B', '0.5 11.10 15.30', '1 12.40 16.80', uniq('ref ')].forEach((t, i) => p.drawText(t, { x: 40, y: 800 - i * 14, size: 9, font }));
  return Buffer.from(await doc.save());
}

describe('TARIFF_PDF_SCAN ve TARIFF_PDF_EXTRACT', () => {
  let tariffCarrier: string;

  beforeAll(async () => {
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'ups', name: uniq('UPS ') } });
    expect(c.statusCode, c.body).toBe(201);
    tariffCarrier = c.json().carrier.id;
  });

  beforeEach(() => {
    reply = (system) => ({ text: JSON.stringify(system.startsWith('You analyse') ? DISCOVERY : EXTRACTION) });
  });

  async function uploadDoc() {
    const form = multipart([
      { name: 'carrierId', value: tariffCarrier },
      { name: 'file', filename: 'tarife.pdf', contentType: 'application/pdf', data: await tariffPdf() },
    ]);
    const up = await app.inject({ method: 'POST', url: `${API}/tariff-imports`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(up.statusCode, up.body).toBe(200);
    return up.json().documentId as string;
  }
  const post = (url: string, payload: unknown, h: Record<string, string> = {}) => app.inject({ method: 'POST', url: `${API}${url}`, headers: { ...auth, ...h }, payload: payload as object });

  it('yapay zekâ taraması ?async=1: 202 { job, joined }; sonuç belgeye yazılır; kod taraması eşzamanlı kalır; async olmadan 400 ASYNC_REQUIRED', async () => {
    const docId = await uploadDoc();
    const r = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
    expect(r.statusCode, r.body).toBe(202);
    const { job, joined } = r.json();
    expect(joined).toBe(false);
    expect(job).toMatchObject({ kind: 'TARIFF_PDF_SCAN', status: 'SUCCEEDED', ref: { type: 'TariffDocument', id: docId }, label: 'tarife.pdf' });
    expect(job.result).toMatchObject({ mode: 'ai', sections: [{ id: 's1', packaging: 'box' }], suggestedSectionIds: ['s1'] });
    const doc = await app.inject({ method: 'GET', url: `${API}/tariff-documents/${docId}`, headers: auth });
    expect(doc.json().lastScan).toEqual(job.result);
    // kod taraması: her zaman 200 (async yok sayılır)
    const code = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'code' });
    expect(code.statusCode, code.body).toBe(200);
    expect(code.json().mode).toBe('code');
    // yapay zekâ taramasının kaydı ezilmedi
    const stored = await inCompany(companyId, () => prisma.tariffDocument.findFirstOrThrow({ where: { id: docId }, select: { discovery: true } }));
    expect(Object.keys(stored.discovery as object).sort()).toEqual(['ai', 'code']);
    // denetim kaydı işi başlatanın adıyla
    const log = await inCompany(companyId, () => prisma.auditLog.findFirst({ where: { companyId, action: 'tariff.import.pdf.scan', data: { path: ['mode'], equals: 'ai' } }, orderBy: { createdAt: 'desc' } }));
    expect(log?.userId).toBeTruthy();
    // Y83: eski eşzamanlı yapay zekâ taraması (async yok) kapandı: 400 ASYNC_REQUIRED, iş açılmaz, sağlayıcı çağrılmaz
    const scans = await jobRows('TARIFF_PDF_SCAN');
    const callsBefore = calls.length;
    expectAsyncRequired(await post(`/tariff-documents/${docId}/scan`, { mode: 'ai' }));
    expect(await jobRows('TARIFF_PDF_SCAN')).toBe(scans);
    expect(calls).toHaveLength(callsBefore);
  });

  it('İngilizce tarama işi İngilizce istemle çalışır; Türkçe ayrı iş ve ayrı yapay zekâ çağrısı', async () => {
    const docId = await uploadDoc();
    const en = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' }, { 'accept-language': 'en' });
    expect(en.statusCode, en.body).toBe(202);
    expect(en.json().job.status).toBe('SUCCEEDED');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain('Write free text in English');
    const tr = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
    expect(tr.json().job.id).not.toBe(en.json().job.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).not.toContain('Write free text in English');
    const keys = await inCompany(companyId, () => prisma.job.findMany({ where: { companyId, refId: docId, kind: 'TARIFF_PDF_SCAN' }, select: { dedupeKey: true }, orderBy: { createdAt: 'asc' } }));
    expect(keys.map((k) => k.dedupeKey)).toEqual([`scan-ai:${docId}:en`, `scan-ai:${docId}:tr`]);
  });

  it('fiyat okuma ?async=1: 202 { job, joined }; seçim params\'ta; sonuç GET /jobs/:id ile; async olmadan 400 ASYNC_REQUIRED; eski jobs ucu kaldırıldı (404)', async () => {
    const docId = await uploadDoc();
    const scan = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
    expect(scan.statusCode, scan.body).toBe(202);
    calls.length = 0;
    // seçim hatası iş açılmadan 400
    const before = await jobRows('TARIFF_PDF_EXTRACT');
    const bad = await post(`/tariff-documents/${docId}/extract?async=1`, { sectionIds: ['s9'], includeCountryZones: false, target: { newTariff: { name: null, service: null } } });
    expect(bad.statusCode).toBe(400);
    expect(await jobRows('TARIFF_PDF_EXTRACT')).toBe(before);

    const body = { sectionIds: ['s1'], includeCountryZones: false, target: { newTariff: { name: null, service: null } } };
    // Y83: eski eşzamanlı okuma (async yok) kapandı: 400 ASYNC_REQUIRED, iş açılmaz, sağlayıcı çağrılmaz
    expectAsyncRequired(await post(`/tariff-documents/${docId}/extract`, body));
    expect(await jobRows('TARIFF_PDF_EXTRACT')).toBe(before);
    expect(calls).toHaveLength(0);

    const r = await post(`/tariff-documents/${docId}/extract?async=1`, body);
    expect(r.statusCode, r.body).toBe(202);
    const started = r.json();
    // eski istemcinin `jobId`/`status` alanları kalktı: yanıt yalnız { job, joined }
    expect(Object.keys(started).sort()).toEqual(['job', 'joined']);
    expect(started.joined).toBe(false);
    expect(started.job).toMatchObject({ kind: 'TARIFF_PDF_EXTRACT', status: 'SUCCEEDED', params: { sectionIds: ['s1'], includeCountryZones: false, pricing: 'table' } });
    expect(started.job.params).not.toHaveProperty('target');
    expect(started.job.result).toMatchObject({ kind: 'pdf', draftId: expect.any(String), verification: { method: 'ai' } });
    expect(calls).toHaveLength(1);

    // sonuç tek iş ucundan (eski ucun "done" durumu = SUCCEEDED)
    const view = await app.inject({ method: 'GET', url: `${API}/jobs/${started.job.id}`, headers: auth });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ id: started.job.id, status: 'SUCCEEDED', elapsedMs: expect.any(Number), result: started.job.result });
    // eski `GET /tariff-documents/:documentId/jobs/:jobId` yolu yok: bu belgenin ve başka belgenin adresi 404 (yol bulunamadı)
    const other = await uploadDoc();
    for (const d of [docId, other]) {
      const legacy = await app.inject({ method: 'GET', url: `${API}/tariff-documents/${d}/jobs/${started.job.id}`, headers: auth });
      expect(legacy.statusCode, legacy.body).toBe(404);
      // Yol bulunamayınca oturum okunmaz: dil yalnız başlıktan, başlık yoksa İngilizce (karar 2026-11-12; eskiden Türkçe).
      expect(legacy.json().error).toEqual({ code: 'NOT_FOUND', message: m('err.pageNotFound', undefined, 'en') });
    }
    // tarama da arka planda: bu belgede tek tarama işi (yukarıdaki)
    expect(await inCompany(companyId, () => prisma.job.count({ where: { companyId, refId: docId, kind: 'TARIFF_PDF_SCAN' } }))).toBe(1);
  });

  it('Y90: tarifeyi görüp düzenleyemeyen üye (Muhasebe) fiyat okuma işini GET /jobs/:id ile okuyamaz (404), listesinde görmez; eski jobs adresi de 404', async () => {
    const docId = await uploadDoc();
    expect((await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' })).statusCode).toBe(202);
    const r = await post(`/tariff-documents/${docId}/extract?async=1`, { sectionIds: ['s1'], includeCountryZones: false, target: { newTariff: { name: null, service: null } } });
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job).toMatchObject({ kind: 'TARIFF_PDF_EXTRACT', status: 'SUCCEEDED' });
    expect((await jobOf(job.id)).status).toBe('SUCCEEDED'); // başlatan (yönetici) okur

    const accounting = await createMember(app, auth, 'ACCOUNTING', 'Muhasebe Test');
    const asAccounting = (method: 'GET' | 'POST', url: string) =>
      app.inject({ method, url: `${API}${url}`, headers: accounting.auth, ...(method === 'POST' ? { payload: {} } : {}) });
    // görme izni var (belge açılır), düzenleme izni yok (okuma başlatamaz)
    expect((await asAccounting('GET', `/tariff-documents/${docId}`)).statusCode).toBe(200);
    expect((await post(`/tariff-documents/${docId}/extract?async=1`, { sectionIds: ['s1'] }, accounting.auth)).statusCode).toBe(403);
    // iş, türün izni (tariffs.edit) olmadan yok sayılır: 404, sonuç sızmaz
    const seen = await asAccounting('GET', `/jobs/${job.id}`);
    expect(seen.statusCode, seen.body).toBe(404);
    expect(seen.body).not.toContain(job.result.draftId);
    expect((await asAccounting('POST', `/jobs/${job.id}/cancel`)).statusCode).toBe(404);
    const list = await asAccounting('GET', '/jobs?kind=TARIFF_PDF_EXTRACT');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((j: { id: string }) => j.id)).not.toContain(job.id);
    // eskiden tariffs.view ile açılan yol kaldırıldı: 404
    const legacy = await asAccounting('GET', `/tariff-documents/${docId}/jobs/${job.id}`);
    expect(legacy.statusCode, legacy.body).toBe(404);
    expect(legacy.body).not.toContain(job.result.draftId);
  });

  it('kota doluyken yapay zekâ taraması ve okuması iş açmaz (429), sağlayıcı çağrılmaz', async () => {
    const docId = await uploadDoc();
    const scan = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
    expect(scan.statusCode, scan.body).toBe(202);
    calls.length = 0;
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '0';
    const scans = await jobRows('TARIFF_PDF_SCAN');
    const r = await post(`/tariff-documents/${docId}/scan?async=1&fresh=1`, { mode: 'ai' });
    expect(r.statusCode, r.body).toBe(429);
    expect(r.json().error.code).toBe('AI_QUOTA_EXCEEDED');
    expect(await jobRows('TARIFF_PDF_SCAN')).toBe(scans);
    const extracts = await jobRows('TARIFF_PDF_EXTRACT');
    const ex = await post(`/tariff-documents/${docId}/extract?async=1`, { sectionIds: ['s1'], includeCountryZones: false, target: { newTariff: { name: null, service: null } } });
    expect(ex.statusCode, ex.body).toBe(429);
    expect(await jobRows('TARIFF_PDF_EXTRACT')).toBe(extracts);
    expect(calls).toHaveLength(0);
  });

  it('R0 5: fiyat okuma işi kuyrukta beklerken PDF yeniden taranırsa iş 409 SCAN_CHANGED ile biter (taslak yok); aynı seçim yeni iş açar', async () => {
    const docId = await uploadDoc();
    const scan = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
    expect(scan.statusCode, scan.body).toBe(202);
    const body = { sectionIds: ['s1'], includeCountryZones: false, target: { newTariff: { name: null, service: null } } };
    const drafts = () => inCompany(companyId, () => prisma.tariffImportDraft.count({ where: { companyId } }));
    process.env.JOB_RUNNER = 'off'; // iş yalnız kuyruğa yazılır, alınmaz
    try {
      const r = await post(`/tariff-documents/${docId}/extract?async=1`, body);
      expect(r.statusCode, r.body).toBe(202);
      const queued = r.json();
      // eski `status: 'running'` alanı kalktı; aynı bilgi `job.status` (QUEUED)
      expect(Object.keys(queued).sort()).toEqual(['job', 'joined']);
      expect(queued).toMatchObject({ joined: false, job: { status: 'QUEUED' } });
      const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { id: queued.job.id }, select: { input: true } }));
      expect(row.input).toMatchObject({ scans: { code: null, ai: expect.any(String) } });
      // iş beklerken belge yeniden taranır: bölüm kimliği artık başka taramanın tablosunu gösterebilir
      await new Promise((res) => setTimeout(res, 5));
      // yeniden tarama da arka plan işi: satır içi kipte hemen biter (satır içi kip yalnız başlattığı işi çalıştırır;
      // bekleyen okuma işi alınmaz), sonra kuyruk yeniden kapanır
      process.env.JOB_RUNNER = 'inline';
      const rescan = await post(`/tariff-documents/${docId}/scan?async=1`, { mode: 'ai' });
      process.env.JOB_RUNNER = 'off';
      expect(rescan.statusCode, rescan.body).toBe(202);
      expect(rescan.json().job.status).toBe('SUCCEEDED');
      // aynı seçim yeniden: bayat işe bağlanmaz, yeni iş
      const again = (await post(`/tariff-documents/${docId}/extract?async=1`, body)).json();
      expect(again.joined).toBe(false);
      expect(again.job.id).not.toBe(queued.job.id);

      process.env.JOB_RUNNER = 'inline';
      calls.length = 0;
      const before = await drafts();
      const { kickJob } = await import('../src/services/jobs/queue.ts');
      await kickJob(queued.job.id);
      expect(await jobOf(queued.job.id)).toMatchObject({ status: 'FAILED', error: { statusCode: 409, code: 'SCAN_CHANGED', message: m('tariff.scanChanged', undefined, 'tr') } });
      expect(calls).toHaveLength(0); // yanlış tablo için yapay zekâ çağrılmadı
      expect(await drafts()).toBe(before);
      // eski jobs ucunun "failed + SCAN_CHANGED" bilgisi yukarıda GET /jobs/:id ile sınandı; eski yol kaldırıldı (404)
      expect((await app.inject({ method: 'GET', url: `${API}/tariff-documents/${docId}/jobs/${queued.job.id}`, headers: auth })).statusCode).toBe(404);
      // yeni taramaya dayanan iş biter
      await kickJob(again.job.id);
      expect(await jobOf(again.job.id)).toMatchObject({ status: 'SUCCEEDED', result: { kind: 'pdf' } });
      expect(await drafts()).toBe(before + 1);
    } finally {
      process.env.JOB_RUNNER = 'inline';
    }
  });
});

// ---------- R0 2a: ücretli satır ve önbellek tek işlemde ----------

describe('çift ücret: sayaç ve önbellek birlikte yazılır', () => {
  /** Önbelleğe ekleme veritabanında bağlantı hatası koduyla düşer (sahte arıza; süper kullanıcıyla tetikleyici). */
  async function withCacheFault<T>(work: () => Promise<T>): Promise<T> {
    const sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
    try {
      await sup.query(`CREATE OR REPLACE FUNCTION deciship.p2_test_cache_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated connection loss' USING ERRCODE = '08006'; END $$`);
      await sup.query(`CREATE TRIGGER p2_test_cache_fault BEFORE INSERT ON deciship."AiResultCache" FOR EACH ROW EXECUTE FUNCTION deciship.p2_test_cache_fault()`);
      return await work();
    } finally {
      await sup.query('DROP TRIGGER IF EXISTS p2_test_cache_fault ON deciship."AiResultCache"');
      await sup.query('DROP FUNCTION IF EXISTS deciship.p2_test_cache_fault()');
      await sup.end();
    }
  }

  it('önbellek yazımı bağlantı hatasıyla düşer → iş kuyruğa döner → ikinci deneme: firmaya tek OK (iki OK asla)', async () => {
    const pdf = await invoicePdf();
    const first = await withCacheFault(async () => {
      failAfterAiOnce = true; // yapay zekâdan sonraki adım da düşer (bağlantı kopmuş): iş geçici hatayla kuyruğa döner
      const r = await previewReq(pdf);
      expect(r.statusCode, r.body).toBe(202);
      return r.json().job;
    });
    expect(first).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(1);
    const fileId = first.ref.id as string;
    // önbellek yazılamadığı için ücretli satır da yazılmadı (ikisi tek işlemde)
    expect(await usageFor(fileId)).toEqual([]);

    const { kickJob } = await import('../src/services/jobs/queue.ts');
    await kickJob(first.id);
    expect(await jobOf(first.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: false } });
    expect(calls).toHaveLength(2);
    expect((await usageFor(fileId)).map((u) => u.status)).toEqual(['OK']);
    // şimdi ikisi birlikte: önbellek satırı bu OK satırını gösterir
    const ok = await inCompany(companyId, () => prisma.aiUsage.findFirstOrThrow({ where: { companyId, refId: fileId, status: 'OK' }, select: { id: true, cacheKey: true } }));
    const cached = await inCompany(companyId, () => prisma.aiResultCache.findFirst({ where: { companyId, kind: 'INVOICE_PDF', cacheKey: ok.cacheKey! }, select: { usageId: true } }));
    expect(cached?.usageId).toBe(ok.id);
    // aynı dosya yeniden: ücretsiz
    expect((await previewReq(pdf)).json().job.result.aiCached).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ---------- R0 7b: gerçek döngü (JOB_RUNNER=on) ----------

describe('gerçek çalıştırıcı döngüsü', () => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  let runner: { stop(): Promise<void> } | null = null;

  afterEach(async () => {
    await runner?.stop();
    runner = null;
    process.env.JOB_RUNNER = 'inline';
  });

  it('PDF fatura okuma: 202 → döngü alır → SUCCEEDED, File.preview yazılır; stop() sonrası çalıştırıcının açık zamanlayıcısı kalmaz', async () => {
    type Tracked = { kind: 'timeout' | 'interval'; handle: NodeJS.Timeout; cleared: boolean; fired: boolean };
    const tracked: Tracked[] = [];
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
    // yalnız runner.ts'in doğrudan kurduğu zamanlayıcılar (sürücünün iç zamanlayıcıları değil)
    const fromRunner = () => {
      const caller = (new Error().stack ?? '').split('\n').slice(1).find((l) => !l.includes('jobKinds.test.ts'));
      return !!caller && /services[\\/]jobs[\\/]runner\.ts/.test(caller);
    };
    const find = (h: unknown) => tracked.find((t) => t.handle === h);
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const t: Tracked | null = fromRunner() ? { kind: 'timeout', handle: null as unknown as NodeJS.Timeout, cleared: false, fired: false } : null;
      const h = real.setTimeout(
        (...a: unknown[]) => {
          if (t) t.fired = true;
          fn(...a);
        },
        ms,
        ...args,
      );
      if (t) tracked.push(Object.assign(t, { handle: h }));
      return h;
    }) as typeof setTimeout;
    globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const h = real.setInterval(fn, ms, ...args);
      if (fromRunner()) tracked.push({ kind: 'interval', handle: h, cleared: false, fired: false });
      return h;
    }) as typeof setInterval;
    globalThis.clearTimeout = ((h?: NodeJS.Timeout) => {
      const t = find(h);
      if (t) t.cleared = true;
      real.clearTimeout(h);
    }) as typeof clearTimeout;
    globalThis.clearInterval = ((h?: NodeJS.Timeout) => {
      const t = find(h);
      if (t) t.cleared = true;
      real.clearInterval(h);
    }) as typeof clearInterval;

    try {
      const { startJobRunner } = await import('../src/services/jobs/runner.ts');
      process.env.JOB_RUNNER = 'on';
      runner = startJobRunner(silent, { pollMs: 20, leaseMs: 2000, graceMs: 300 });
      const pdf = await invoicePdf();
      let open!: () => void;
      gate = new Promise<void>((res) => (open = res));
      const r = await previewReq(pdf);
      expect(r.statusCode, r.body).toBe(202);
      const { job, joined } = r.json();
      expect(joined).toBe(false);
      // istek işi beklemeden döndü (satır içi değil): iş sırada ya da sürüyor
      expect(['QUEUED', 'RUNNING']).toContain(job.status);
      await until(() => calls.length === 1);
      open();
      let view = await jobOf(job.id);
      const end = Date.now() + 10_000;
      while (view.status !== 'SUCCEEDED' && view.status !== 'FAILED' && Date.now() < end) {
        await new Promise((res) => real.setTimeout(res, 20));
        view = await jobOf(job.id);
      }
      expect(view).toMatchObject({ status: 'SUCCEEDED', attempt: 1, result: { format: 'pdf', aiSkipped: { count: 1, amount: 45 } } });
      const [file] = await filesWithSha(sha256(pdf));
      expect(file!.preview).toMatchObject({ v: 1, method: 'text', skipped: [{ rowIndex: 1, reason: 'NO_TRACKING', amount: 45 }] });
      expect((file!.preview as { pageTexts?: string[] }).pageTexts?.[0]).toContain('794812345305');
      await runner.stop();
      runner = null;
      await new Promise((res) => real.setTimeout(res, 50));
    } finally {
      Object.assign(globalThis, real);
    }
    expect(tracked.some((t) => t.kind === 'interval')).toBe(true); // kalp atışı izlendi
    expect(tracked.every((t) => t.handle.hasRef() === false)).toBe(true);
    expect(tracked.filter((t) => !t.cleared && !(t.kind === 'timeout' && t.fired))).toEqual([]);
  });
});

// ---------- Ek E1: büyük PDF sayfa gruplarıyla ----------

describe('E1: büyük PDF fatura sayfa gruplarıyla okunur', () => {
  const track = (page: number) => `79480000${String(page).padStart(4, '0')}`;

  /** `n` sayfa; her sayfada bir gönderi satırı (takip no + tutar = sayfa × 10), ilk sayfada fatura başlığı. */
  async function multiPagePdf(n: number, tag = uniq('t')): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= n; i++) {
      const page = doc.addPage([595, 842]);
      const rows = [...(i === 1 ? ['FATURA 9-482-11735', `ref ${tag}`] : []), `${track(i)} 20.10.2026 ${i * 10},00`, `Sayfa ${i}`];
      rows.forEach((r, k) => page.drawText(r, { x: 40, y: 800 - k * 18, size: 11, font }));
    }
    return Buffer.from(await doc.save());
  }

  /** Grup isteğinden sayfa aralığı ("pages 6–10 of a 12-page"); tek çağrıda null. */
  const rangeOf = (user: string) => {
    const m2 = /pages (\d+)–(\d+) of a (\d+)-page/.exec(user);
    return m2 ? { from: Number(m2[1]), to: Number(m2[2]), pages: Number(m2[3]) } : null;
  };
  /** Sahte okuma: gruptaki her sayfanın satırı; başlık yalnız 1. sayfada. Tek çağrıda bütün sayfalar. */
  type PartOver = { amountsIncludeVat?: boolean | null; invoiceNo?: string | null; leadingNoTracking?: boolean };
  const partReply =
    (n: number, truncate?: (r: { from: number; to: number }) => boolean, over?: (r: { from: number; to: number }) => PartOver) =>
    (_system: string, user: string): Reply => {
      const r = rangeOf(user) ?? { from: 1, to: n, pages: n };
      if (truncate?.(r)) return { stop_reason: 'max_tokens', text: '{' };
      const o = over?.(r) ?? {};
      const lines = [];
      // sayfa sınırında bölünmüş satırın devamı: grubun başında takip no'suz, tutarlı satır
      if (o.leadingNoTracking) lines.push(aiLine('', 7));
      for (let p = r.from; p <= r.to; p++) lines.push(aiLine(track(p), p * 10));
      return {
        text: JSON.stringify({
          invoiceNo: 'invoiceNo' in o ? o.invoiceNo : r.from === 1 ? '9-482-11735' : null,
          invoiceDate: r.from === 1 ? '2026-10-27' : null,
          currency: null,
          amountsIncludeVat: 'amountsIncludeVat' in o ? o.amountsIncludeVat : false,
          lines,
        }),
      };
    };
  const partCalls = () => calls.map((c) => rangeOf(c.user)).filter((r): r is NonNullable<ReturnType<typeof rangeOf>> => r != null).map((r) => `${r.from}-${r.to}`);
  const companyUsage = () => inCompany(companyId, () => prisma.aiUsage.findMany({ where: { companyId, kind: 'INVOICE_PDF' }, select: { status: true, refId: true } }));

  afterEach(() => {
    delete process.env.PDF_INVOICE_PAGES_PER_CALL;
  });

  it('eşik ve altı (5 sayfa) bugünkü gibi tek çağrı: aynı istem, kesme yok', async () => {
    reply = partReply(5);
    const { job } = (await previewReq(await multiPagePdf(5))).json();
    expect(job).toMatchObject({ status: 'SUCCEEDED', progress: { stage: 'pdfCheck' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).not.toContain('only some pages');
    expect(calls[0]!.user).toContain('Extract every shipment line of this invoice.');
    expect(job.result.aiLines).toHaveLength(5);
  });

  it('12 sayfa → 3 grup (1–5, 6–10, 11–12): satırlar tam, sırada, tekrarsız; başlık 1. gruptan; metin denetimi birleşik sonuçta', async () => {
    reply = partReply(12);
    const pdf = await multiPagePdf(12);
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job.status).toBe('SUCCEEDED');
    expect(partCalls()).toEqual(['1-5', '6-10', '11-12']);
    expect(calls.every((c) => c.system.includes('only some pages'))).toBe(true);
    const res = job.result;
    expect(res.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(Array.from({ length: 12 }, (_, i) => track(i + 1)));
    expect(res.aiLines.map((l: { netAmount: number }) => l.netAmount)).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 10));
    // Y23: satır no yapay zekâ çıktısındaki sıra (0 tabanlı, takip no'suzlar dahil; ekranda +1)
    expect(res.aiLines.map((l: { rowIndex: number }) => l.rowIndex)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(res.guessedMeta).toMatchObject({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27' });
    expect(res.pdfCheck).toMatchObject({ method: 'text', checked: 12, unverified: 0 });
    expect(res.aiCached).toBe(false);
    // her grup ayrı ölçülür: firmaya grup başına bir OK
    expect((await usageFor(res.fileId)).map((u) => u.status)).toEqual(['OK', 'OK', 'OK']);
    // aynı dosya yeniden: bütün gruplar ücretsiz
    calls.length = 0;
    const again = (await previewReq(pdf)).json().job;
    expect(again.result).toMatchObject({ aiCached: true });
    expect(calls).toHaveLength(0);
    expect((await usageFor(again.result.fileId)).map((u) => u.status)).toEqual(['CACHED', 'CACHED', 'CACHED']);
  });

  it('kesilen grup ikiye bölünüp okunur; tek sayfa da kesilirse açık hata (422 AI_TRUNCATED)', async () => {
    reply = partReply(12, (r) => r.to - r.from + 1 >= 5);
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.status).toBe('SUCCEEDED');
    expect(partCalls()).toEqual(['1-5', '1-3', '4-5', '6-10', '6-8', '9-10', '11-12']);
    expect(job.result.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(Array.from({ length: 12 }, (_, i) => track(i + 1)));
    // kesilen çağrılar FAILED (kotadan düşmez), okunanlar OK
    expect((await usageFor(job.result.fileId)).map((u) => u.status).sort()).toEqual(['FAILED', 'FAILED', 'OK', 'OK', 'OK', 'OK', 'OK']);

    calls.length = 0;
    reply = partReply(12, () => true);
    const bad = (await previewReq(await multiPagePdf(12))).json().job;
    expect(bad).toMatchObject({ status: 'FAILED', error: { statusCode: 422, code: 'AI_TRUNCATED' } });
    expect(partCalls()).toEqual(['1-5', '1-3', '1-2', '1-1']);
  });

  it('yeniden deneme: okunmuş gruplar CACHED; firmaya grup başına tek OK', async () => {
    reply = partReply(12);
    failAfterAiOnce = true; // bütün gruplar okunduktan sonra geçici hata (süreç düştü)
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(3);
    const { kickJob } = await import('../src/services/jobs/queue.ts');
    await kickJob(job.id);
    expect(await jobOf(job.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: true } });
    expect(calls).toHaveLength(3);
    const statuses = (await usageFor(job.ref.id)).map((u) => u.status);
    expect(statuses.filter((s) => s === 'OK')).toHaveLength(3);
    expect(statuses.filter((s) => s === 'CACHED')).toHaveLength(3);
  });

  it('kota iş sürerken dolar → FAILED AI_QUOTA_EXCEEDED; hak gelince yeniden okuma okunmuş grubu ücretsiz alır', async () => {
    const base = partReply(12);
    reply = (system, user) => {
      // 1. grubun yanıtı gelirken hak biter: 2. grubun kota denetimi durdurur
      if (rangeOf(user)?.from === 1) process.env.AI_FREE_CREDIT_MONTHLY_TRY = '0';
      return base(system, user);
    };
    const pdf = await multiPagePdf(12);
    const before = await companyUsage();
    const { job } = (await previewReq(pdf)).json();
    expect(job).toMatchObject({ status: 'FAILED', error: { statusCode: 429, code: 'AI_QUOTA_EXCEEDED' } });
    expect(partCalls()).toEqual(['1-5']);
    expect((await usageFor(job.ref.id)).map((u) => u.status)).toEqual(['OK']);
    // başarısız okumanın önizleme dosyası silindi
    expect(await filesWithSha(sha256(pdf))).toEqual([]);

    delete process.env.AI_FREE_CREDIT_MONTHLY_TRY; // hak geldi
    reply = base;
    calls.length = 0;
    const again = (await previewReq(pdf)).json().job;
    expect(again.status).toBe('SUCCEEDED');
    expect(partCalls()).toEqual(['6-10', '11-12']);
    expect((await usageFor(again.ref.id)).map((u) => u.status)).toEqual(['CACHED', 'OK', 'OK']);
    expect(again.result.aiLines).toHaveLength(12);
    // iki okumada toplam: grup başına tek OK
    const after = (await companyUsage()).slice(before.length);
    expect(after.filter((u) => u.status === 'OK')).toHaveLength(3);
  });

  it('durdurma (KALANLAR 6.5): süren grubun çağrısı kesilir, sonraki grup okunmaz; dosya silinir; yeniden okuma bütün grupları okur', async () => {
    reply = partReply(12);
    const pdf = await multiPagePdf(12);
    let open!: () => void;
    gate = new Promise<void>((res) => (open = res));
    const first = previewReq(pdf);
    await until(() => calls.length === 1);
    gate = null;
    const [file] = await filesWithSha(sha256(pdf));
    const running = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { companyId, refId: file!.id }, select: { id: true } }));
    const c = await app.inject({ method: 'POST', url: `${API}/jobs/${running.id}/cancel`, headers: auth, payload: {} });
    expect(c.statusCode, c.body).toBe(200);
    // kapı açılmadan: süren grubun çağrısı sinyalle kesilir
    expect((await first).json().job).toMatchObject({ id: running.id, status: 'CANCELLED' });
    open();
    expect(partCalls()).toEqual(['1-5']);
    expect(await filesWithSha(sha256(pdf))).toEqual([]);
    expect((await usageFor(file!.id)).map((u) => u.status)).toEqual(['FAILED']);
    const again = (await previewReq(pdf)).json().job;
    expect(again.status).toBe('SUCCEEDED');
    // kesilen grubun sonucu yok: yeniden okunur (ücret yeniden)
    expect(partCalls()).toEqual(['1-5', '1-5', '6-10', '11-12']);
    expect((await usageFor(again.ref.id)).map((u) => u.status)).toEqual(['OK', 'OK', 'OK']);
  });

  it('ilerleme sayfa cinsinden: aşama pdfPages, done / total okunmuş / toplam sayfa, okunan grup counters.from–to', async () => {
    reply = partReply(12);
    replyDelayMs = 1100; // ilerleme saniyede en çok bir kez yazılır: grup arası yazım görünsün
    const pdf = await multiPagePdf(12);
    const first = previewReq(pdf);
    await until(() => calls.length === 2, 10_000); // 2. grup (6–10) okunuyor
    const [file] = await filesWithSha(sha256(pdf));
    const row = await inCompany(companyId, () => prisma.job.findFirstOrThrow({ where: { companyId, refId: file!.id }, select: { id: true } }));
    const view = await jobOf(row.id);
    expect(view).toMatchObject({ status: 'RUNNING', progress: { stage: 'pdfPages', done: 5, total: 12 }, counters: { from: 6, to: 10 } });
    const done = (await first).json().job;
    expect(done).toMatchObject({ status: 'SUCCEEDED', progress: { stage: 'pdfCheck', done: 12, total: 12 } });
  }, 30_000);

  it('fresh: önceki grup sonuçları kullanılmaz (yeniden ücret); işin kendi grupları yeniden denemede ücretsiz', async () => {
    reply = partReply(12);
    const pdf = await multiPagePdf(12);
    expect((await previewReq(pdf)).json().job.status).toBe('SUCCEEDED');
    expect(calls).toHaveLength(3);
    failAfterAiOnce = true;
    const { job } = (await previewReq(pdf, '?async=1&fresh=1')).json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(6);
    const { kickJob } = await import('../src/services/jobs/queue.ts');
    await kickJob(job.id);
    expect(await jobOf(job.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: true } });
    expect(calls).toHaveLength(6);
    const statuses = (await usageFor(job.ref.id)).map((u) => u.status);
    expect(statuses.filter((s) => s === 'OK')).toHaveLength(3);
    expect(statuses.filter((s) => s === 'CACHED')).toHaveLength(3);
  });

  it('grup boyu PDF_INVOICE_PAGES_PER_CALL (arka plan yolu); async olmadan 400 ASYNC_REQUIRED, sağlayıcı çağrılmaz', async () => {
    process.env.PDF_INVOICE_PAGES_PER_CALL = '4';
    reply = partReply(12);
    const pdf = await multiPagePdf(12);
    // Y83: eski eşzamanlı yol kapandı
    expectAsyncRequired(await previewReq(pdf, ''));
    expect(calls).toHaveLength(0);
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
    ]);
    const r = await viaJob(app, { method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(200);
    expect(partCalls()).toEqual(['1-4', '5-8', '9-12']);
    expect(r.json().aiLines).toHaveLength(12);
  });
  // ---------- R3 bulguları ----------

  const importLines = (fileId: string, lines: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines, confirmOverlap: true },
    });
  const linesOf = async (invoiceId: string, query = '') =>
    (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100${query}`, headers: auth })).json().items as { trackingNo: string; parseFlags: string[] }[];

  it('R3 1: şifreli (yalnız sahip parolalı) 12 sayfalık PDF kesilmez: tek çağrı (RC4 ve AES-256)', async () => {
    for (const name of ['encrypted-rc4-12p.pdf', 'encrypted-aes256-12p.pdf']) {
      calls.length = 0;
      const pdf = fs.readFileSync(new URL(`./pdf-fixtures/${name}`, import.meta.url));
      reply = partReply(12);
      const { job } = (await previewReq(pdf)).json();
      expect(job.status, name).toBe('SUCCEEDED');
      // sayfa sayısı biliniyordu (kesme yolu seçilebilirdi): tek çağrı, bütün belge
      const [file] = await filesWithSha(sha256(pdf));
      expect((file!.preview as { pageTexts?: string[] }).pageTexts, name).toHaveLength(12);
      expect(calls, name).toHaveLength(1);
      expect(calls[0]!.user, name).toContain('Extract every shipment line of this invoice.');
      expect(partCalls(), name).toEqual([]);
    }
  });

  it('R3 2: KDV bayrağı yalnız açık oylarla: [true, null, null] → KDV dahil (tutarlar nete çevrilir), bayrak yok', async () => {
    reply = partReply(12, undefined, (r) => ({ amountsIncludeVat: r.from === 1 ? true : null }));
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result.pdfReview).toBeUndefined();
    // 10 / 1,2 = 8,33; 120 / 1,2 = 100
    expect(job.result.aiLines[0].netAmount).toBe(8.33);
    expect(job.result.aiLines[11].netAmount).toBe(100);
    const imp = await importLines(job.result.fileId, job.result.aiLines);
    expect(imp.statusCode, imp.body).toBe(201);
    expect((await linesOf(imp.json().invoice.id)).flatMap((l) => l.parseFlags).filter((c) => c === 'PDF_VAT_UNCLEAR')).toEqual([]);
  });

  it('R3 2: gruplar KDV bayrağında çelişirse önizlemede uyarı, içe aktarmada bütün satırlar PDF_VAT_UNCLEAR ("İncele")', async () => {
    reply = partReply(12, undefined, (r) => ({ amountsIncludeVat: r.from === 1 ? true : r.from === 6 ? false : null }));
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.result.pdfReview).toMatchObject({ vatUnclear: true });
    expect(job.result.warning).toContain(m('invoice.pdfVatUnclear', undefined, 'tr'));
    const imp = await importLines(job.result.fileId, job.result.aiLines);
    expect(imp.statusCode, imp.body).toBe(201);
    const lines = await linesOf(imp.json().invoice.id);
    expect(lines).toHaveLength(12);
    expect(lines.every((l) => l.parseFlags.includes('PDF_VAT_UNCLEAR'))).toBe(true);
    expect(await linesOf(imp.json().invoice.id, '&flagged=true')).toHaveLength(12);
  });

  it('R3 2: gruplu yolda hiç açık oy yoksa da belirsiz (satırlar bayraklı)', async () => {
    reply = partReply(12, undefined, () => ({ amountsIncludeVat: null }));
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.result.pdfReview).toMatchObject({ vatUnclear: true });
    expect(job.result.aiLines[0].netAmount).toBe(10); // varsayılan: KDV hariç
  });

  it('R3 3: sonraki grubun ilk satırı takip no\'suzsa önceki grubun son satırı PDF_PAGE_BREAK; birleştirme yok, takip no\'suz satır sayılır', async () => {
    reply = partReply(12, undefined, (r) => ({ leadingNoTracking: r.from === 6 }));
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.result.aiLines).toHaveLength(12);
    // Y23: 5. sayfanın satırı birleşik okumada 4. sırada (0 tabanlı); 6. sayfanın başındaki takip no'suz satır 5. sırada
    expect(job.result.pdfReview).toMatchObject({ vatUnclear: false, pageBreakRows: [4] });
    expect(job.result.aiSkipped).toEqual({ count: 1, amount: 7 });
    expect(job.result.warning).toContain(m('invoice.pdfPageBreak', { count: 1 }, 'tr'));
    const imp = await importLines(job.result.fileId, job.result.aiLines);
    expect(imp.statusCode, imp.body).toBe(201);
    const flagged = (await linesOf(imp.json().invoice.id)).filter((l) => l.parseFlags.includes('PDF_PAGE_BREAK')).map((l) => l.trackingNo);
    expect(flagged).toEqual([track(5)]);
    expect(imp.json().importReport).toMatchObject({ skippedCount: 1, byReason: { NO_TRACKING: 1 } });
  });

  it('R3 4: başlık 1. sayfanın grubundan; gruplar arasında fatura no çelişirse uyarı', async () => {
    reply = partReply(12, undefined, (r) => (r.from === 6 ? { invoiceNo: 'BASKA-1' } : {}));
    const { job } = (await previewReq(await multiPagePdf(12))).json();
    expect(job.result.guessedMeta.invoiceNo).toBe('9-482-11735');
    expect(job.result.pdfReview).toMatchObject({ metaConflict: true, vatUnclear: false, pageBreakRows: [] });
    expect(job.result.warning).toContain(m('invoice.pdfMetaConflict', undefined, 'tr'));
  });

  it('R3 5: eşik altı (4 sayfa) tek çağrı kesilirse iki yarıyla gruplu okunur', async () => {
    reply = partReply(4, (r) => r.to - r.from + 1 >= 4);
    const { job } = (await previewReq(await multiPagePdf(4))).json();
    expect(job.status).toBe('SUCCEEDED');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.user).toContain('Extract every shipment line of this invoice.');
    expect(partCalls()).toEqual(['1-2', '3-4']);
    expect(job.result.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual([1, 2, 3, 4].map(track));
    expect((await usageFor(job.result.fileId)).map((u) => u.status)).toEqual(['FAILED', 'OK', 'OK']);
  });

  it('R3 6: kurulum örnek faturası da sayfa gruplarıyla okunur', async () => {
    reply = partReply(12);
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'ornek.pdf', contentType: 'application/pdf', data: await multiPagePdf(12) },
    ]);
    const r = await app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(201);
    expect(partCalls()).toEqual(['1-5', '6-10', '11-12']);
  });
});

describe('E1: birleştirme kuralı (saf işlev)', () => {
  type Part = { pages: number[]; data: { invoiceNo: string | null; invoiceDate: string | null; currency: string | null; amountsIncludeVat: boolean | null; lines: ReturnType<typeof aiLine>[] } };
  const part = (pages: number[], o: Partial<Part['data']> = {}): Part => ({
    pages,
    data: { invoiceNo: null, invoiceDate: null, currency: null, amountsIncludeVat: null, lines: [], ...o },
  });

  it('pageGroups', async () => {
    const { pageGroups } = await import('../src/services/invoicePdfRead.ts');
    expect(pageGroups(12, 5)).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]);
    expect(pageGroups(10, 5)).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
  });

  it('KDV: yalnız açık oylar; [true,null,null,null,true] → true; [true,false] ve hiç oy yok → belirsiz', async () => {
    const { mergePdfParts } = await import('../src/services/invoicePdfRead.ts');
    const votes = (v: (boolean | null)[]) => mergePdfParts(v.map((x, i) => part([i + 1], { amountsIncludeVat: x, lines: [aiLine(`T${i}`, 1)] })));
    expect(votes([true, null, null, null, true])).toMatchObject({ data: { amountsIncludeVat: true }, review: { vatUnclear: false } });
    expect(votes([null, false, null])).toMatchObject({ data: { amountsIncludeVat: false }, review: { vatUnclear: false } });
    expect(votes([true, false]).review.vatUnclear).toBe(true);
    expect(votes([true, false]).data.amountsIncludeVat).toBe(true); // 1. sayfanın oyu (yine de satırlar bayraklı)
    expect(votes([null, null])).toMatchObject({ data: { amountsIncludeVat: false }, review: { vatUnclear: true } });
  });

  it('sayfa sınırı: sonraki grubun ilk satırı takip no\'suz ya da aynı takip no → iki satır işaretli; birebir aynı iç satırlar korunur', async () => {
    const { mergePdfParts } = await import('../src/services/invoicePdfRead.ts');
    const same = aiLine('794812345305', 10);
    const noTrack = mergePdfParts([
      part([1], { amountsIncludeVat: false, lines: [aiLine('A1', 1), aiLine('A2', 2)] }),
      part([2], { lines: [aiLine('', 3), aiLine('B1', 4)] }),
    ]);
    expect(noTrack.data.lines.map((l) => l.trackingNo)).toEqual(['A1', 'A2', '', 'B1']);
    expect(noTrack.review.pageBreakLines).toEqual([1, 2]);
    const sameTrack = mergePdfParts([
      part([1], { amountsIncludeVat: false, lines: [same, aiLine('A2', 2), aiLine('794 8123 45306', 5)] }),
      part([2], { lines: [aiLine('794812345306', 6), same] }),
    ]);
    expect(sameTrack.data.lines).toHaveLength(5);
    expect(sameTrack.review.pageBreakLines).toEqual([2, 3]);
    // grup içindeki birebir aynı satır (gerçekten iki kez basılmış) sınırda değilse işaretlenmez, silinmez
    const inner = mergePdfParts([part([1], { amountsIncludeVat: false, lines: [same, same, aiLine('X', 1)] }), part([2], { lines: [aiLine('Y', 2)] })]);
    expect(inner.data.lines).toEqual([same, same, aiLine('X', 1), aiLine('Y', 2)]);
    expect(inner.review.pageBreakLines).toEqual([]);
  });

  it('başlık: 1. sayfayı içeren grup öncelikli; çelişki işaretlenir; para birimi büyük/küçük harf farkı çelişki değil', async () => {
    const { mergePdfParts } = await import('../src/services/invoicePdfRead.ts');
    const a = mergePdfParts([part([6, 7], { invoiceNo: 'B-2', currency: 'try' }), part([1, 2], { invoiceNo: 'A-1', currency: 'TRY', invoiceDate: '2026-10-27' })]);
    expect(a.data).toMatchObject({ invoiceNo: 'A-1', currency: 'TRY', invoiceDate: '2026-10-27' });
    expect(a.review.metaConflict).toBe(true);
    const b = mergePdfParts([part([1], { currency: 'TRY' }), part([2], { invoiceNo: 'A-1', currency: 'try' })]);
    expect(b.data).toMatchObject({ invoiceNo: 'A-1', currency: 'TRY' });
    expect(b.review.metaConflict).toBe(false);
  });
});
