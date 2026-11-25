import type { MeasurementInput, ParsedInvoiceLine, TariffInput, Tolerances } from '../src/index';

export const TOL: Tolerances = { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5 };

/** FedEx International Economy 2026 (wiki rakamları: A/6,0 kg = 1.527,75). */
export const FEDEX: TariffInput = {
  id: 'fedex-ie-2026',
  currency: 'TRY',
  divisor: 5000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [
    { upto: 20, step: 0.5 },
    { upto: null, step: 1 },
  ],
  discountPct: 38,
  fuelPct: 25,
  zones: { FR: 'A', DE: 'A', NL: 'A', GB: 'B', US: 'D', CA: 'D' },
  rates: [
    { zone: 'A', weightUpto: 0.5, price: 650 },
    { zone: 'A', weightUpto: 1, price: 724.53 },
    { zone: 'A', weightUpto: 3, price: 1022.65 },
    { zone: 'A', weightUpto: 4, price: 1171.71 },
    { zone: 'A', weightUpto: 4.5, price: 1246.24 },
    { zone: 'A', weightUpto: 5, price: 1320.77 },
    { zone: 'A', weightUpto: 5.5, price: 1445.16 },
    { zone: 'A', weightUpto: 6, price: 1527.75 },
    { zone: 'A', weightUpto: 9.5, price: 2119.35 },
    { zone: 'A', weightUpto: 15, price: 3632.26 },
    { zone: 'A', weightUpto: 20, price: 4500 },
    { zone: 'A', weightUpto: 30, price: 5800 },
    { zone: 'B', weightUpto: 5, price: 1500 },
    { zone: 'B', weightUpto: 10, price: 2400 },
  ],
  overflowPerUnit: { A: 150 },
  surcharges: [
    { code: 'REMOTE_AREA', name: 'Uzak bölge ek ücreti', kind: 'PER_KG', amount: 18.5 },
    { code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', kind: 'FIXED', amount: 285 },
    { code: 'INSURANCE', name: 'Sigorta', kind: 'PCT', amount: 1 },
  ],
};

/** Aras Desi 2026 (yurt içi, tek bölge '*'). */
export const ARAS: TariffInput = {
  id: 'aras-2026',
  currency: 'TRY',
  divisor: 3000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [{ upto: null, step: 1 }],
  discountPct: 10,
  fuelPct: 0,
  zones: { '*': '*' },
  rates: Array.from({ length: 30 }, (_, i) => ({ zone: '*', weightUpto: i + 1, price: 60 + i * 10 })),
  overflowPerUnit: { '*': 13.5 },
  surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme', kind: 'FIXED', amount: 14.5 }],
};

export function line(p: Partial<ParsedInvoiceLine> & { trackingNo: string; netAmount: number }): ParsedInvoiceLine {
  return { rowIndex: 0, surcharges: [], rawHash: 'x', destCountry: 'FR', currency: 'TRY', ...p };
}

export function meas(l: number, w: number, h: number, kg: number): MeasurementInput {
  return { id: 'm', dims: { l, w, h }, actualKg: kg, measuredAt: '2026-10-22T14:12:00+03:00' };
}
