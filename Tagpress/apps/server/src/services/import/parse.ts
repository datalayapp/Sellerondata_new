import type { FieldMap, ImportField } from "@tagpress/domain";
import { fail } from "../../util/errors.ts";
import { normalizeKey } from "../../util/text.ts";

export type ImportFormat = "array" | "wrapped" | "ndjson" | "object";
export type RawRecord = Record<string, unknown>;

/**
 * Dosyayı kayıtlara ayırır. Kabul edilen biçimler: JSON dizi, dizi içeren sarmalayıcı nesne
 * ({ "orders": [...] }), satır satır JSON (NDJSON) ve tek nesne.
 */
export function parseRecords(content: string): { records: RawRecord[]; format: ImportFormat } {
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw fail("import-empty");
  let data: unknown;
  let format: ImportFormat;
  try {
    data = JSON.parse(trimmed);
    format = Array.isArray(data) ? "array" : "object";
  } catch (first) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    try {
      data = lines.map((l) => JSON.parse(l));
      format = "ndjson";
    } catch {
      throw fail("import-json-invalid", { detail: first instanceof Error ? first.message : String(first) });
    }
  }
  if (format === "object" && data && typeof data === "object") {
    const arrays = Object.values(data).filter((v): v is unknown[] => Array.isArray(v) && v.some(isRecord));
    if (arrays.length === 1) {
      data = arrays[0];
      format = "wrapped";
    } else if (arrays.length > 1) {
      // Birden çok liste varsa en uzunu iş listesidir.
      data = arrays.sort((a, b) => b.length - a.length)[0];
      format = "wrapped";
    } else data = [data];
  }
  if (!Array.isArray(data)) throw fail("import-no-list");
  const records = data.filter(isRecord);
  if (!records.length) throw fail("import-no-records");
  return { records, format };
}

const isRecord = (x: unknown): x is RawRecord => !!x && typeof x === "object" && !Array.isArray(x);

export function collectFields(records: RawRecord[]): string[] {
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** Eş anlamlı alan adları (normalize: küçük harf, aksansız, yalnızca harf/rakam). Sıra önceliktir. */
const SYNONYMS: Record<ImportField, string[]> = {
  text: ["text", "metin", "yazi", "etiketmetni", "etiketyazisi", "message", "mesaj", "content", "customtext", "personalization", "kisisellestirme", "note", "not"],
  template: ["etiketno", "etiket", "sablon", "sablonno", "sablonkodu", "template", "templateid", "templateno", "design", "designno", "label", "labelno", "model"],
  orderNo: ["siparisno", "siparis", "siparisnumarasi", "siparisid", "order", "orderno", "orderid", "ordernumber"],
  quantity: ["adet", "miktar", "qty", "quantity", "count", "amount", "pieces", "sayi"],
  product: ["urun", "urunadi", "urunismi", "product", "productname", "producttitle", "item", "itemname", "itemtitle"],
  size: ["boyut", "olcu", "ebat", "cap", "size", "labelsize", "etiketboyutu", "dimension"],
};

export type MappingSource = Record<ImportField, "name" | "content" | "user" | null>;

/** Alan adlarından (gerekirse içerikten) eşleme tahmini. Kullanıcının seçtikleri tahmini ezer. */
export function detectFieldMap(records: RawRecord[], preferred: Partial<FieldMap> = {}): { mapping: FieldMap; source: MappingSource } {
  const fields = collectFields(records);
  const byNorm = new Map<string, string>();
  for (const f of fields) if (!byNorm.has(normalizeKey(f))) byNorm.set(normalizeKey(f), f);
  const used = new Set<string>();
  const mapping: FieldMap = { text: null, template: null, orderNo: null, quantity: null, product: null, size: null };
  const source: MappingSource = { text: null, template: null, orderNo: null, quantity: null, product: null, size: null };
  const roles = Object.keys(SYNONYMS) as ImportField[];

  for (const role of roles) {
    const pref = preferred[role];
    if (pref !== undefined) {
      mapping[role] = pref && fields.includes(pref) ? pref : null;
      source[role] = "user";
      if (mapping[role]) used.add(mapping[role]);
    }
  }
  // Önce tam eşleşme, sonra içerme (en az 4 harfli eş anlamlı).
  for (const pass of ["exact", "contains"] as const) {
    for (const role of roles) {
      if (source[role]) continue;
      for (const syn of SYNONYMS[role]) {
        const hit = pass === "exact" ? byNorm.get(syn) : fields.find((f) => syn.length >= 4 && normalizeKey(f).includes(syn) && !used.has(f));
        if (hit && !used.has(hit)) {
          mapping[role] = hit;
          source[role] = "name";
          used.add(hit);
          break;
        }
      }
    }
  }
  if (!source.text) {
    // İçerikten: ortalama en uzun metin değeri olan alan.
    let best: string | null = null;
    let bestLen = 0;
    for (const f of fields) {
      if (used.has(f)) continue;
      const avg = records.reduce((n, r) => n + (typeof r[f] === "string" ? (r[f] as string).length : 0), 0) / records.length;
      if (avg > bestLen) {
        bestLen = avg;
        best = f;
      }
    }
    if (best && bestLen > 0) {
      mapping.text = best;
      source.text = "content";
    }
  }
  return { mapping, source };
}

/** Kayıttan alan değeri (metin). Boş/yoksa null. */
export function fieldValue(raw: RawRecord, field: string | null): string | null {
  if (!field) return null;
  const v = raw[field];
  if (v === null || v === undefined) return null;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.trim() === "" ? null : s;
}
