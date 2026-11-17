// Fatura yüklemede yapay zekâ ile eşleme (10–30 sn): taşıyıcı ya da dosya değişince, sayfadan çıkınca süren istek iptal edilir,
// iptal hata sayılmaz ve eski sonuç yeni dosyanın üstüne yazılmaz (`InvoiceUpload.tsx`, `lib/latestRequest.ts`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latestRequest, unlessAborted } from '../src/lib/latestRequest.ts';

const { bindSessionFetch, request, ApiError } = await import('../src/api/client.ts');

describe('latestRequest', () => {
  it('yenisi başlayınca öncekinin sinyali kesilir, yenisi açık kalır', () => {
    const r = latestRequest();
    const first = r.start();
    const second = r.start();
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, false);
  });
  it('cancel süren isteği keser; istek yokken sorun çıkarmaz', () => {
    const r = latestRequest();
    r.cancel();
    const s = r.start();
    r.cancel();
    assert.equal(s.aborted, true);
    r.cancel();
  });
});

describe('unlessAborted', () => {
  it('iptal edilen istek null döner, hata fırlatmaz', async () => {
    const r = latestRequest();
    const signal = r.start();
    const run = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    r.cancel();
    assert.equal(await unlessAborted(signal, run), null);
  });
  it('sonuç iptalden sonra gelirse kullanılmaz', async () => {
    const r = latestRequest();
    const signal = r.start();
    let resolve!: (v: string) => void;
    const run = new Promise<string>((res) => (resolve = res));
    r.start(); // taşıyıcı değişti, yeni okuma başladı
    resolve('eski dosyanın eşlemesi');
    assert.equal(await unlessAborted(signal, run), null);
  });
  it('iptal edilmemişse sonuç olduğu gibi döner, başka hata olduğu gibi fırlar', async () => {
    const r = latestRequest();
    assert.equal(await unlessAborted(r.start(), Promise.resolve('eşleme')), 'eşleme');
    const boom = new Error('sunucu hatası');
    await assert.rejects(unlessAborted(r.start(), Promise.reject(boom)), (e) => e === boom);
  });
});

describe('istek katmanı sinyali taşır', () => {
  it('sinyal oturum isteğine gider; iptal AbortError olarak kalır (ağ hatasına çevrilmez)', async () => {
    let seen: AbortSignal | undefined;
    bindSessionFetch((_path, init) => {
      seen = init.signal;
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const ctrl = new AbortController();
    const pending = request('/invoices/preview/ai-mapping', { body: { fileId: 'f' }, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(pending, (e: unknown) => !(e instanceof ApiError) && (e as Error).name === 'AbortError');
    assert.equal(seen, ctrl.signal);
  });
});
