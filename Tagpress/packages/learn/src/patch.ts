import { type Profile, ProfileSchema, type Template, TemplateSchema } from "@tagpress/domain";

/**
 * Öneri yaması. Arayüz `[{ path, from, to }]` biçimini okur (profil alanları); şablon değişiklikleri aynı listede
 * `target: "template"` ile durur ve `path` "template:<anahtar>.<alan>" biçimindedir (arayüzün profil okuyucusu bunları
 * profil alanı saymaz).
 */
export type PatchChange =
  | { target: "profile"; path: string; from: unknown; to: unknown }
  | { target: "template"; key: string; field: TemplateField; path: string; from: unknown; to: unknown };

export type TemplateField = "textCenter" | "ribbonTop" | "area";

export const templatePath = (key: string, field: TemplateField) => `template:${key}.${field}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Yol üzerindeki değeri değiştirilmiş KOPYA döner (ara nesneler kopyalanır). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const root: Record<string, unknown> = isObj(obj) ? { ...obj } : {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      const next = isObj(cur[k]) ? { ...(cur[k] as Record<string, unknown>) } : {};
      cur[k] = next;
      cur = next;
    }
  });
  return root as T;
}

/** Profil değişikliklerini uygular ve şemayla doğrular (geçersizse hata). */
export function applyProfileChanges(profile: Profile, changes: readonly PatchChange[]): Profile {
  let out: Profile = profile;
  for (const c of changes) if (c.target === "profile") out = setPath(out, c.path, c.to);
  return ProfileSchema.parse(out);
}

/** Şablon değişikliklerini uygular (anahtar → yeni kayıt). Dokunulmayan şablonlar aynı nesne kalır. */
export function applyTemplateChanges(templates: ReadonlyMap<string, Template>, changes: readonly PatchChange[]): Map<string, Template> {
  const out = new Map(templates);
  for (const c of changes) {
    if (c.target !== "template") continue;
    const t = out.get(c.key);
    if (!t) continue;
    out.set(c.key, TemplateSchema.parse({ ...t, [c.field]: c.to }));
  }
  return out;
}

/** Değişikliğin geometriyi etkileyip etkilemediği (geometri önbelleği için). */
export const touchesGeometry = (c: PatchChange) =>
  c.target === "template" || c.path.startsWith("output.") || c.path === "sizing.breathing" || c.path === "sizing.edgeMargin";
