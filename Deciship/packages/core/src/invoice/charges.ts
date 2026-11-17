import { t } from '../i18n/index';
import { canonicalSurchargeCode, normalizeSurchargeCode } from '../surcharges';
import { normalizeHeader } from './normalize';
import { CHARGE_LABELS, CHARGE_PAIR_HEADERS } from './presets';
import type { ChargeKind, ChargeLabelOverride, ChargePair } from './types';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length).map(esc).join('|');

const LABEL_HEADER = new RegExp(`\\b(${alt(CHARGE_PAIR_HEADERS.label)})( \\d+)?$`);
const AMOUNT_HEADER = new RegExp(`\\b(${alt(CHARGE_PAIR_HEADERS.amount)})( \\d+)?$`);
const FUEL = new RegExp(`\\b(${alt(CHARGE_LABELS.fuel)})\\b`);
const DISCOUNT = new RegExp(`\\b(${alt(CHARGE_LABELS.discount)})\\b`);
const BASE = new RegExp(`^(${alt(CHARGE_LABELS.base)})\\b`);

/** Başlıklar arasında yan yana duran etiket/tutar sütun çiftlerini bulur (sıra korunur). */
export function detectChargePairs(headers: string[]): ChargePair[] {
  const pairs: ChargePair[] = [];
  const nh = headers.map(normalizeHeader);
  for (let i = 0; i < headers.length - 1; i++) {
    if (LABEL_HEADER.test(nh[i]!) && AMOUNT_HEADER.test(nh[i + 1]!)) {
      pairs.push({ label: headers[i]!, amount: headers[i + 1]! });
      i++;
    }
  }
  return pairs;
}

export type ChargeClass = { kind: ChargeKind; code?: string; name?: string };

function surchargeCode(raw: string): string {
  const stripped = raw.replace(/\([^)]*\)/g, ' ').trim() || raw;
  return canonicalSurchargeCode(stripped) || normalizeSurchargeCode(raw) || 'DIGER';
}

/**
 * Ücret etiketini sınıflar: navlun (base), indirim, yakıt ya da ek ücret.
 * Önce `overrides` (etiket normalleştirilerek tam eşleşme), sonra presets.ts'teki CHARGE_LABELS sözlüğü.
 * Ek ücretlerde kod bilinen gruptan gelir ("Demand Surcharge" → PEAK); bilinmiyorsa etiketin
 * normalleştirilmiş hâli kullanılır ("EPH ÜCRETİ (%2,35)" → EPH_UCRETI, parantez içi atılır).
 * Bilinmeyen negatif tutarlar indirim sayılır.
 */
export function classifyCharge(label: string, amount?: number, overrides?: ChargeLabelOverride[]): ChargeClass {
  const raw = String(label ?? '').trim();
  const n = normalizeHeader(raw);
  const o = n ? overrides?.find((x) => normalizeHeader(x.label) === n) : undefined;
  if (o) {
    if (o.kind !== 'surcharge') return { kind: o.kind };
    return { kind: 'surcharge', code: o.code ? normalizeSurchargeCode(o.code) : surchargeCode(raw), name: raw };
  }
  if (n && FUEL.test(n)) return { kind: 'fuel' };
  if (n && DISCOUNT.test(n)) return { kind: 'discount' };
  if (n && BASE.test(n)) return { kind: 'base' };
  if (amount != null && amount < 0) return { kind: 'discount' };
  if (!n) return { kind: 'surcharge', code: 'DIGER', name: t('tr', 'parse.unlabeledCharge') };
  return { kind: 'surcharge', code: surchargeCode(raw), name: raw };
}
