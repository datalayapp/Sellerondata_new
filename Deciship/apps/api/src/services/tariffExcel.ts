import ExcelJS from 'exceljs';
import { countryAdjustmentLabel, zoneKey } from '@deciship/core';
import { currentLocale, m } from '../i18n/index.ts';

const OPEN_WEIGHT = 99999;
const fmtW = (w: number) => (currentLocale() === 'en' ? String(w) : String(w).replace('.', ','));

type TemplateSource = {
  name?: string;
  zones: { country: string; zone: string }[];
  rates: { zone: string; weightUpto: number; price: number; perKg?: boolean; packaging?: string }[];
  overflow: { zone: string; perUnit: number }[];
  surcharges: { code: string; name: string; kind: string; amount: number }[];
  weightSteps?: unknown;
  discountPct?: number;
  countryAdjustments?: { country: string; pct: number; note?: string | null }[];
};

/**
 * Aşım satırının etiketi birimiyle: tablonun üstünde tek basamak varsa "Aşım (kg başı)" / "Aşım (her ilave 0,5 kg)"
 * (geri okunurken basamak etiketten alınır); üstte birden çok basamak varsa birimsiz (mevcut basamaklar korunur).
 */
function overflowLabel(source: TemplateSource, maxWeight: number): string {
  const steps = Array.isArray(source.weightSteps) ? (source.weightSteps as { upto?: number | null; step?: number }[]) : [];
  const tail = steps.filter((s) => s && (s.upto == null || Number(s.upto) > maxWeight + 1e-9));
  const grams = [...new Set(tail.map((s) => Math.round(Number(s.step) * 1000)))];
  if (grams.length > 1 || grams.some((g) => !(g > 0))) return m('template.overflow');
  const step = grams.length ? grams[0]! / 1000 : 1;
  return step === 1 ? m('template.overflowPerKg') : m('template.overflowStep', { step: fmtW(step) });
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF161616' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildTariffTemplate(input?: TemplateSource): Promise<Buffer> {
  // Şablon koli (kendi ambalaj) tablosudur: Pak / Zarf satırları aynı bölge + ağırlıkta ikinci fiyat olur, tabloya yazılmaz
  // (içe aktarma dosyada olmayan ambalajın satırlarını korur: `importedRates`).
  const source = input ? { ...input, rates: input.rates.filter((r) => (r.packaging ?? 'OWN') === 'OWN') } : undefined;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DeciShip';
  // bölge sütunları: "A" ile "a" / "Zone A" aynı bölgedir (zoneKey) — tek sütun
  const zonesOrder: string[] = [];
  if (source) {
    const seen = new Set<string>();
    for (const z of [...source.rates.map((r) => r.zone), ...source.zones.map((x) => x.zone)]) {
      if (seen.has(zoneKey(z))) continue;
      seen.add(zoneKey(z));
      zonesOrder.push(z);
    }
  } else zonesOrder.push('A', 'B', 'C');
  const sameZone = (a: string, b: string) => zoneKey(a) === zoneKey(b);

  const prices = wb.addWorksheet(m('template.sheet.prices'));
  prices.addRow([m('template.weightHeader'), ...zonesOrder]);
  if (source && source.rates.length) {
    const flat = [...new Set(source.rates.filter((r) => !r.perKg).map((r) => r.weightUpto))].sort((a, b) => a - b);
    const perKg = [...new Set(source.rates.filter((r) => r.perKg).map((r) => r.weightUpto))].sort((a, b) => a - b);
    for (const w of flat) {
      prices.addRow([w, ...zonesOrder.map((z) => source.rates.find((r) => sameZone(r.zone, z) && r.weightUpto === w && !r.perKg)?.price ?? null)]);
    }
    let prev = flat[flat.length - 1] ?? 0;
    for (const w of perKg) {
      // "71-99 kg başı" / "1000+ kg başı": okuyucu bunu kg başı bant olarak geri okur
      const perKgLabel = m('template.perKg');
      const label = w >= OPEN_WEIGHT ? `${fmtW(prev)}+ ${perKgLabel}` : `${fmtW(prev)}-${fmtW(w)} ${perKgLabel}`;
      prices.addRow([label, ...zonesOrder.map((z) => source.rates.find((r) => sameZone(r.zone, z) && r.weightUpto === w && r.perKg)?.price ?? null)]);
      prev = w;
    }
    if (source.overflow.length) {
      prices.addRow([overflowLabel(source, flat[flat.length - 1] ?? 0), ...zonesOrder.map((z) => source.overflow.find((o) => sameZone(o.zone, z))?.perUnit ?? null)]);
    }
  } else {
    for (const w of [0.5, 1, 1.5, 2, 2.5, 3]) prices.addRow([w, null, null, null]);
  }
  // Tek oran: ilk satıra yazılır, içe aktarma tarifenin indirimi olarak okur. Sütun boşsa içe aktarma uyarır.
  // Excel yüzde hücresi (01-B12): değer oran (%0,5 → 0,005), okuyucu yüzde biçimini görüp 100 ile çarpar. Ham yazılan
  // 0,5 (eski şablon) %0,5 mi %50 mi belli olmazdı.
  const discountCol = zonesOrder.length + 2;
  prices.getCell(1, discountCol).value = m('template.discountHeader');
  if (source) {
    const cell = prices.getCell(2, discountCol);
    cell.value = Math.round((source.discountPct ?? 0) * 10000) / 1000000;
    cell.numFmt = '0.00%';
  }
  prices.getColumn(discountCol).width = 12;
  prices.getColumn(1).width = 24;
  for (let i = 2; i <= zonesOrder.length + 1; i++) {
    prices.getColumn(i).width = 14;
    prices.getColumn(i).numFmt = '#,##0.00';
  }
  styleHeader(prices);

  const zones = wb.addWorksheet(m('template.sheet.zones'));
  zones.addRow([m('template.zones.country'), m('template.zones.zone')]);
  for (const z of source?.zones ?? [
    { country: 'DE', zone: 'A' },
    { country: 'GB', zone: 'B' },
    { country: 'US', zone: 'C' },
  ]) {
    zones.addRow([z.country, z.zone]);
  }
  zones.getColumn(1).width = 14;
  zones.getColumn(2).width = 12;
  styleHeader(zones);

  const sur = wb.addWorksheet(m('template.sheet.surcharges'));
  sur.addRow([m('template.sur.code'), m('template.sur.name'), m('template.sur.kind'), m('template.sur.amount')]);
  for (const s of source?.surcharges ?? []) sur.addRow([s.code, s.name, s.kind, s.amount]);
  sur.getColumn(1).width = 24;
  sur.getColumn(2).width = 30;
  sur.getColumn(3).width = 10;
  sur.getColumn(4).width = 12;
  sur.getCell('F1').value = m('template.sur.kinds');
  styleHeader(sur);

  const info = wb.addWorksheet(m('template.sheet.info'));
  info.addRow([m('template.info.title')]);
  info.addRow([m('template.info.prices')]);
  info.addRow([m('template.info.discount')]);
  info.addRow([m('template.info.overflow')]);
  info.addRow([m('template.info.perKg')]);
  info.addRow([m('template.info.additional')]);
  info.addRow([m('template.info.zones')]);
  // Ülke istisnaları (SPEC §3.8) dosyadan okunmaz: içe aktarma mevcut istisnaları korur, değişiklik tarife ekranından.
  const adj = source?.countryAdjustments ?? [];
  if (adj.length) {
    info.addRow([]);
    info.addRow([m('template.info.adjustments')]);
    for (const a of adj) info.addRow([`${countryAdjustmentLabel(a, currentLocale())} (${a.country})${a.note ? ` — ${a.note}` : ''}`]);
  }
  info.getColumn(1).width = 110;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
