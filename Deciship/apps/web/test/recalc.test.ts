// Mesaj 4 önce/sonra penceresinin saf mantığı: ne zaman açılır, önce/sonra farkı, "neyin değiştiği" metni, anahtarlar iki dilde.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  activeApplyJob,
  activeJobFromError,
  bandNumbers,
  bulkOutcome,
  bulkStopped,
  bulkWritten,
  INVOICE_REFRESH_KEYS,
  firstAnnouncement,
  basisChange,
  basisNotice,
  bulkDecision,
  bulkFollowUp,
  bulkSkipped,
  bulkStale,
  bulkTotals,
  decidedLinesBlocked,
  hiddenCount,
  lineResult,
  moneyChange,
  pendingKey,
  prevResultKey,
  previewDecision,
  subjectLines,
} from '../src/pages/invoice-detail/recalc.ts';
import { withLineIds } from '../src/api/lineIds.ts';
import type { JobView } from '../src/api/types.ts';
import type { BulkRecalcPreview, InvoiceRecalcPreview, RecalcBasisRef, RecalcPendingCause } from '../src/api/types.ts';

const ref = (x: Partial<RecalcBasisRef> = {}): RecalcBasisRef => ({ tariffId: 't1', tariffName: 'FedEx 2026', revisionId: 'r1', revisionAt: '2026-10-12T09:00:00Z', ...x });
const preview = (x: Partial<InvoiceRecalcPreview> = {}): InvoiceRecalcPreview => ({
  token: 'tok',
  basis: { from: ref(), to: ref() },
  totals: { before: { overchargeTotal: 1200 }, after: { overchargeTotal: 1200 } },
  changedLines: 0,
  frozenChanged: 0,
  skippedInDispute: 0,
  lines: [],
  ...x,
});
const bulk = (x: Partial<BulkRecalcPreview> = {}): BulkRecalcPreview => ({
  token: 'tok',
  invoices: [],
  totalsByCurrency: [],
  changedInvoices: 0,
  skippedInDispute: 0,
  ...x,
});

describe('pencere ne zaman açılır', () => {
  it('değişen satır varsa sorulur', () => {
    assert.equal(previewDecision(preview({ changedLines: 3 })), 'ask');
  });
  it('satır sayısı 0 ama toplam değişiyorsa yine sorulur', () => {
    assert.equal(previewDecision(preview({ totals: { before: { overchargeTotal: 1200 }, after: { overchargeTotal: 980 } } })), 'ask');
  });
  it('hiçbir şey değişmiyorsa pencere açılmaz', () => {
    assert.equal(previewDecision(preview()), 'none');
  });
  it('rakam aynı ama dayanak yeni sürüme ya da yeni ayara geçiyorsa sormadan uygulanır', () => {
    assert.equal(previewDecision(preview({ basis: { from: ref(), to: ref({ revisionId: 'r2' }) } })), 'silent');
    assert.equal(previewDecision(preview({ basis: { from: ref(), to: ref(), rulesChanged: true } })), 'silent');
  });
  it('Y32: görünür değişiklik yok ama yazılacak satır var (aynı desili yeni ölçüm, işaret silinir): sormadan uygulanır', () => {
    assert.equal(previewDecision(preview({ writeLines: 1 })), 'update');
    // yazılacak satır yoksa (ya da eski sunucu alanı göndermiyorsa) pencere açılmaz
    assert.equal(previewDecision(preview({ writeLines: 0 })), 'none');
    assert.equal(previewDecision(preview({ writeLines: undefined })), 'none');
    // görünür değişiklik varsa yine sorulur; dayanak değişiyorsa eski "rakamlar değişmedi" yolu
    assert.equal(previewDecision(preview({ writeLines: 2, changedLines: 1 })), 'ask');
    assert.equal(previewDecision(preview({ writeLines: 2, basis: { from: ref(), to: ref({ revisionId: 'r2' }) } })), 'silent');
  });
  it('kayan nokta farkı "değişti" sayılmaz', () => {
    assert.equal(previewDecision(preview({ totals: { before: { overchargeTotal: 0.1 + 0.2 }, after: { overchargeTotal: 0.3 } } })), 'none');
  });
  it('toplu: geçirilecek fatura yoksa pencere açılmaz', () => {
    assert.equal(bulkDecision(bulk()), 'none');
    assert.equal(bulkDecision(bulk({ changedInvoices: 2 })), 'ask');
  });
});

describe('önce/sonra farkı', () => {
  it('fark kuruşla ve yönüyle', () => {
    assert.deepEqual(moneyChange(1200, 980), { before: 1200, after: 980, delta: -220, dir: 'down' });
    assert.deepEqual(moneyChange(95.1, 95.35), { before: 95.1, after: 95.35, delta: 0.25, dir: 'up' });
    assert.equal(moneyChange(10, 10).dir, 'same');
  });
  it('satır sonucu: tutar varsa tutar, yoksa durum', () => {
    assert.deepEqual(lineResult({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 100, diffAmount: 120 }), { kind: 'money', amount: 120 });
    assert.deepEqual(lineResult({ status: 'UNMATCHED', diffTypes: [], expectedAmount: null, diffAmount: null }), { kind: 'status', status: 'UNMATCHED' });
  });
  it('toplu toplam para birimine göre: sunucunun tüm faturalardan ayrı topladığı satırlar; fiyat izni yoksa (alan silinmiş) boş', () => {
    const row = (currency: string, before: number, after: number) => ({ currency, invoices: 1, before: { overchargeTotal: before }, after: { overchargeTotal: after } });
    assert.deepEqual(bulkTotals(bulk({ totalsByCurrency: [row('TRY', 20, 0)] })), [row('TRY', 20, 0)]);
    // farklı para birimleri toplanmaz: iki satır, ilk 200 faturaya bakılmaz
    const mixed = bulk({ invoices: [], changedInvoices: 350, totalsByCurrency: [row('TRY', 20, 0), row('USD', 20, 20)] });
    assert.deepEqual(bulkTotals(mixed).map((x) => x.currency), ['TRY', 'USD']);
    const { totalsByCurrency: _gone, ...stripped } = bulk();
    assert.deepEqual(bulkTotals(stripped as unknown as BulkRecalcPreview), []);
  });
  it('listede ilk 200: kalan sayısı', () => {
    assert.equal(hiddenCount(250, 200), 50);
    assert.equal(hiddenCount(12, 12), 0);
  });
});

describe('neyin değiştiği', () => {
  it('aynı tarifenin yeni sürümü: ad ve eski sürüm tarihi', () => {
    const b = { from: ref(), to: ref({ revisionId: 'r2', revisionAt: '2026-11-09T09:00:00Z' }) };
    assert.deepEqual(basisChange(b), { tariff: 'revision', rules: false });
    assert.deepEqual(subjectLines(b), [{ key: 'recalc.subject.revision', values: { name: 'FedEx 2026', at: '2026-10-12T09:00:00Z' } }]);
  });
  it('önce tarafı faturanın hesaplandığı gündür (verilmişse); null ise tarih yok', () => {
    const b = { from: ref(), to: ref({ revisionId: 'r2', revisionAt: '2026-11-09T09:00:00Z' }) };
    assert.deepEqual(subjectLines(b, '2026-10-20T08:00:00Z'), [{ key: 'recalc.subject.revision', values: { name: 'FedEx 2026', at: '2026-10-20T08:00:00Z' } }]);
    assert.deepEqual(subjectLines(b, null), [{ key: 'recalc.subject.revision', values: { name: 'FedEx 2026', at: null } }]);
  });
  it('başka tarifeye geçiş ve tarifesizden tarifeye', () => {
    assert.deepEqual(subjectLines({ from: ref(), to: ref({ tariffId: 't2', tariffName: 'UPS 2026', revisionId: 'u1' }) }), [
      { key: 'recalc.subject.switch', values: { from: 'FedEx 2026', to: 'UPS 2026' } },
    ]);
    assert.deepEqual(subjectLines({ from: ref({ tariffId: null, tariffName: null, revisionId: null }), to: ref() }), [
      { key: 'recalc.subject.switchFromNone', values: { to: 'FedEx 2026' } },
    ]);
  });
  it('tarife ve ayar birlikte: iki satır; hiçbiri: "aynı tarife ve ayar"', () => {
    const keys = subjectLines({ from: ref(), to: ref({ revisionId: 'r2' }), rulesChanged: true }).map((x) => x.key);
    assert.deepEqual(keys, ['recalc.subject.revision', 'recalc.subject.rules']);
    assert.deepEqual(subjectLines({ from: ref(), to: ref() }).map((x) => x.key), ['recalc.subject.same']);
  });
  it('fatura bandı: değişen tarife ve ayarda eylem, silinen tarifede yalnız bilgi', () => {
    assert.deepEqual(basisNotice({ state: 'TARIFF_CHANGED', tariffName: 'X', calculatedAt: null }), { key: 'recalc.band.tariffChanged', action: 'tariff' });
    assert.deepEqual(basisNotice({ state: 'RULES_CHANGED', tariffName: 'X', calculatedAt: null }), { key: 'recalc.band.rulesChanged', action: 'rules' });
    assert.deepEqual(basisNotice({ state: 'TARIFF_REMOVED', tariffName: 'X', calculatedAt: null }), { key: 'recalc.band.tariffRemoved', action: null });
    assert.equal(basisNotice({ state: 'CURRENT', tariffName: 'X', calculatedAt: null }), null);
    assert.equal(basisNotice(undefined), null);
  });
  it('bilinmeyen neden OTHER metnine düşer', () => {
    assert.equal(prevResultKey('MEASUREMENT'), 'recalc.prev.MEASUREMENT');
    assert.equal(prevResultKey('SOMETHING_NEW'), 'recalc.prev.OTHER');
    assert.equal(pendingKey('DUPLICATE'), 'recalc.pending.DUPLICATE');
    assert.equal(pendingKey(null), 'recalc.pending.OTHER');
  });
  it('bekleyen neden üç sınıf: ölçüm ve mükerrer ayrı; OTHER ve bilinmeyen değer (eski TRACKING/MATCH dahil) "yeniden hesap bekliyor"', () => {
    const classes: RecalcPendingCause[] = ['MEASUREMENT', 'DUPLICATE', 'OTHER'];
    assert.deepEqual(classes.map(pendingKey), ['recalc.pending.MEASUREMENT', 'recalc.pending.DUPLICATE', 'recalc.pending.OTHER']);
    for (const c of ['TRACKING', 'MATCH', 'TARIFF', 'RULES', 'YENI']) assert.equal(pendingKey(c), 'recalc.pending.OTHER');
  });
});

describe('toplu onay yanıtı', () => {
  it('atlanan fatura sayısı itirazdakiler ile bu arada değişenlerin toplamı', () => {
    assert.equal(bulkSkipped({ skipped: { inDispute: 2, stale: 1 } }), 3);
    assert.equal(bulkSkipped({ skipped: { inDispute: 0, stale: 0 } }), 0);
    assert.equal(bulkSkipped({}), 0);
  });
  it('K4: önizlemeden sonra değişen faturalar: sayı sonuçtan, liste sunucudan (en çok 200), kalanı "daha var"; eski sunucuda liste yok', () => {
    const inv = { id: 'i1', invoiceNo: 'F-1', carrierName: 'Aras' };
    assert.deepEqual(bulkStale({ skipped: { inDispute: 1, stale: 3 }, staleInvoices: [inv] }), { count: 3, list: [inv], more: 2 });
    assert.deepEqual(bulkStale({ skipped: { inDispute: 1, stale: 0 } }), { count: 0, list: [], more: 0 });
    assert.deepEqual(bulkStale({ skipped: { inDispute: 0, stale: 2 } }), { count: 2, list: [], more: 2 });
    assert.deepEqual(bulkStale({}), { count: 0, list: [], more: 0 });
  });
  it('K4: bitişte pencere: atlanan ya da kapsamda kalan fatura varsa; durdurulan işte yalnız atlanan varsa', () => {
    const base = { invoices: 4, lines: 4, skipped: { inDispute: 0, stale: 0 }, stopped: 0 };
    const stale = { ...base, skipped: { inDispute: 0, stale: 1 }, staleInvoices: [{ id: 'i1', invoiceNo: 'F-1', carrierName: 'Aras' }] };
    assert.equal(bulkFollowUp({ kind: 'applied', result: base }), null);
    assert.deepEqual(bulkFollowUp({ kind: 'applied', result: stale }), { result: stale, stopped: false });
    // önizlemeden sonra kapsama giren ya da itirazı kapanan: atlanan yok ama "Yeniden önizle" önerilir
    const remaining = { ...base, remaining: 2 };
    assert.deepEqual(bulkFollowUp({ kind: 'applied', result: remaining }), { result: remaining, stopped: false });
    // durdurulan iş: kalanlar zaten durduruldu; pencere yalnız atlanan varsa
    assert.deepEqual(bulkFollowUp({ kind: 'appliedStopped', written: 4, result: { ...stale, stopped: 3 } }), { result: { ...stale, stopped: 3 }, stopped: true });
    assert.equal(bulkFollowUp({ kind: 'appliedStopped', written: 4, result: { ...base, stopped: 3 } }), null);
    assert.equal(bulkFollowUp({ kind: 'appliedStopped', written: 4 }), null);
    assert.equal(bulkFollowUp({ kind: 'stale' }), null);
  });
  it('lineIds boşsa istekten çıkarılır', () => {
    assert.deepEqual(withLineIds({ basis: 'pinned', lineIds: [] }), { basis: 'pinned' });
    assert.deepEqual(withLineIds({ basis: 'pinned', lineIds: ['a'] }), { basis: 'pinned', lineIds: ['a'] });
    const noIds: { basis: string; lineIds?: string[] } = { basis: 'pinned' };
    assert.deepEqual(withLineIds(noIds), { basis: 'pinned' });
  });
});

describe('metinler iki dilde', () => {
  const load = (lang: string) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/invoiceDetail.json`, import.meta.url), 'utf8'));
  const get = (o: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
  const keys = [
    ...['revision', 'switch', 'switchFromNone', 'rules', 'same', 'then', 'tariffBulk', 'settingsBulk'].map((k) => `recalc.subject.${k}`),
    ...['MEASUREMENT', 'DUPLICATE', 'TRACKING', 'MATCH', 'TARIFF', 'RULES', 'OTHER'].map((k) => `recalc.prev.${k}`),
    ...['MEASUREMENT', 'DUPLICATE', 'OTHER'].map((k) => `recalc.pending.${k}`),
    'recalc.done.bulkBody',
    'recalc.done.bulkSkipped',
    // sormadan uygulamanın iki gövdesi: dayanak değişti / yalnız satırlar yazıldı (Y32)
    'recalc.done.sameNumbers',
    'recalc.done.linesUpdated',
    ...['tariffChanged', 'rulesChanged', 'tariffRemoved', 'actionTariff', 'actionRules', 'locked'].map((k) => `recalc.band.${k}`),
    // akışın şablonla kurduğu anahtarlar: her amaç ve iki toplu kip
    ...['tariff', 'rules', 'recompare', 'measurement', 'edit', 'tariffBulk', 'settingsBulk'].flatMap((k) => [`recalc.none.${k}`, `recalc.done.${k}`]),
    ...['tariff', 'rules', 'recompare', 'measurement', 'edit', 'tariffBulk_one', 'tariffBulk_other', 'settingsBulk_one', 'settingsBulk_other'].map((k) => `recalc.title.${k}`),
    'recalc.errors.INVOICE_HAS_DISPUTE',
    'recalc.errors.LINE_IN_DISPUTE',
    'recalc.apply',
    'recalc.cancel',
    // toplu önizlemede birden çok para birimi; düzenleme önizlemesi bayatladığında
    'recalc.overpaidIn',
    'recalc.stale',
    // K4: önizlemeden sonra değişen faturalar penceresi ve bilgi iletisi
    ...['title_one', 'title_other', 'body', 'again', 'toast_one', 'toast_other', 'remainingTitle_one', 'remainingTitle_other', 'remaining_one', 'remaining_other', 'inDispute_one', 'inDispute_other', 'deleted'].map(
      (k) => `recalc.staleDone.${k}`,
    ),
  ];
  for (const lang of ['tr', 'en']) {
    it(`${lang}: önce/sonra anahtarları dolu`, () => {
      const j = load(lang);
      for (const k of keys) assert.ok(typeof get(j, k) === 'string' && get(j, k) !== '', `${lang} ${k}`);
    });
  }
  it('ayar sorusu sayıyı söyler, tek birincil eylem "Uygula"', () => {
    const tr = load('tr');
    assert.match(tr.recalc.title.settingsBulk_other, /^\{\{n\}\} fatura eski ayarla hesaplı\. Yeni ayara geçirilsin mi\?$/);
    assert.equal(tr.recalc.apply, 'Uygula');
    assert.equal(tr.recalc.cancel, 'Vazgeç');
  });
  it('K4: toplu bitişte atlanan sayısı yalnız itirazdakiler (bayatlar ayrı cümlede); bitişte geçmiş zaman', () => {
    for (const lang of ['tr', 'en']) {
      const j = load(lang);
      assert.doesNotMatch(j.recalc.done.bulkSkipped, /bu arada|meanwhile/, lang);
      assert.doesNotMatch(j.recalc.staleDone.inDispute_other, /atlanır|is skipped|are skipped/, lang);
    }
  });
});

describe('toplu iş sonucu (Mesaj 7)', () => {
  const preview = { token: 't', invoices: [], changedInvoices: 3, skippedInDispute: 0 };
  const applied = { invoices: 5, lines: 40, skipped: { inDispute: 1, stale: 0 } };
  const err = (code: string, message = 'x') => ({ statusCode: 409, code, message });

  it('önizleme: başarıyla biterse önizleme gelir, hata ve durdurma ayrı', () => {
    assert.deepEqual(bulkOutcome('preview', { status: 'SUCCEEDED', result: preview }), { kind: 'previewReady', preview });
    assert.deepEqual(bulkOutcome('preview', { status: 'FAILED', error: err('INTERNAL', 'bozuldu') }), { kind: 'previewFailed', message: 'bozuldu' });
    assert.deepEqual(bulkOutcome('preview', { status: 'CANCELLED' }), { kind: 'stopped' });
  });
  it('uygulama: başarı, bölüm sonucuyla durdurma, sonuçsuz durdurma', () => {
    assert.deepEqual(bulkOutcome('apply', { status: 'SUCCEEDED', result: applied }), { kind: 'applied', result: applied });
    const partial = { ...applied, invoices: 2, stopped: 3 };
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED', result: partial }), { kind: 'appliedStopped', written: 2, result: partial });
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED' }), { kind: 'stopped' });
  });
  it('uygulama: bayat önizleme (PREVIEW_STALE) yeniden önizlemeye düşer, diğer hata iletiyle gösterilir', () => {
    assert.deepEqual(bulkOutcome('apply', { status: 'FAILED', error: err('PREVIEW_STALE') }), { kind: 'stale' });
    assert.deepEqual(bulkOutcome('apply', { status: 'FAILED', error: err('JOB_ABANDONED', 'yarıda kaldı') }), { kind: 'applyFailed', message: 'yarıda kaldı', written: 0 });
  });
  it('sonuçsuz CANCELLED + counters.invoices=1 → "1 fatura güncellendi" (written 1), sayaç yoksa eski davranış', () => {
    const counters = { invoices: 1, lines: 10, inDispute: 0, stale: 0 };
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED', counters }), { kind: 'appliedStopped', written: 1, result: undefined });
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED' }), { kind: 'stopped' });
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED', counters: null }), { kind: 'stopped' });
    assert.deepEqual(bulkOutcome('apply', { status: 'CANCELLED', counters: { invoices: 0, lines: 0, inDispute: 0, stale: 0 } }), { kind: 'stopped' });
  });
  it('sonuçsuz FAILED + counters → uyarı için yazılan sayı; sayaç yoksa 0; PREVIEW_STALE hâlâ stale', () => {
    const counters = { invoices: 4, lines: 40, inDispute: 0, stale: 0 };
    assert.deepEqual(bulkOutcome('apply', { status: 'FAILED', error: err('INTERNAL', 'bozuldu'), counters }), { kind: 'applyFailed', message: 'bozuldu', written: 4 });
    assert.deepEqual(bulkOutcome('apply', { status: 'FAILED', error: err('INTERNAL', 'bozuldu') }), { kind: 'applyFailed', message: 'bozuldu', written: 0 });
    assert.deepEqual(bulkOutcome('apply', { status: 'FAILED', error: err('PREVIEW_STALE'), counters }), { kind: 'stale' });
  });
  it('yazılan fatura sayısı: sonuç önce, sonra sayaç, yoksa 0', () => {
    assert.equal(bulkWritten({ result: { invoices: 7 }, counters: { invoices: 3 } }), 7);
    assert.equal(bulkWritten({ counters: { invoices: 3 } }), 3);
    assert.equal(bulkWritten({ counters: null }), 0);
    assert.equal(bulkWritten({}), 0);
  });
  it('uygulama nasıl biterse bitsin fatura, liste ve pano sorguları tazelenir', () => {
    assert.deepEqual(INVOICE_REFRESH_KEYS, [['invoice'], ['invoices'], ['dashboard']]);
  });
  it('durdurulduğunda geçirilmeyen fatura sayısı; eski sunucuda 0', () => {
    assert.equal(bulkStopped({ stopped: 3 }), 3);
    assert.equal(bulkStopped({}), 0);
  });
  it('409 JOB_ACTIVE: details.job ile süren işe bağlanılır; başka hata ya da eksik ayrıntıda null', () => {
    const job = { id: 'j1', status: 'RUNNING', kind: 'BULK_RECOMPARE_APPLY' };
    assert.equal(activeJobFromError({ code: 'JOB_ACTIVE', details: { job } })?.id, 'j1');
    assert.equal(activeJobFromError({ code: 'PREVIEW_STALE', details: { job } }), null);
    assert.equal(activeJobFromError({ code: 'JOB_ACTIVE' }), null);
    assert.equal(activeJobFromError(null), null);
  });
  it('bant: yalnız süren toplu uygulama işi seçilir', () => {
    const j = (kind: string, status: string, id: string) => ({ id, kind, status }) as unknown as JobView;
    assert.equal(activeApplyJob([j('BULK_RECOMPARE_PREVIEW', 'RUNNING', 'a'), j('BULK_RECOMPARE_APPLY', 'SUCCEEDED', 'b'), j('BULK_RECOMPARE_APPLY', 'QUEUED', 'c')])?.id, 'c');
    assert.equal(activeApplyJob([]), null);
  });
  it('bant sayıları: toplam bilinmiyorsa 0', () => {
    assert.deepEqual(bandNumbers({ progress: { done: 12, total: 48, stage: 'bulkWrite' } }), { done: 12, total: 48 });
    assert.deepEqual(bandNumbers({ progress: { done: 3, total: null, stage: null } }), { done: 3, total: 0 });
  });
  it('bitiş iletisi aynı iş için bir kez', () => {
    assert.equal(firstAnnouncement('job-x'), true);
    assert.equal(firstAnnouncement('job-x'), false);
    assert.equal(firstAnnouncement('job-y'), true);
  });
  it('sözlük: toplu iş metinleri iki dilde var', () => {
    const rd = (l: string, f: string) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${l}/${f}.json`, import.meta.url), 'utf8'));
    for (const l of ['tr', 'en']) {
      const r = rd(l, 'invoiceDetail').recalc;
      for (const k of ['closeBackground', 'stopNote', 'alreadyRunning', 'failedPartial']) assert.ok(r[k], `${l} recalc.${k}`);
      assert.ok(r.done.bulkStopped, `${l} recalc.done.bulkStopped`);
      assert.ok(rd(l, 'tariffEditor').bulkBand && rd(l, 'settings').bulkBand, `${l} bulkBand`);
    }
  });
});

describe('decidedLinesBlocked (Y123)', () => {
  const edit = { kind: 'invoice', purpose: 'edit' };
  it('düzenlemede kararlı satırın sonucu değişiyorsa karar izni olmayan uygulayamaz', () => {
    assert.equal(decidedLinesBlocked({ job: edit, preview: { frozenChanged: 2 } }, false), true);
  });
  it('karar izni varsa, kararlı satır etkilenmiyorsa ya da düzenleme değilse engel yok', () => {
    assert.equal(decidedLinesBlocked({ job: edit, preview: { frozenChanged: 2 } }, true), false);
    assert.equal(decidedLinesBlocked({ job: edit, preview: { frozenChanged: 0 } }, false), false);
    assert.equal(decidedLinesBlocked({ job: { kind: 'invoice', purpose: 'recompare' }, preview: { frozenChanged: 2 } }, false), false);
    assert.equal(decidedLinesBlocked({ job: { kind: 'tariff' }, preview: {} }, false), false);
  });
});
