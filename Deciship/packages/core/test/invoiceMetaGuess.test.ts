import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMetaColumns, guessInvoiceMeta, readTable, suggestMapping } from '../src/invoice';

const SAMPLES = resolve(import.meta.dirname, '../../../samples/invoices');
const load = (name: string) => readTable(name, new Uint8Array(readFileSync(resolve(SAMPLES, name))));

describe('fatura no ve tarih sütunları', () => {
  it.each(['Inv #', 'Inv. #', 'Invoice #', 'Inv No', 'Inv. No.', 'Inv Number', 'Bill No', 'Bill #', 'Bill Number', 'Billing Number', 'Invoice Num', 'Fatura Nr'])(
    'fatura no başlığı: %s',
    (h) => expect(detectMetaColumns(['Waybill', h, 'Amount'], [['1', 'A-1', '5']]).invoiceNo).toBe(h),
  );

  it.each(['Bill Date', 'Billing Date', 'Inv Date', 'Inv. Date', 'Invoiced Date', 'Issue Date', 'Date of Invoice', 'Düzenleme Tarihi'])(
    'fatura tarihi başlığı: %s',
    (h) => expect(detectMetaColumns(['Waybill', h, 'Amount'], [['1', '10/31/2026', '5']]).invoiceDate).toBe(h),
  );

  // Takip numarası ya da gönderi tarihi taşıyan sütunlar fatura bilgisi sayılmaz.
  it.each(['Air Bill Number', 'Airway Bill No', 'Waybill', 'Waybill Number', 'House Bill No', 'Bill To', 'Bill To Account', 'Account Number', 'Line Invoice No'])(
    'fatura no değil: %s',
    (h) => expect(detectMetaColumns(['Tutar', h], [['5', '7731']]).invoiceNo).toBeUndefined(),
  );

  it.each(['Tarih', 'Date', 'Ship Date', 'Due Date', 'Payment Date', 'Delivery Date'])('fatura tarihi değil: %s', (h) =>
    expect(detectMetaColumns(['Tutar', h], [['5', '10/31/2026']]).invoiceDate).toBeUndefined(),
  );
});

describe('örnek dosyalardan fatura bilgisi tahmini', () => {
  it('ABD örneği: Inv # ve Bill Date okunur, ay/gün sırası doğru', async () => {
    const t = await load('generic-en-invoice-sample.csv');
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping).toMatchObject({ invoiceNo: 'Inv #', invoiceDate: 'Bill Date', trackingNo: 'Waybill', shipDate: 'Ship Date' });
    expect(guessInvoiceMeta(t, mapping)).toMatchObject({ invoiceNo: 'INV-0091-77', invoiceDate: '2026-10-31' });
  });

  it('MNG örneği: dosyada fatura tarihi yok, gönderi tarihi fatura tarihi diye alınmaz', async () => {
    const t = await load('mng-MNG-2026-77120.csv');
    const { mapping } = suggestMapping(t.headers, 'mng', t.rows);
    expect(mapping.invoiceDate).toBeUndefined();
    expect(guessInvoiceMeta(t, mapping).invoiceDate).toBeUndefined();
    expect(guessInvoiceMeta(t).invoiceDate).toBeUndefined();
  });

  it('Alman örneği: Rechnungsnummer ve Rechnungsdatum okunur', async () => {
    const t = await load('generic-de-rechnung-sample.csv');
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(guessInvoiceMeta(t, mapping)).toMatchObject({ invoiceNo: 'RE-2026-55120', invoiceDate: '2026-10-31' });
  });
});
