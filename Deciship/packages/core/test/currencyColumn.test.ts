/** Fatura adımı dosyadaki para birimi sütununu önerir; kısa başlıklar ("Curr", "CCY") da para birimidir. */
import { describe, expect, it } from 'vitest';
import { guessInvoiceMeta } from '../src/invoice/diagnostics';

const table = (header: string, value = 'USD') => ({
  headers: ['Tracking', 'Amount', header],
  rows: [
    ['111', '10,00', value],
    ['222', '20,00', value],
  ],
});

describe('para birimi sütunu', () => {
  it.each(['Curr', 'CURR', 'Cur', 'CCY', 'Curr.', 'Currency', 'Para Birimi', 'Döviz'])('%s başlığı okunur', (h) => {
    expect(guessInvoiceMeta(table(h)).currency).toBe('USD');
  });

  it('kur sütunu para birimi sayılmaz', () => {
    expect(guessInvoiceMeta(table('Curr Rate', '32,5')).currency).toBeUndefined();
    expect(guessInvoiceMeta(table('Exchange Currency', 'EUR')).currency).toBeUndefined();
  });

  it('ilgisiz başlıklar para birimi sayılmaz', () => {
    for (const h of ['Current Weight', 'Current', 'Currier', 'Recurring']) {
      expect(guessInvoiceMeta(table(h)).currency, h).toBeUndefined();
    }
  });

  it('sütun yoksa tahmin yoktur: varsayılanı çağıran verir', () => {
    expect(guessInvoiceMeta({ headers: ['Tracking', 'Amount'], rows: [['111', '10,00']] }).currency).toBeUndefined();
  });
});
