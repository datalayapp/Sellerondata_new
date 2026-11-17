// İtiraz takibinin saf yardımcıları: süre durumu, kısmi geri almada toplam, form denetimi, denetim izi sırası.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amountValid, deadlineState, hasLiveRecovery, needsRefetch, recoveryTotals, revertableResults, timelineOf, validateSend } from '../src/lib/disputes.ts';
import type { DisputeResultView, DisputeRound, InvoiceDispute } from '../src/api/types.ts';

const dl = (daysLeft: number, lastDay = '2026-11-10') => ({ days: 8, lastDay, daysLeft, expired: daysLeft < 0 });

describe('deadlineState', () => {
  it('gönderilmemişte kalan güne göre', () => {
    assert.equal(deadlineState(dl(5)), 'open');
    assert.equal(deadlineState(dl(2)), 'soon');
    assert.equal(deadlineState(dl(0)), 'today');
    assert.equal(deadlineState(dl(-1)), 'expired');
  });
  it('gönderilince sayaç durur: son güne kadarsa zamanında, sonra ise geç', () => {
    assert.equal(deadlineState(dl(-3), '2026-11-10'), 'onTime');
    assert.equal(deadlineState(dl(-3), '2026-11-11'), 'late');
  });
  it('TTK için sunucunun kararı geçerli', () => {
    assert.equal(deadlineState(dl(-3), '2026-11-20', 'ON_TIME'), 'onTime');
    assert.equal(deadlineState(dl(5), '2026-11-01', 'LATE'), 'late');
  });
});

describe('recoveryTotals ve amountValid', () => {
  it('kısmi geri almada eksik kalan kuruşla doğru', () => {
    const t = recoveryTotals([
      { claimed: 458.5, amount: 400 },
      { claimed: 212.4, amount: 212.4 },
      { claimed: 0.1, amount: 0.2 - 0.1 },
    ]);
    assert.deepEqual(t, { claimed: 671, recovered: 612.5, shortfall: 58.5 });
  });
  it('boş tutar 0, fazla geri alma eksik kalanı eksiye düşürmez', () => {
    assert.deepEqual(recoveryTotals([{ claimed: 10, amount: null }]), { claimed: 10, recovered: 0, shortfall: 10 });
    assert.equal(recoveryTotals([{ claimed: 10, amount: 12 }]).shortfall, 0);
  });
  it('0 < tutar ≤ talep', () => {
    assert.equal(amountValid(95, 95), true);
    // sunucu ikiden çok ondalığı reddeder (400): sessizce kuruşa yuvarlanmaz
    assert.equal(amountValid(95.004, 95), false, 'ikiden çok ondalık');
    assert.equal(amountValid(1.005, 95), false, 'ikiden çok ondalık');
    assert.equal(amountValid(0.1 + 0.2, 95), true, 'kayan nokta artığı iki ondalık sayılır');
    assert.equal(amountValid(95.01, 95), false);
    assert.equal(amountValid(0, 95), false);
    assert.equal(amountValid(null, 95), false);
    assert.equal(amountValid(Number.NaN, 95), false);
    assert.equal(amountValid(1000, undefined), true, 'talep görünmüyorsa üst sınırı sunucu denetler');
  });
});

describe('validateSend', () => {
  const base = { sentOn: '2026-11-08', today: '2026-11-08', invoiceDate: '2026-11-02', channel: 'EMAIL', channelNote: '' };
  it('geçerli form hatasız', () => assert.deepEqual(validateSend(base), {}));
  it('gelecek tarih, fatura tarihinden önce, boş tarih', () => {
    assert.equal(validateSend({ ...base, sentOn: '2026-11-09' }).sentOn, 'future');
    assert.equal(validateSend({ ...base, sentOn: '2026-11-01' }).sentOn, 'beforeInvoice');
    assert.equal(validateSend({ ...base, sentOn: '' }).sentOn, 'required');
  });
  it('Diğer kanalda açıklama zorunlu', () => {
    assert.equal(validateSend({ ...base, channel: 'OTHER' }).channelNote, 'required');
    assert.deepEqual(validateSend({ ...base, channel: 'OTHER', channelNote: 'telefonla' }), {});
  });
});

const who = { id: 'p4', name: 'Can Yıldız' };
function result(id: string, kind: 'RECOVERED' | 'REJECTED', enteredAt: string, revertedAt: string | null = null): DisputeResultView {
  return { id, kind, creditNoteNo: kind === 'RECOVERED' ? 'AD-1' : null, resultOn: enteredAt.slice(0, 10), reason: null, amount: 10, lines: [], enteredBy: who, enteredAt, revertedAt, revertedBy: revertedAt ? who : null, revertReason: revertedAt ? 'yanlış' : null };
}
function round(id: string, n: number, createdAt: string, extra: Partial<DisputeRound> = {}): DisputeRound {
  return { id, round: n, currency: 'TRY', sentOn: createdAt.slice(0, 10), channel: 'EMAIL', channelNote: null, reference: null, sentBy: who, createdAt, ttk: 'ON_TIME', withdrawnAt: null, withdrawnBy: null, withdrawReason: null, supersededById: null, version: 1, sums: {}, lines: [], results: [], ...extra };
}

describe('timelineOf', () => {
  it('geri çekilen tur, geri alınan giriş ve yeniden gönderme yeni önce sıralanır', () => {
    const r1 = round('r1', 1, '2026-10-01T08:00:00Z', {
      results: [result('x1', 'RECOVERED', '2026-10-03T08:00:00Z', '2026-10-04T08:00:00Z')],
      withdrawnAt: '2026-10-04T09:00:00Z',
      withdrawnBy: who,
    });
    const r2 = round('r2', 2, '2026-10-05T08:00:00Z', { supersededById: 'r3', results: [result('x2', 'REJECTED', '2026-10-06T08:00:00Z')] });
    const r3 = round('r3', 3, '2026-10-07T08:00:00Z');
    const d: InvoiceDispute = { status: 'SENT', active: r3, history: [r2, r1], sendableLineCount: 0 };
    const kinds = timelineOf(d).map((e) => `${e.kind}:${e.round.round}`);
    assert.deepEqual(kinds, ['sent:3', 'superseded:2', 'result:2', 'sent:2', 'withdrawn:1', 'reverted:1', 'result:1', 'sent:1']);
  });
  it('itiraz yoksa boş', () => assert.deepEqual(timelineOf(undefined), []));
});

describe('yardımcılar', () => {
  it('canlı dekont varsa geri çekilemez; geri alınmış dekont engellemez', () => {
    assert.equal(hasLiveRecovery(round('a', 1, '2026-10-01T08:00:00Z', { results: [result('x', 'RECOVERED', '2026-10-02T08:00:00Z')] })), true);
    assert.equal(hasLiveRecovery(round('a', 1, '2026-10-01T08:00:00Z', { results: [result('x', 'RECOVERED', '2026-10-02T08:00:00Z', '2026-10-03T08:00:00Z')] })), false);
    assert.equal(hasLiveRecovery(round('a', 1, '2026-10-01T08:00:00Z', { results: [result('x', 'REJECTED', '2026-10-02T08:00:00Z')] })), false);
  });
  it('eşzamanlılık hatalarında güncel kayıt yeniden okunur', () => {
    assert.equal(needsRefetch('STALE'), true);
    assert.equal(needsRefetch('LINE_NOT_PENDING'), true);
    assert.equal(needsRefetch('AMOUNT_EXCEEDS_CLAIM'), false);
    // 10-B3, B12, B13: liste, giriş ya da satır bu arada değişti
    assert.equal(needsRefetch('SELECTION_CHANGED'), true);
    assert.equal(needsRefetch('RESULT_LINES_RESENT'), true);
    assert.equal(needsRefetch('LINE_CHANGED'), true);
  });
});

describe('revertableResults (10-B12)', () => {
  const line = (id: string, invoiceLineId: string, outcome: 'PENDING' | 'RECOVERED' | 'REJECTED', resultId: string | null = null) => ({
    id,
    invoiceLineId,
    lineNo: 1,
    trackingNo: invoiceLineId,
    claimedAmount: 10,
    outcome,
    recoveredAmount: outcome === 'RECOVERED' ? 10 : null,
    resultId,
  });
  const withLines = (x: DisputeResultView, ids: string[]): DisputeResultView => ({ ...x, lines: ids.map((disputeLineId) => ({ disputeLineId, amount: 10 })) });

  it('etkin turun canlı girişleri ve önceki turdaki, satırı yeniden talep edilmemiş dekont; yeni önce', () => {
    const rec = withLines(result('rec', 'RECOVERED', '2026-10-03T08:00:00Z'), ['d1']);
    const rej = withLines(result('rej', 'REJECTED', '2026-10-04T08:00:00Z'), ['d2']);
    const gone = withLines(result('gone', 'RECOVERED', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z'), ['d1']);
    const r1 = round('r1', 1, '2026-10-01T08:00:00Z', {
      supersededById: 'r2',
      supersededAt: '2026-10-05T08:00:00Z',
      lines: [line('d1', 'A', 'RECOVERED', 'rec'), line('d2', 'B', 'REJECTED', 'rej')],
      results: [rej, rec, gone],
    });
    const now = withLines(result('now', 'REJECTED', '2026-10-06T08:00:00Z'), ['e1']);
    const r2 = round('r2', 2, '2026-10-05T08:00:00Z', { lines: [line('e1', 'B', 'REJECTED', 'now')], results: [now] });
    const d: InvoiceDispute = { status: 'CLOSED', active: r2, history: [r1], sendableLineCount: 1 };
    const got = revertableResults(d).map((x) => `${x.result.id}@${x.round.round}`);
    // B'nin 1. turdaki reddi geri alınamaz (B 2. turda yeniden talep edildi); geri alınmış giriş listede yok
    assert.deepEqual(got, ['now@2', 'rec@1']);
  });

  it('geri çekilmiş tur ve sonradan geri çekilen turdaki satır', () => {
    const rec = withLines(result('rec', 'RECOVERED', '2026-10-03T08:00:00Z'), ['d1']);
    const r1 = round('r1', 1, '2026-10-01T08:00:00Z', { withdrawnAt: '2026-10-04T08:00:00Z', lines: [line('d1', 'A', 'RECOVERED', 'rec')], results: [rec] });
    const r2 = round('r2', 2, '2026-10-05T08:00:00Z', { lines: [line('e1', 'A', 'PENDING')] });
    assert.deepEqual(revertableResults({ status: 'SENT', active: r2, history: [r1], sendableLineCount: 1 }), []);
    assert.deepEqual(revertableResults(undefined), []);
  });

  it('yeniden gönderilen tur geri çekildiyse (etkin tur yok) önceki turun dekontu yine geri alınabilir', () => {
    const rec = withLines(result('rec', 'RECOVERED', '2026-10-03T08:00:00Z'), ['d1']);
    const rej = withLines(result('rej', 'REJECTED', '2026-10-04T08:00:00Z'), ['d2']);
    const r1 = round('r1', 1, '2026-10-01T08:00:00Z', {
      supersededById: 'r2',
      supersededAt: '2026-10-05T08:00:00Z',
      lines: [line('d1', 'A', 'RECOVERED', 'rec'), line('d2', 'B', 'REJECTED', 'rej')],
      results: [rej, rec],
    });
    const r2 = round('r2', 2, '2026-10-05T08:00:00Z', { withdrawnAt: '2026-10-06T08:00:00Z', lines: [line('e1', 'B', 'PENDING')] });
    // B'nin yeniden talebi geri çekildi: o giriş de (B artık hiçbir canlı turda değil) geri alınabilir
    const got = revertableResults({ status: 'NONE', active: null, history: [r2, r1], sendableLineCount: 1 }).map((x) => `${x.result.id}@${x.round.round}`);
    assert.deepEqual(got, ['rej@1', 'rec@1']);
  });
});

// Denetim 01-B9, karar (a): talep KDV hariç saklanır; alacak dekontu girişinde geri alınan tutarın da KDV hariç yazılacağı
// söylenir (dekontun KDV dahil toplamı yazılırsa talepten fazla sayılır ya da geri alınan şişer).
describe('sonuç girişi KDV hariç der', () => {
  it('TR ve EN: talep ve tutar kutusu etiketi', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const [loc, word] of [['tr', 'KDV hariç'], ['en', 'excl. VAT']] as const) {
      const file = path.resolve(import.meta.dirname, `../src/locales/${loc}/disputes.json`);
      const result = JSON.parse(fs.readFileSync(file, 'utf8')).result;
      assert.ok(result.claim.includes(word), `${loc} result.claim`);
      assert.ok(result.amountFor.includes(word), `${loc} result.amountFor`);
    }
  });
});
