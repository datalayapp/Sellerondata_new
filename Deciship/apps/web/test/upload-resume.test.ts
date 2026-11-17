// Y95 açık önizlemenin tazelenmesi ve Y124-E4 "Dosyayı bize gönderin" bağlantısı (saf yardımcılar).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SUPPORT_EMAIL } from '@sellerondata/contracts';
import { ApiError } from '../src/api/client.ts';
import {
  KEEP_ALIVE_MS,
  OPEN_PREVIEW_KEY,
  OPEN_PREVIEW_STALE_MS,
  isDailyAiBudget,
  isFileProblem,
  keepAliveDue,
  markClosed,
  markOpen,
  openElsewhere,
  retryUseless,
  parseOpenPreviews,
  readOpenPreviews,
  sendFileHref,
  updateOpenPreviews,
  visibleResumables,
} from '../src/pages/invoice-upload/resume.ts';

describe('keepAliveDue', () => {
  const t0 = 1_000_000;
  it('kullanıcı bir şey yaptı ve aralık doldu: tazelenir', () => {
    assert.equal(keepAliveDue(t0 + 10, t0, t0 + KEEP_ALIVE_MS), true);
  });
  it('aralık dolmadan tazelenmez', () => {
    assert.equal(keepAliveDue(t0 + 10, t0, t0 + KEEP_ALIVE_MS - 1), false);
  });
  it('son tazelemeden beri hiçbir şey yapılmadıysa (sekme açık, terk edilmiş) hiç tazelenmez', () => {
    assert.equal(keepAliveDue(t0, t0, t0 + 100 * KEEP_ALIVE_MS), false);
    assert.equal(keepAliveDue(t0 - 5, t0, t0 + 100 * KEEP_ALIVE_MS), false);
  });
});

describe('isFileProblem', () => {
  it('dosyanın okunamadığı hatalar', () => {
    for (const [s, c] of [[422, 'FILE_TOO_COMPLEX'], [400, 'UNSUPPORTED_FORMAT'], [413, 'FILE_TOO_LARGE'], [422, 'AI_TRUNCATED'], [500, 'INTERNAL']] as const)
      assert.equal(isFileProblem(new ApiError(s, c, 'x')), true, c);
  });
  it('geçici ya da hesaba bağlı hatalarda düğme yok', () => {
    for (const [s, c] of [[413, 'STORAGE_QUOTA_EXCEEDED'], [429, 'AI_QUOTA_EXCEEDED'], [429, 'AI_DAILY_BUDGET'], [503, 'AI_DISABLED'], [429, 'TOO_MANY_REQUESTS'], [503, 'FILE_BUSY'], [404, 'NOT_FOUND'], [403, 'FORBIDDEN']] as const)
      assert.equal(isFileProblem(new ApiError(s, c, 'x')), false, c);
    assert.equal(isFileProblem(new Error('ağ')), false);
    assert.equal(isFileProblem(null), false);
  });
});

describe('retryUseless (StepOne "Tekrar dene")', () => {
  it('sistemin günlük yapay zekâ tavanı (429 AI_DAILY_BUDGET): düğme yok, "Dosya okunamadı" yerine yalnız sunucu metni', () => {
    const e = new ApiError(429, 'AI_DAILY_BUDGET', 'Yapay zekâ bugün için durduruldu');
    assert.equal(retryUseless(e), true);
    assert.equal(isDailyAiBudget(e), true);
    assert.equal(isDailyAiBudget(new ApiError(429, 'AI_QUOTA_EXCEEDED', 'x')), false);
  });
  it('önceki kural aynı: kapalı, alan ve aylık hak dolu düğmesiz; geçici hatada düğme var', () => {
    for (const [s, c] of [[503, 'AI_DISABLED'], [413, 'STORAGE_QUOTA_EXCEEDED'], [429, 'AI_QUOTA_EXCEEDED']] as const) assert.equal(retryUseless(new ApiError(s, c, 'x')), true, c);
    for (const [s, c] of [[429, 'TOO_MANY_REQUESTS'], [503, 'FILE_BUSY'], [422, 'AI_TRUNCATED'], [500, 'INTERNAL']] as const) assert.equal(retryUseless(new ApiError(s, c, 'x')), false, c);
    assert.equal(retryUseless(new Error('ağ')), false);
    assert.equal(retryUseless(null), false);
  });
});

describe('sendFileHref', () => {
  it('destek adresi, konu ve gövde; dosya eklenmez, yalnız istenir', () => {
    const href = sendFileHref(['Okunamayan fatura', 'Acme', 'fatura.pdf'], 'Lütfen dosyayı ekleyin. Hata: FILE_TOO_COMPLEX');
    assert.ok(href.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`));
    const u = new URL(href);
    assert.equal(u.searchParams.get('subject'), 'Okunamayan fatura · Acme · fatura.pdf');
    assert.equal(u.searchParams.get('body'), 'Lütfen dosyayı ekleyin. Hata: FILE_TOO_COMPLEX');
  });
  it('konu boşsa da geçerli bağlantı', () => {
    assert.equal(new URL(sendFileHref([], 'b')).searchParams.get('body'), 'b');
  });
});

describe('çoklu sekme: başka sekmede açık önizleme bantta gösterilmez', () => {
  const now = 5_000_000;
  const items = [{ fileId: 'a' }, { fileId: 'b' }];
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
  };

  it('başka sekmede açık (taze kayıt) → gizli; bu sekmenin kendi kaydı gizlemez', () => {
    const m = markOpen({}, 'a', 'tab-1', now);
    assert.deepEqual(visibleResumables(items, m, 'tab-2', now + 1000), [{ fileId: 'b' }]);
    assert.deepEqual(visibleResumables(items, m, 'tab-1', now + 1000), items);
    assert.equal(openElsewhere(m, 'a', 'tab-2', now + 1000), true);
  });

  it('bayat kayıt (sekme çöktü) → görünür', () => {
    const m = markOpen({}, 'a', 'tab-1', now);
    assert.deepEqual(visibleResumables(items, m, 'tab-2', now + OPEN_PREVIEW_STALE_MS), items);
    // ileri tarihli (saat oynamış) kayıt sonsuza dek gizlemez
    assert.equal(openElsewhere({ a: { tab: 'tab-1', at: now + 10 * OPEN_PREVIEW_STALE_MS } }, 'a', 'tab-2', now), false);
  });

  it('depolama erişilemezse (null) → bugünkü davranış: hepsi görünür', () => {
    assert.deepEqual(visibleResumables(items, null, 'tab-2', now), items);
    const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
    assert.equal(readOpenPreviews(broken), null);
    assert.equal(readOpenPreviews(null), null);
    assert.doesNotThrow(() => updateOpenPreviews(broken, (m) => markOpen(m, 'a', 't', now)));
  });

  it('kapatma yalnız kendi kaydını siler; bayatlar temizlenir; bozuk kayıt yok sayılır', () => {
    let m = markOpen({}, 'a', 'tab-1', now);
    m = markOpen(m, 'b', 'tab-2', now);
    assert.ok(markClosed(m, 'a', 'tab-2', now).a, 'başka sekmenin kaydı kalır');
    assert.equal(markClosed(m, 'a', 'tab-1', now).a, undefined);
    assert.deepEqual(Object.keys(markOpen(m, 'c', 'tab-3', now + OPEN_PREVIEW_STALE_MS)), ['c']);
    assert.deepEqual(parseOpenPreviews('{bozuk'), {});
    assert.deepEqual(parseOpenPreviews('[1]'), {});
    assert.deepEqual(parseOpenPreviews(JSON.stringify({ a: { tab: 1, at: 'x' }, b: { tab: 't', at: 3 } })), { b: { tab: 't', at: 3 } });
  });

  it('depolama yoluyla iki sekme: biri yazar, öbürü okur', () => {
    const st = memory();
    updateOpenPreviews(st, (m) => markOpen(m, 'a', 'tab-1', now));
    assert.ok(st.raw.has(OPEN_PREVIEW_KEY));
    assert.deepEqual(visibleResumables(items, readOpenPreviews(st), 'tab-2', now + 10), [{ fileId: 'b' }]);
    updateOpenPreviews(st, (m) => markClosed(m, 'a', 'tab-1', now + 20));
    assert.deepEqual(visibleResumables(items, readOpenPreviews(st), 'tab-2', now + 30), items);
  });
});
