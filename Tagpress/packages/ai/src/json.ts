import { z } from "zod";

/**
 * Model çıktısından JSON ve zod → API JSON şeması dönüşümü.
 *
 * Ders: SDK'nın `parse` yardımcısı şemaya uymayan yanıtta istisna fırlatıp ham metni kaybediyordu. Burada ham
 * metin HER ZAMAN saklanır ve doğrulamayı biz yaparız.
 */

/** Yanıttan JSON değeri çıkarır (kod bloğu ya da önünde/arkasında metin olsa da). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Yanıt boş.");
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[{[]/);
    const close = candidate[start] === "[" ? "]" : "}";
    const end = candidate.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* aşağıda */
      }
    }
    throw new Error("Yanıtta geçerli JSON bulunamadı.");
  }
}

/** zod hatalarını kısa, yola göre satırlara çevirir (onarım isteminde ve günlükte). */
export function formatZodIssues(error: z.ZodError, max = 10): string[] {
  return error.issues.slice(0, max).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Yapılandırılmış çıktının desteklemediği anahtarlar (sayı/uzunluk/dizi sınırları). İstemci tarafında zod denetler. */
const UNSUPPORTED = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
  "format",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitize(pv)])) : sanitize(v);
  }
  if (out.type === "object" || out.properties) {
    out.type = "object";
    out.additionalProperties = false;
    if (!out.properties) out.properties = {};
  }
  return out;
}

/**
 * zod şemasından Anthropic yapılandırılmış çıktı (output_config.format) için JSON şeması. Desteklenmeyen
 * sınırlar atılır (zod yine denetler), bütün nesnelere `additionalProperties: false` eklenir.
 * Tel şemaları isteğe bağlı alan yerine `nullable` kullanır; böylece model her alanı yazar.
 */
export function toApiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return sanitize(raw) as Record<string, unknown>;
}
