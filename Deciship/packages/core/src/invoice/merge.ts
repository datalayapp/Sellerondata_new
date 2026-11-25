import { normalizeHeader } from './normalize';
import { classifyCharge } from './charges';
import { MAPPING_FIELDS, META_FIELDS, REQUIRED_MAPPING_FIELDS, type MappingField, type ChargeLabelOverride, type ColumnMapping, type HeaderField, type Table } from './types';
import { verifyMapping, type MappingVerification, type VerifyOptions } from './verify';

/** Her alanın eşlemesinin nereden geldiği (SPEC §11.3). */
export type FieldSource = 'preset' | 'saved' | 'ai' | 'user';
export type FieldSources = Partial<Record<HeaderField, FieldSource>>;

export const HEADER_FIELDS: HeaderField[] = [...MAPPING_FIELDS, ...META_FIELDS];

/** Eşlemedeki dolu her başlık alanına aynı kaynağı yazar. */
export function sourcesFor(m: ColumnMapping, source: FieldSource): FieldSources {
  const out: FieldSources = {};
  for (const f of HEADER_FIELDS) if (m[f]) out[f] = source;
  return out;
}

export type AiMappingInput = {
  mapping: ColumnMapping;
  /** Alan başına yapay zekâ güveni (0..1). */
  confidence: Partial<Record<HeaderField, number>>;
};

export type MergeDecision = 'agree' | 'kept' | 'ai' | 'reverted';

/**
 * Deterministik (kalıp/kayıtlı/kullanıcı) eşleme ile yapay zekâ eşlemesini birleştirir.
 * Kural, alan başına:
 * - aynı sütun → olduğu gibi kalır (kaynak değişmez);
 * - deterministik seçim doğrulamadan geçtiyse (`ok`) ve yapay zekâ farklı bir sütunu kendi doğrulama güveninden
 *   düşük güvenle öneriyorsa (ya da hiç önermiyorsa) → deterministik kalır;
 * - aksi hâlde yapay zekânın seçimi alınır (kaynak `ai`);
 * - yapay zekâ `ok` bir deterministik seçimi değiştirdi ama yeni seçim doğrulamada `ok` değilse geri alınır.
 */
export function mergeAiMapping(
  t: Table,
  base: ColumnMapping,
  baseSources: FieldSources,
  ai: AiMappingInput,
  opts: VerifyOptions = {},
): { mapping: ColumnMapping; sources: FieldSources; decisions: Partial<Record<HeaderField, MergeDecision>>; verification: MappingVerification } {
  const vopts = { divisor: opts.divisor };
  const baseV = verifyMapping(t, base, vopts);
  const out: ColumnMapping = { ...base, surchargeColumns: [...(base.surchargeColumns ?? [])] };
  const sources: FieldSources = { ...baseSources };
  const decisions: Partial<Record<HeaderField, MergeDecision>> = {};

  // Ücret çiftleri: deterministik çift yoksa ya da kalemler net tutarı tutmuyorsa yapay zekânınkiler.
  const aiPairs = ai.mapping.chargePairs ?? [];
  const basePairs = base.chargePairs ?? [];
  const chargesBad = baseV.checks.charges.rowsChecked > 0 && baseV.checks.charges.rowsMatching < baseV.checks.charges.rowsChecked;
  const pairsFromAi = aiPairs.length > 0 && (basePairs.length === 0 || chargesBad);
  out.chargePairs = pairsFromAi ? aiPairs : basePairs;
  const pairHeaders = new Set(out.chargePairs.flatMap((p) => [p.label, p.amount]));

  for (const f of HEADER_FIELDS) {
    const d = base[f];
    const a = ai.mapping[f];
    const ac = ai.confidence[f] ?? 0;
    const dv = baseV.fields[f];
    if (d && a === d) {
      decisions[f] = 'agree';
      continue;
    }
    if (d && dv?.status === 'ok' && (!a || ac <= dv.confidence)) {
      decisions[f] = 'kept';
      continue;
    }
    if (a && !pairHeaders.has(a)) {
      out[f] = a;
      sources[f] = 'ai';
      decisions[f] = 'ai';
    } else if (d) decisions[f] = 'kept';
  }

  // Aynı sütun iki satır alanına verilmesin: deterministik/korunan seçim kazanır, yapay zekânınki geri alınır.
  const used = new Map<string, HeaderField>();
  for (const f of MAPPING_FIELDS) {
    const h = out[f];
    if (!h) continue;
    const prev = used.get(h);
    if (prev && sources[f] === 'ai') revert(f);
    else if (prev && sources[prev] === 'ai') {
      revert(prev);
      used.set(h, f);
    } else used.set(h, f);
  }
  for (const f of MAPPING_FIELDS) if (out[f] && pairHeaders.has(out[f]!)) revert(f);

  function revert(f: HeaderField) {
    if (base[f] && !pairHeaders.has(base[f]!)) {
      out[f] = base[f];
      sources[f] = baseSources[f];
    } else {
      delete out[f];
      delete sources[f];
    }
    decisions[f] = 'reverted';
  }

  // Ek ücret sütunları: deterministikler + kullanılmayan yapay zekâ sütunları.
  const taken = new Set<string>([...pairHeaders, ...HEADER_FIELDS.map((f) => out[f]).filter((h): h is string => !!h)]);
  for (const s of out.surchargeColumns) taken.add(s.header);
  for (const s of ai.mapping.surchargeColumns ?? []) {
    if (!taken.has(s.header)) {
      out.surchargeColumns.push(s);
      taken.add(s.header);
    }
  }
  out.surchargeColumns = out.surchargeColumns.filter((s) => !HEADER_FIELDS.some((f) => out[f] === s.header) && !pairHeaders.has(s.header));

  // Etiket sınıfları: yalnız yerleşik sınıflandırmadan farklı olanlar geçersiz kılma olarak eklenir.
  const overrides: ChargeLabelOverride[] = [...(base.chargeLabelOverrides ?? [])];
  const known = new Set(overrides.map((o) => normalizeHeader(o.label)));
  for (const o of ai.mapping.chargeLabelOverrides ?? []) {
    const k = normalizeHeader(o.label);
    if (!k || known.has(k)) continue;
    // Yerleşik sınıf aynıysa kod da yerleşikte kalır (tarife ek ücret kodlarıyla eşleşme bozulmasın, ör. PEAK);
    // yalnız tür farklıysa ya da yerleşik sınıflandırma kodu bilmiyorsa (DIGER) yapay zekâ kullanılır.
    const builtin = classifyCharge(o.label, undefined, base.chargeLabelOverrides);
    if (builtin.kind === o.kind && (o.kind !== 'surcharge' || builtin.code !== 'DIGER')) continue;
    overrides.push(o);
    known.add(k);
  }
  if (overrides.length) out.chargeLabelOverrides = overrides;

  out.defaultDimUnit = base.defaultDimUnit ?? ai.mapping.defaultDimUnit;
  out.defaultWeightUnit = base.defaultWeightUnit ?? ai.mapping.defaultWeightUnit;
  if (!out.defaultDimUnit) delete out.defaultDimUnit;
  if (!out.defaultWeightUnit) delete out.defaultWeightUnit;
  if (!(base.numberFormat === 'tr' || base.numberFormat === 'en') && ai.mapping.numberFormat && ai.mapping.numberFormat !== 'auto') out.numberFormat = ai.mapping.numberFormat;
  if (!(base.dateOrder === 'dmy' || base.dateOrder === 'mdy') && ai.mapping.dateOrder && ai.mapping.dateOrder !== 'auto') out.dateOrder = ai.mapping.dateOrder;
  if (sources.netAmount === 'ai') {
    out.amountsIncludeVat = ai.mapping.amountsIncludeVat;
    if (ai.mapping.amountsIncludeVat) out.vatPct = ai.mapping.vatPct || base.vatPct;
  }
  if (sources.billedKg === 'ai') out.desiAsWeight = ai.mapping.desiAsWeight;

  // Güvenlik: doğrulamadan geçmeyen yapay zekâ seçimi geri alınır. Yalnız zorunlu bir alan deterministik
  // tarafta hiç yoksa yapay zekânın (kontrol edilecek) seçimi kalır; boş zorunlu alandan iyidir.
  let v = verifyMapping(t, out, vopts);
  let changed = false;
  for (const f of HEADER_FIELDS) {
    if (decisions[f] !== 'ai' || v.fields[f]?.status === 'ok') continue;
    if (!base[f] && REQUIRED_MAPPING_FIELDS.includes(f as MappingField)) continue;
    revert(f);
    changed = true;
  }
  if (changed) v = verifyMapping(t, out, vopts);
  return { mapping: out, sources, decisions, verification: v };
}
