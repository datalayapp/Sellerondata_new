// DENETIM-2 01-B4 bağımsız incelemesi: sayı hücresi işareti exceljs dışındaki yazıcıların XLSX'inde de doğru mu
// (LibreOffice / Google Sheets: `t` yok ya da `t="n"`, `t="str"`, `inlineStr`, paylaşılan formül, değersiz formül,
// birleşik hücre) ve tarife okuyucusunun yüzde biçimi işareti düz metin "%" içeren biçimde yanlış yakmıyor mu.
import { describe, expect, it } from 'vitest';
import { parseRows } from '../src/invoice/parse';
import { isNumericCell, isPercentFormat, readTable, readXlsxSheets } from '../src/invoice/read';
import type { ColumnMapping } from '../src/invoice/types';

type Zip = { file(name: string, data: string): void; generateAsync(o: { type: 'uint8array' }): Promise<Uint8Array> };

/** Elle yazılmış tek sayfalık XLSX (exceljs'in yazmadığı hücre türleri için). `formats`: numFmtId 164'ten başlar. */
async function rawXlsx(sheetData: string, opts: { merges?: string[]; formats?: string[] } = {}): Promise<Uint8Array> {
  const JSZip = ((await import('jszip')) as unknown as { default: new () => Zip }).default;
  const z = new JSZip();
  const formats = opts.formats ?? [];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  z.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  );
  z.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  z.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sayfa1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  z.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  const numFmts = formats.length ? `<numFmts count="${formats.length}">${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : '';
  // s="0" biçimsiz, s="1" yerleşik yüzde (10 = 0.00%), s="2"... `formats` sırasıyla
  const xfs = ['<xf numFmtId="0"/>', '<xf numFmtId="10" applyNumberFormat="1"/>', ...formats.map((_, i) => `<xf numFmtId="${164 + i}" applyNumberFormat="1"/>`)];
  z.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`,
  );
  const merges = opts.merges?.length ? `<mergeCells count="${opts.merges.length}">${opts.merges.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>` : '';
  z.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData>${merges}</worksheet>`);
  return z.generateAsync({ type: 'uint8array' });
}

const str = (r: string, s: string) => `<c r="${r}" t="inlineStr"><is><t>${s}</t></is></c>`;

const base: ColumnMapping = {
  trackingNo: 'Takip No',
  netAmount: 'Tutar',
  actualKg: 'Kg',
  fuelAmount: 'Yakıt',
  surchargeColumns: [],
  chargePairs: [],
  amountsIncludeVat: false,
  vatPct: 20,
  desiAsWeight: false,
};

describe('01-B4: başka yazıcıların XLSX hücreleri', () => {
  const head = `<row r="1">${str('A1', 'Takip No')}${str('B1', 'Tutar')}${str('C1', 'Kg')}${str('D1', 'Yakıt')}</row>`;
  const body = [
    // t yok (LibreOffice/Google Sheets sayı hücresi), bilimsel gösterim; t="str" formül metni
    `<row r="2">${str('A2', '794800000011')}<c r="B2"><v>1.63915E+3</v></c><c r="C2"><v>4.53E-1</v></c><c r="D2" t="str"><f>TEXT(1.5,"0.00")</f><v>2.500</v></c></row>`,
    // t="n" açık, takip no sayı; formül sonucu sayı; formülsüz t="str"
    `<row r="3"><c r="A3" t="n"><v>794800000012</v></c><c r="B3" t="n"><v>12.5</v></c><c r="C3" t="n"><f>C2*2</f><v>0.906</v></c><c r="D3" t="str"><v>1,250</v></c></row>`,
    // paylaşılan formül (yalnız ilk hücrede metni var), hatalı hücre
    `<row r="4">${str('A4', '794800000013')}<c r="B4"><f t="shared" ref="B4:B5" si="0">C4*1000</f><v>453</v></c><c r="C4"><v>0.453</v></c><c r="D4" t="e"><v>#N/A</v></c></row>`,
    `<row r="5">${str('A5', '794800000014')}<c r="B5"><f t="shared" si="0"/><v>1234</v></c><c r="C5" t="n"><v>1.234</v></c><c r="D5" t="b"><v>1</v></c></row>`,
  ];

  it('işaret: t yok / t="n" / formül sonucu / paylaşılan formül sayı; inlineStr, t="str", hata ve boolean sayı değil', async () => {
    const t = await readTable('lo.xlsx', await rawXlsx(head + body.join('')));
    expect(t.rows).toEqual([
      ['794800000011', '1639,15', '0,453', '2.500'],
      ['794800000012', '12,5', '0,906', '1,250'],
      ['794800000013', '453', '0,453', ''],
      ['794800000014', '1234', '1,234', 'TRUE'],
    ]);
    expect(t.rows.map((_, r) => t.headers.map((__, c) => isNumericCell(t, r, c)))).toEqual([
      [false, true, true, false],
      [true, true, true, false],
      [false, true, true, false],
      [false, true, true, false],
    ]);
  });

  it("`numberFormat: 'en'`: sayı hücreleri biçimsiz, metin hücreleri İngilizce okunur", async () => {
    const t = await readTable('lo.xlsx', await rawXlsx(head + body.join('')));
    const r = parseRows(t, { ...base, numberFormat: 'en' });
    expect(r.lines.map((l) => [l.trackingNo, l.netAmount, l.actualKg, l.fuelAmount ?? null])).toEqual([
      ['794800000011', 1639.15, 0.453, 2.5],
      ['794800000012', 12.5, 0.906, 1250],
      ['794800000013', 453, 0.453, null],
      ['794800000014', 1234, 1.234, null],
    ]);
  });

  it('birleşik (dikey) sayı hücresi her satırda sayı olarak işaretli', async () => {
    const h = `<row r="1">${str('A1', 'Takip No')}${str('B1', 'Tutar')}${str('C1', 'Fatura Toplamı')}</row>`;
    const rows = [2, 3, 4].map((i) => `<row r="${i}">${str(`A${i}`, `79480000001${i}`)}<c r="B${i}"><v>0.453</v></c>${i === 2 ? '<c r="C2"><v>1.359</v></c>' : `<c r="C${i}"/>`}</row>`);
    const t = await readTable('m.xlsx', await rawXlsx(h + rows.join(''), { merges: ['C2:C4'] }));
    expect(t.rows.map((r) => r[2])).toEqual(['1,359', '1,359', '1,359']);
    expect(t.rows.map((_, r) => isNumericCell(t, r, 2))).toEqual([true, true, true]);
  });
});

describe('yüzde biçimi işareti (tarife indirimi, 01-B12)', () => {
  it('isPercentFormat: yalnız değeri yüze katlayan "%"', () => {
    for (const f of ['0%', '0.00%', '#,##0.0 %', '[Red]0%', '0%;-0%;"-"', '%0']) expect(isPercentFormat(f), f).toBe(true);
    for (const f of ['"%"0', '0" %"', '"%"#,##0.00', '0\\%', '0_%', '0*%', '[$%-41F]0.00', 'General', '0.00', '', undefined, null, 5])
      expect(isPercentFormat(f), String(f)).toBe(false);
  });

  it('readXlsxSheets: tırnak içindeki "%" yüzde sayılmaz (0,5 değeri %50 okunmasın)', async () => {
    const h = `<row r="1">${str('A1', 'Bölge')}${str('B1', 'İndirim')}</row>`;
    const rows =
      `<row r="2">${str('A2', '1')}<c r="B2" s="1"><v>0.05</v></c></row>` +
      `<row r="3">${str('A3', '2')}<c r="B3" s="2"><v>0.5</v></c></row>` +
      `<row r="4">${str('A4', '3')}<c r="B4" s="3"><v>5</v></c></row>`;
    const [s] = await readXlsxSheets(await rawXlsx(h + rows, { formats: ['0.0" %"', '"%"0'] }));
    expect(s!.numeric.slice(1).map((r) => r[1])).toEqual([true, true, true]);
    expect(s!.percent.slice(1).map((r) => r[1])).toEqual([true, false, false]);
  });
});
