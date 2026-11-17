import {
  MAPPING_FIELDS as CORE_MAPPING_FIELDS,
  REQUIRED_MAPPING_FIELDS,
  type MappingField,
} from '@deciship/core';
import type { CarrierCode, Decision, DiffType, DimMethod, LineStatus, PhotoKind, SurchargeKind } from '../api/types';
import { i18n } from '../i18n';

/**
 * Etiket tabloları dile bağlı sabit tutulmaz: her anahtar okunduğunda `common` ad alanından çözülür
 * (`STATUS_LABEL[x]` kullanımı değişmez, dil değişince doğru metin gelir).
 */
function lazyLabels<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { enumerable: true, get: () => i18n.t(`${prefix}.${k}`) });
  return o;
}

export type Tone = 'green' | 'red' | 'gray' | 'yellow' | 'blue' | 'purple' | 'teal' | 'outline';

export const STATUS_LABEL = lazyLabels<LineStatus>('status', ['MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF']);
export const STATUS_TONE: Record<LineStatus, Tone> = {
  MATCH: 'green',
  DIFF: 'red',
  UNMATCHED: 'gray',
  NO_TARIFF: 'yellow',
};

export const DIFF_LABEL = lazyLabels<DiffType>('diff', ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE']);

export const DECISION_LABEL = lazyLabels<Decision>('decision', ['OPEN', 'VERIFIED', 'ACCEPTED']);
export const DECISION_TONE: Record<Decision, Tone> = {
  OPEN: 'gray',
  VERIFIED: 'blue',
  ACCEPTED: 'outline',
};

export const DIM_METHOD_LABEL = lazyLabels<DimMethod>('dimMethod', ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET']);

export const PHOTO_KIND_LABEL = lazyLabels<PhotoKind>('photoKind', ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER']);


export const SURCHARGE_KIND_LABEL = lazyLabels<SurchargeKind>('surchargeKind', ['FIXED', 'PCT', 'PER_KG']);

export const CARRIER_OPTIONS: { code: CarrierCode; name: string }[] = [
  { code: 'fedex', name: 'FedEx' },
  { code: 'ups', name: 'UPS' },
  { code: 'dhl', name: 'DHL' },
  { code: 'aras', name: 'Aras Kargo' },
  { code: 'yurtici', name: 'Yurtiçi Kargo' }, // i18n-ok: taşıyıcı marka adı
  { code: 'mng', name: 'MNG Kargo' },
  { code: 'ptt', name: 'PTT Kargo' },
  { code: 'generic', get name() { return i18n.t('carrier.generic'); } },
];

/** Invoice template name under a carrier, only when it adds information ("Aras Kargo / Aras Kargo" is noise). */
export function carrierKind(c: { name: string; code: string }): string | null {
  const t = CARRIER_OPTIONS.find((o) => o.code === c.code)?.name ?? c.code;
  return c.name.toLocaleLowerCase('tr-TR').includes(t.toLocaleLowerCase('tr-TR')) ? null : t;
}

export type { MappingField };

const MAPPING_HINT_KEYS: MappingField[] = ['netAmount'];
export const MAPPING_FIELDS: { key: MappingField; label: string; required?: boolean; hint?: string }[] = CORE_MAPPING_FIELDS.map((key) => ({
  key,
  get label() {
    return i18n.t(`mapping.${key}`);
  },
  required: REQUIRED_MAPPING_FIELDS.includes(key),
  get hint() {
    return MAPPING_HINT_KEYS.includes(key) ? i18n.t(`mappingHint.${key}`) : undefined;
  },
}));

export const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'];
